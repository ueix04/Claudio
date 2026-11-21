import { createRequire } from "node:module";
import { fetchSourceJson } from "./music-sources/http-client.js";
import "./runtime.js";

const require = createRequire(import.meta.url);
const { cloudsearch, song_detail, user_account, user_playlist, playlist_track_all } = require("NeteaseCloudMusicApi") as {
  cloudsearch: (params: { keywords: string; limit: number; cookie: string; proxy?: string }) => Promise<{
    status: number;
    body: unknown;
  }>;
  song_detail: (params: { ids: string; proxy?: string }) => Promise<{
    status: number;
    body: unknown;
  }>;
  user_account: (params: { cookie: string; proxy?: string }) => Promise<{
    status: number;
    body: unknown;
  }>;
  user_playlist: (params: { uid: string | number; limit?: number; offset?: number; cookie: string; proxy?: string }) => Promise<{
    status: number;
    body: unknown;
  }>;
  playlist_track_all: (params: { id: string | number; limit?: number | string; offset?: number | string; cookie: string; proxy?: string }) => Promise<{
    status: number;
    body: unknown;
  }>;
};
import { getNetworkErrorMessage, getNetworkProxyUrl, isLikelyNetworkError } from "./network.js";

export interface NeteaseTrack {
  id: number;
  name: string;
  artists: Array<{ name: string }>;
  album: { name: string; picUrl: string };
  duration: number;
}

export interface SearchResult {
  tracks: NeteaseTrack[];
  total: number;
}

let warnedAboutRawCookie = false;

export function normalizeNeteaseCookie(cookie: string): string {
  const trimmed = cookie.trim();
  if (!trimmed) return "";
  if (trimmed.includes("=")) return trimmed;

  if (!warnedAboutRawCookie) {
    warnedAboutRawCookie = true;
    console.warn("NETEASE_COOKIE looks like a raw MUSIC_U value, auto-prefixing MUSIC_U= for compatibility.");
  }
  return `MUSIC_U=${trimmed}`;
}

const getCookie = (): string => normalizeNeteaseCookie(process.env.NETEASE_COOKIE || "");

