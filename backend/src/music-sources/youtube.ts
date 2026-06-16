import { Innertube } from "youtubei.js";
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

type YouTubeMusicSearchResult = Awaited<ReturnType<Innertube["music"]["search"]>>;
type YouTubeMusicSongItem = NonNullable<
  NonNullable<YouTubeMusicSearchResult["songs"]>["contents"]
>[number];
type YouTubeThumbnail = { url?: string };

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

/**
 * Reset the cached Innertube instance. Used by tests and when
 * configuration changes at runtime (not currently exercised).
 */
function resetTubePromise(): void {
  tubePromise = null;
}

export function setYouTubeClientForTests(client: Innertube | null): void {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    return;
  }
  resetTubePromise();
  testClient = client;
}

async function getYouTubeClient(): Promise<Innertube> {
  if (testClient) {
    return testClient;
  }
  if (!tubePromise) {
    const cookie = process.env.YOUTUBE_COOKIE?.trim() || undefined;
    const poToken = process.env.YOUTUBE_PO_TOKEN?.trim() || undefined;
    tubePromise = Innertube.create({
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

async function resolveYouTubePlayableUrl(sourceTrackId: string): Promise<PlayableUrlResult> {
  if (!VIDEO_ID_PATTERN.test(sourceTrackId)) {
    throw new MusicSourceError(
      YOUTUBE_SOURCE_ID,
      "not_found",
      `Invalid YouTube video id: ${sourceTrackId}`,
    );
  }

  try {
    const yt = await getYouTubeClient();
    // youtubei.js returns a deciphered, IP-bound googlevideo direct stream URL.
    // The stream is consumed via the existing /api/audio/music proxy, which
    // forwards Range requests from the same server IP that resolved it.
    const format = await yt.getStreamingData(sourceTrackId, {
      type: "audio",
      quality: "best",
    });
    const url = format?.url;
    if (!url) {
      throw new MusicSourceError(
        YOUTUBE_SOURCE_ID,
        "unplayable",
        `No audio stream URL found for video ${sourceTrackId}`,
      );
    }

    const refreshedAt = Date.now();
    return {
      source: YOUTUBE_SOURCE_ID,
      sourceTrackId,
      url,
      refreshedAt,
      expiresAt: refreshedAt + getUrlTtlMs(),
    };
  } catch (error) {
    if (error instanceof MusicSourceError) {
      throw error;
    }
    throw normalizeYouTubeError(sourceTrackId, error);
  }
}

export const youtubeAdapter: MusicSourceAdapter = {
  id: YOUTUBE_SOURCE_ID,
  displayName: "YouTube Music (youtubei.js)",

  async search(options) {
    try {
      const yt = await getYouTubeClient();
      const result = await yt.music.search(options.keyword, { type: "song" });
      const items = result.songs?.contents ?? [];
      const limit = options.limit ?? 10;
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

  async resolvePlayableUrl(sourceTrackId) {
    return resolveYouTubePlayableUrl(sourceTrackId);
  },

  async refreshPlayableUrl(sourceTrackId) {
    return resolveYouTubePlayableUrl(sourceTrackId);
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
