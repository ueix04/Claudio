import { Innertube, Platform } from "youtubei.js";
import { fetchWithConfiguredProxy } from "../network.js";
import {
  MusicSourceAdapter,
  MusicSourceError,
  MusicSourceTrack,
  PlayableUrlResult,
  normalizeMusicSourceError,
} from "./types.js";

export const YOUTUBE_SOURCE_ID = "youtube" as const;

const YOUTUBE_URL_TTL_DEFAULT_MS = 30 * 60 * 1000;
const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_PLAYBACK_CLIENTS = ["MWEB", "TV", "WEB"] as const;
const YOUTUBE_AUDIO_PROXY_PREFIX = "/api/audio/youtube";

type YouTubeMusicSearchResult = Awaited<ReturnType<Innertube["music"]["search"]>>;
type YouTubeMusicSongItem = NonNullable<
  NonNullable<YouTubeMusicSearchResult["songs"]>["contents"]
>[number];
type YouTubeSearchResult = Awaited<ReturnType<Innertube["search"]>>;
type YouTubeVideoSearchItem = YouTubeSearchResult["videos"][number];
type YouTubeThumbnail = { url?: string };
type YouTubeTextValue = string | { toString(): string };
type YouTubeVideoLike = {
  video_id?: string;
  id?: string;
  title?: YouTubeTextValue;
  author?: { name?: string };
  byline_text?: YouTubeTextValue;
  thumbnails?: YouTubeThumbnail[];
  best_thumbnail?: YouTubeThumbnail;
  duration?: number | { seconds?: number; text?: string };
  length_text?: YouTubeTextValue;
  is_live?: boolean;
  is_upcoming?: boolean;
};

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export function isYouTubeEnabled(): boolean {
  return parseBooleanEnv(process.env.YOUTUBE_ENABLED, false);
}

function getUrlTtlMs(): number {
  const configured = Number(process.env.YOUTUBE_URL_TTL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : YOUTUBE_URL_TTL_DEFAULT_MS;
}

let tubePromise: Promise<Innertube> | null = null;
let testClient: Innertube | null = null;
let youtubeJsEvaluatorInstalled = false;
const youtubeStreamLeaseCache = new Map<string, YouTubeStreamLease>();

export interface YouTubeStreamLease {
  sourceTrackId: string;
  streamUrl: string;
  refreshedAt: number;
  expiresAt: number;
}

/**
 * Reset the cached Innertube instance. Used by tests and when
 * configuration changes at runtime (not currently exercised).
 */
function resetTubePromise(): void {
  tubePromise = null;
}

export function isValidYouTubeVideoId(sourceTrackId: string): boolean {
  return VIDEO_ID_PATTERN.test(sourceTrackId);
}

export function getYouTubeAudioProxyUrl(sourceTrackId: string): string {
  return `${YOUTUBE_AUDIO_PROXY_PREFIX}/${encodeURIComponent(sourceTrackId)}`;
}

export function clearYouTubeStreamLease(sourceTrackId?: string): void {
  if (sourceTrackId) {
    youtubeStreamLeaseCache.delete(sourceTrackId);
    return;
  }
  youtubeStreamLeaseCache.clear();
}

function requestToInit(request: Request, init?: RequestInit): RequestInit {
  return {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    ...init,
  };
}

async function fetchYouTubeWithProxyFallback(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const target = input instanceof Request ? input.url : input;
  const requestInit = input instanceof Request ? requestToInit(input, init) : (init ?? {});
  return fetchWithConfiguredProxy(target, requestInit, "YouTube");
}

function installYouTubeJsEvaluator(): void {
  if (youtubeJsEvaluatorInstalled) {
    return;
  }

  Platform.shim.eval = async (data: { output: string }) => {
    // Required by youtubei.js to decipher YouTube player signature/cipher URLs.
    return new Function(data.output)();
  };
  youtubeJsEvaluatorInstalled = true;
}

export function setYouTubeClientForTests(client: Innertube | null): void {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    return;
  }
  resetTubePromise();
  clearYouTubeStreamLease();
  testClient = client;
}

async function getYouTubeClient(): Promise<Innertube> {
  if (testClient) {
    return testClient;
  }
  if (!tubePromise) {
    const cookie = process.env.YOUTUBE_COOKIE?.trim() || undefined;
    const poToken = process.env.YOUTUBE_PO_TOKEN?.trim() || undefined;
    installYouTubeJsEvaluator();
    tubePromise = Innertube.create({
      fetch: fetchYouTubeWithProxyFallback,
      ...(cookie ? { cookie } : {}),
      ...(poToken ? { po_token: poToken } : {}),
    });
  }
  return tubePromise;
}