const NETEASE_DIRECT_RETRY_ATTEMPTS = 3;
const NETEASE_PROXY_RETRY_ATTEMPTS = 2;
async function withNeteaseDirectRetry<T>(
  label: string,
  operation: (proxy?: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  const proxyUrl = getNetworkProxyUrl();
  const totalAttempts = NETEASE_DIRECT_RETRY_ATTEMPTS + NETEASE_PROXY_RETRY_ATTEMPTS;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const useProxy = attempt > NETEASE_DIRECT_RETRY_ATTEMPTS;
    try {
      return await operation(useProxy ? proxyUrl : undefined);
    } catch (error) {
      lastError = error;
      if (!isLikelyNetworkError(error) || attempt === totalAttempts) {
        throw error;
      }

      console.warn(
        `${label} ${useProxy ? "proxy" : "direct"} request failed (${getNetworkErrorMessage(error)}), retry ${attempt + 1}/${totalAttempts}`,
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    }
  }

  throw lastError;
}

export async function searchSongs(
  keyword: string,
  limit: number = 10,
): Promise<SearchResult> {
  const cookie = getCookie();

  const res = await withNeteaseDirectRetry("Netease cloudsearch", (proxy) => cloudsearch({
    keywords: keyword,
    limit,
    cookie,
    proxy,
  }));

  if (res.status !== 200 || !res.body) {
    throw new Error(`网易云 API 错误: ${res.status}`);
  }

  const data = res.body as {
    result?: {
      songs?: Array<{
        id: number;
        name: string;
        ar?: Array<{ name: string }>;
        al?: { name: string; picUrl: string };
        dt?: number;
      }>;
      songCount?: number;
    };
  };

  const songs = data.result?.songs ?? [];
  const tracks: NeteaseTrack[] = songs.map((song) => ({
    id: song.id,
    name: song.name,
    artists: (song.ar ?? []).map((a) => ({ name: a.name })),
    album: {
      name: song.al?.name ?? "",
      picUrl: song.al?.picUrl ?? "",
    },
    duration: song.dt ?? 0,
  }));

  return {
    tracks,
    total: data.result?.songCount ?? tracks.length,
  };
}

interface NeteasePublicPlayback {
  url: string;
  expiresAt: number;
  refreshedAt: number;
}

export async function getOpenPlayableUrl(trackId: number): Promise<NeteasePublicPlayback | null> {
  if (!Number.isSafeInteger(trackId) || trackId <= 0) return null;

  const detailUrl = new URL("https://music.163.com/api/v3/song/detail");
  detailUrl.searchParams.set("c", JSON.stringify([{ id: trackId }]));
  const detail = await fetchSourceJson<{
    code: number;
    privileges?: Array<{ id: number; st: number; fee: number; pl: number }>;
  }>(detailUrl);
  const access = detail.privileges?.find((entry) => entry.id === trackId);
  if (detail.code !== 200 || !access || access.st !== 0 || ![0, 8].includes(access.fee)
    || !Number.isFinite(access.pl) || access.pl <= 0) {
    return null;
  }

  const refreshedAt = Date.now();
  const result = await fetchSourceJson<{
    code: number;
    data?: Array<{ id: number; code: number; url?: string; expi: number; fee: number; freeTrialInfo?: unknown }>;
  }>(new URL("https://music.163.com/api/song/enhance/player/url"), {
    method: "POST",
    body: new URLSearchParams({ ids: JSON.stringify([trackId]), br: String(Math.min(320_000, access.pl)) }),
  });
  const track = result.data?.find((entry) => entry.id === trackId);
  if (result.code !== 200 || track?.code !== 200 || typeof track.url !== "string" || !track.url
    || ![0, 8].includes(track.fee) || track.freeTrialInfo || !Number.isFinite(track.expi) || track.expi <= 0) {
    return null;
  }

  return { url: track.url, refreshedAt, expiresAt: refreshedAt + track.expi * 1000 };
}

export interface UserAccount {
  userId: number;
  nickname: string;
  avatarUrl: string;
}

export interface UserPlaylist {
  tracks: Array<{
    id: number;
    name: string;
    artist: string;
    album?: string;
    duration?: number;
  }>;
  id: number;
  name: string;
  trackCount: number;
  playCount: number;
  coverImgUrl: string;
  creator: { nickname: string; userId: number };
}

export async function getUserAccount(): Promise<UserAccount> {
  const cookie = getCookie();

  const res = await withNeteaseDirectRetry("Netease user_account", (proxy) => user_account({
    cookie,
    proxy,
  }));

  if (res.status !== 200 || !res.body) {
    throw new Error(`获取用户信息失败: ${res.status}`);
  }

  const data = res.body as {
    profile?: { userId: number; nickname: string; avatarUrl: string };
  };

  if (!data.profile) {
    throw new Error("获取用户信息失败: 未找到 profile，NETEASE_COOKIE 可能已失效，或不是有效的 MUSIC_U 登录凭证");
  }

  return {
    userId: data.profile.userId,
    nickname: data.profile.nickname,
    avatarUrl: data.profile.avatarUrl,
  };
}

export async function getUserPlaylists(uid: number): Promise<UserPlaylist[]> {
  const cookie = getCookie();

  const res = await withNeteaseDirectRetry("Netease user_playlist", (proxy) => user_playlist({
    uid,
    limit: 100,
    cookie,
    proxy,
  }));

  if (res.status !== 200 || !res.body) {
    throw new Error(`获取歌单失败: ${res.status}`);
  }

  const data = res.body as {
    playlist?: Array<{
      id: number;
      name: string;
      trackCount: number;
      playCount: number;
      coverImgUrl: string;
      creator: { nickname: string; userId: number };
    }>;
  };

  const playlists = data.playlist ?? [];

  return playlists.map((pl) => ({
    tracks: [],
    id: pl.id,
    name: pl.name,
    trackCount: pl.trackCount,
    playCount: pl.playCount,
    coverImgUrl: pl.coverImgUrl,
    creator: {
      nickname: pl.creator.nickname,
      userId: pl.creator.userId,
    },
  }));
}

export async function getPlaylistTracks(playlistId: number, trackCount?: number): Promise<UserPlaylist["tracks"]> {
  const cookie = getCookie();
  const pageSize = 1000;
  const expectedCount = Math.max(0, trackCount ?? 0);
  const maxPages = expectedCount > 0 ? Math.ceil(expectedCount / pageSize) : 1;
  const tracks: UserPlaylist["tracks"] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const limit = expectedCount > 0
      ? Math.min(pageSize, expectedCount - offset)
      : pageSize;
    if (limit <= 0) break;

    const res = await withNeteaseDirectRetry("Netease playlist_track_all", (proxy) => playlist_track_all({
      id: playlistId,
      limit,
      offset,
      cookie,
      proxy,
    }));

    if (res.status !== 200 || !res.body) {
      throw new Error(`获取歌单歌曲失败: ${res.status}`);
    }

    const data = res.body as {
      songs?: Array<{
        id: number;
        name: string;
        ar?: Array<{ name: string }>;
        al?: { name: string };
        dt?: number;
      }>;
    };
    const pageTracks = (data.songs ?? []).map((song) => ({
      id: song.id,
      name: song.name,
      artist: (song.ar ?? []).map((artist) => artist.name).join(", "),
      album: song.al?.name ?? "",
      duration: song.dt,
    }));
    tracks.push(...pageTracks);

    if (pageTracks.length < limit) {
      break;
    }
  }

  return tracks;
}

export async function getSongDurations(trackIds: number[]): Promise<Map<number, number>> {
  const ids = new Set(trackIds);
  const res = await withNeteaseDirectRetry("Netease song_detail", (proxy) => song_detail({
    ids: [...ids].join(","),
    proxy,
  }));

  if (res.status !== 200 || !res.body) {
    throw new Error(`网易云 API 错误: ${res.status}`);
  }

  const { songs = [] } = res.body as { songs?: Array<{ id: number; dt: number }> };
  return new Map(songs
    .filter(({ id, dt }) => ids.has(id) && Number.isFinite(dt) && dt > 0)
    .map(({ id, dt }) => [id, dt]));
}
