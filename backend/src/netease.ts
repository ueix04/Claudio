import { createRequire } from "node:module";
import "./runtime.js";

const require = createRequire(import.meta.url);
const { cloudsearch, song_url_v1, user_account, user_playlist, playlist_track_all } = require("NeteaseCloudMusicApi") as {
  cloudsearch: (params: { keywords: string; limit: number; cookie: string; proxy?: string }) => Promise<{
    status: number;
    body: unknown;
  }>;
  song_url_v1: (params: { id: string; level: string; cookie: string; proxy?: string }) => Promise<{
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

export interface PlayableTrack {
  id: number;
  name: string;
  artist: string;
  url: string;
  picUrl: string;
  duration: number;
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

function ensurePcOsCookie(cookie: string): string {
  if (!cookie || /(?:^|;)\s*os=/.test(cookie)) {
    return cookie;
  }
  return `${cookie}; os=pc`;
}

const getCookie = (): string => normalizeNeteaseCookie(process.env.NETEASE_COOKIE || "");

const NETEASE_DIRECT_RETRY_ATTEMPTS = 3;
const NETEASE_PROXY_RETRY_ATTEMPTS = 2;
const PLAYABLE_URL_CACHE_TTL_MS = 8 * 60 * 1000;

const playableUrlCache = new Map<number, { url: string; cachedAt: number }>();

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

export async function getPlayableUrl(
  trackId: number,
  options?: {
    forceRefresh?: boolean;
  },
): Promise<string> {
  const cached = playableUrlCache.get(trackId);
  if (!options?.forceRefresh && cached && Date.now() - cached.cachedAt < PLAYABLE_URL_CACHE_TTL_MS) {
    return cached.url;
  }

  const cookie = ensurePcOsCookie(getCookie());

  const res = await withNeteaseDirectRetry("Netease song_url_v1", (proxy) => song_url_v1({
    id: trackId.toString(),
    level: "standard",
    cookie,
    proxy,
  }));

  if (res.status !== 200 || !res.body) {
    throw new Error(`网易云 API 错误: ${res.status}`);
  }

  const body = res.body as { data?: Array<{ url?: string }> };
  const songData = body.data?.[0];
  if (!songData?.url) {
    throw new Error(`No playable URL found for track ${trackId}`);
  }
  playableUrlCache.set(trackId, {
    url: songData.url,
    cachedAt: Date.now(),
  });
  return songData.url;
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
      }>;
    };
    const pageTracks = (data.songs ?? []).map((song) => ({
      id: song.id,
      name: song.name,
      artist: (song.ar ?? []).map((artist) => artist.name).join(", "),
      album: song.al?.name ?? "",
    }));
    tracks.push(...pageTracks);

    if (pageTracks.length < limit) {
      break;
    }
  }

  return tracks;
}

export async function resolveTrack(
  title: string,
  artist?: string,
): Promise<PlayableTrack | null> {
  const query = artist ? `${title} ${artist}` : title;
  const result = await searchSongs(query, 5);

  if (result.tracks.length === 0) {
    return null;
  }

  const track = result.tracks[0];
  let url: string;
  try {
    url = await getPlayableUrl(track.id);
    if (!url) {
      return null;
    }
  } catch {
    return null;
  }

  const artistName = track.artists.map((a) => a.name).join(", ");

  return {
    id: track.id,
    name: track.name,
    artist: artistName,
    url,
    picUrl: track.album.picUrl,
    duration: track.duration,
  };
}