function pickLargestThumbnailUrl(thumbnails: YouTubeThumbnail[] | undefined): string | undefined {
  if (!thumbnails || thumbnails.length === 0) {
    return undefined;
  }
  return thumbnails[thumbnails.length - 1]?.url;
}

function textValueToString(value: YouTubeTextValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  const text = value.toString().trim();
  return text && text !== "[object Object]" ? text : undefined;
}

function parseDurationText(text: string | undefined): number | undefined {
  if (!text || !/^\d+(?::\d{1,2})+$/.test(text)) {
    return undefined;
  }

  const parts = text.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }

  return parts.reduce((total, part) => total * 60 + part, 0);
}

function songItemToSourceTrack(item: YouTubeMusicSongItem): MusicSourceTrack | null {
  if (!item || item.item_type !== "song" || !item.id || !item.title) {
    return null;
  }

  const artists = Array.isArray(item.artists)
    ? item.artists.map((artist) => artist?.name).filter(Boolean).join(", ")
    : "";

  return {
    source: YOUTUBE_SOURCE_ID,
    sourceTrackId: item.id,
    title: item.title,
    artist: artists,
    album: item.album?.name,
    picUrl: pickLargestThumbnailUrl(item.thumbnails as YouTubeThumbnail[] | undefined),
    duration: item.duration?.seconds,
  };
}

function videoItemToSourceTrack(item: YouTubeVideoSearchItem): MusicSourceTrack | null {
  const video = item as YouTubeVideoLike;
  const sourceTrackId = video.video_id ?? video.id;
  const title = textValueToString(video.title);
  if (!sourceTrackId || !VIDEO_ID_PATTERN.test(sourceTrackId) || !title) {
    return null;
  }
  if (video.is_live || video.is_upcoming) {
    return null;
  }

  const duration = typeof video.duration === "number"
    ? video.duration
    : video.duration?.seconds ?? parseDurationText(textValueToString(video.length_text));
  const thumbnail = pickLargestThumbnailUrl(video.thumbnails) ?? video.best_thumbnail?.url;

  return {
    source: YOUTUBE_SOURCE_ID,
    sourceTrackId,
    title,
    artist: video.author?.name ?? textValueToString(video.byline_text) ?? "",
    picUrl: thumbnail,
    duration,
  };
}

function isPlayableSign(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("sign in to confirm")
    || lowered.includes("you're not a bot")
    || lowered.includes("unavailable")
    || lowered.includes("not available")
    || lowered.includes("private video")
    || lowered.includes("age restricted")
    || lowered.includes("members-only")
  );
}

function normalizeYouTubeError(sourceTrackId: string, error: unknown): MusicSourceError {
  const normalized = normalizeMusicSourceError(YOUTUBE_SOURCE_ID, error);
  if (normalized.code !== "unknown") {
    return normalized;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (isPlayableSign(message)) {
    return new MusicSourceError(YOUTUBE_SOURCE_ID, "unplayable", message, {
      retriable: false,
      cause: error,
    });
  }

  return normalized;
}

async function getYouTubeAudioFormat(yt: Innertube, sourceTrackId: string) {
  let lastError: unknown = null;
  for (const client of YOUTUBE_PLAYBACK_CLIENTS) {
    try {
      return await yt.getStreamingData(sourceTrackId, {
        type: "audio",
        quality: "best",
        client,
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new MusicSourceError(
    YOUTUBE_SOURCE_ID,
    "unplayable",
    `No audio stream URL found for video ${sourceTrackId}`,
  );
}

export async function getYouTubeStreamLease(
  sourceTrackId: string,
  options?: { forceRefresh?: boolean },
): Promise<YouTubeStreamLease> {
  if (!isValidYouTubeVideoId(sourceTrackId)) {
    throw new MusicSourceError(
      YOUTUBE_SOURCE_ID,
      "not_found",
      `Invalid YouTube video id: ${sourceTrackId}`,
    );
  }

  const cached = youtubeStreamLeaseCache.get(sourceTrackId);
  if (!options?.forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  try {
    const yt = await getYouTubeClient();
    const format = await getYouTubeAudioFormat(yt, sourceTrackId);
    const streamUrl = format?.url;
    if (!streamUrl) {
      throw new MusicSourceError(
        YOUTUBE_SOURCE_ID,
        "unplayable",
        `No audio stream URL found for video ${sourceTrackId}`,
      );
    }

    const refreshedAt = Date.now();
    const lease = {
      sourceTrackId,
      streamUrl,
      refreshedAt,
      expiresAt: refreshedAt + getUrlTtlMs(),
    };
    youtubeStreamLeaseCache.set(sourceTrackId, lease);
    return lease;
  } catch (error) {
    if (error instanceof MusicSourceError) {
      throw error;
    }
    throw normalizeYouTubeError(sourceTrackId, error);
  }
}

async function resolveYouTubePlayableUrl(
  sourceTrackId: string,
  options?: { forceRefresh?: boolean },
): Promise<PlayableUrlResult> {
  const lease = await getYouTubeStreamLease(sourceTrackId, options);
  return {
    source: YOUTUBE_SOURCE_ID,
    sourceTrackId,
    url: getYouTubeAudioProxyUrl(sourceTrackId),
    validationUrl: lease.streamUrl,
    refreshedAt: lease.refreshedAt,
    expiresAt: lease.expiresAt,
  };
}

async function searchYouTubeMusicSongs(
  yt: Innertube,
  keyword: string,
  limit: number,
): Promise<MusicSourceTrack[]> {
  const result = await yt.music.search(keyword, { type: "song" });
  const items = result.songs?.contents ?? [];
  const tracks: MusicSourceTrack[] = [];
  for (const item of items) {
    if (tracks.length >= limit) {
      break;
    }
    const track = songItemToSourceTrack(item);
    if (track) {
      tracks.push(track);
    }
  }
  return tracks;
}

async function searchYouTubeVideos(
  yt: Innertube,
  keyword: string,
  limit: number,
): Promise<MusicSourceTrack[]> {
  const result = await yt.search(keyword, { type: "video" });
  const tracks: MusicSourceTrack[] = [];
  for (const item of result.videos) {
    if (tracks.length >= limit) {
      break;
    }
    const track = videoItemToSourceTrack(item);
    if (track) {
      tracks.push(track);
    }
  }
  return tracks;
}

export const youtubeAdapter: MusicSourceAdapter = {
  id: YOUTUBE_SOURCE_ID,
  displayName: "YouTube Music (youtubei.js)",

  async search(options) {
    try {
      const yt = await getYouTubeClient();
      const limit = options.limit ?? 10;
      if (limit <= 0) {
        return [];
      }

      try {
        const musicTracks = await searchYouTubeMusicSongs(yt, options.keyword, limit);
        if (musicTracks.length > 0) {
          return musicTracks;
        }
      } catch {
        // YouTube Music search can break independently from normal YouTube search.
        // Fall through to video search so the source can still return playable IDs.
      }

      return searchYouTubeVideos(yt, options.keyword, limit);
    } catch (error) {
      throw normalizeMusicSourceError(YOUTUBE_SOURCE_ID, error);
    }
  },

  async getTrackDetail(sourceTrackId) {
    if (!VIDEO_ID_PATTERN.test(sourceTrackId)) {
      return null;
    }

    try {
      const yt = await getYouTubeClient();
      const info = await yt.music.getInfo(sourceTrackId);
      const basic = info.basic_info;
      const thumbnail = pickLargestThumbnailUrl(
        (basic.thumbnail as YouTubeThumbnail[] | undefined) ?? [],
      );
      return {
        source: YOUTUBE_SOURCE_ID,
        sourceTrackId,
        title: basic.title ?? sourceTrackId,
        artist: basic.author ?? "",
        picUrl: thumbnail,
        duration: basic.duration,
      };
    } catch (error) {
      const normalized = normalizeYouTubeError(sourceTrackId, error);
      if (normalized.code === "not_found") {
        return null;
      }
      throw normalized;
    }
  },

  async resolvePlayableUrl(sourceTrackId, options) {
    return resolveYouTubePlayableUrl(sourceTrackId, options);
  },

  async refreshPlayableUrl(sourceTrackId) {
    return resolveYouTubePlayableUrl(sourceTrackId, { forceRefresh: true });
  },

  async healthCheck() {
    const enabled = isYouTubeEnabled();
    return {
      source: YOUTUBE_SOURCE_ID,
      ok: enabled,
      message: enabled
        ? "YouTube Music source enabled. Upstream availability is checked during search/url resolution."
        : "Disabled by YOUTUBE_ENABLED",
      checkedAt: Date.now(),
    };
  },
};
