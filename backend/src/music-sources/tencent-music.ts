import qqMusic from "@xnfa/qq-music-api";
import {
  MusicSourceAdapter,
  MusicSourceError,
  MusicSourceTrack,
  PlayableUrlResult,
  normalizeMusicSourceError,
} from "./types.js";

export const TENCENT_SOURCE_ID = "tencent" as const;

interface QqSinger {
  id: number;
  mid: string;
  name: string;
}

interface QqSearchItem {
  songname: string;
  songmid: string;
  albummid?: string;
  albumname?: string;
  interval?: number;
  singer?: QqSinger[];
  songid?: number;
}

interface QqSearchResponse {
  list?: QqSearchItem[];
  total?: number;
}

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

export function isTencentEnabled(): boolean {
  return parseBooleanEnv(process.env.TENCENT_ENABLED, true);
}

function searchItemToTrack(item: QqSearchItem): MusicSourceTrack | null {
  if (!item.songmid || !item.songname) {
    return null;
  }
  const artists = Array.isArray(item.singer)
    ? item.singer.map((s) => s.name).filter(Boolean).join(", ")
    : "Unknown";

  return {
    source: TENCENT_SOURCE_ID,
    sourceTrackId: item.songmid,
    title: item.songname,
    artist: artists,
    album: item.albumname,
    picUrl: item.albummid
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg`
      : undefined,
    duration: item.interval ? item.interval * 1000 : undefined,
  };
}

async function searchTencent(keyword: string, limit: number): Promise<MusicSourceTrack[]> {
  try {
    const result = (await qqMusic.api("search", {
      key: keyword,
      pageSize: Math.min(limit, 20),
      t: 0, // 0 = song search
    })) as QqSearchResponse;

    const items = result?.list ?? [];
    const tracks: MusicSourceTrack[] = [];
    for (const item of items) {
      if (tracks.length >= limit) break;
      const track = searchItemToTrack(item);
      if (track) tracks.push(track);
    }
    return tracks;
  } catch (error) {
    throw normalizeMusicSourceError(TENCENT_SOURCE_ID, error);
  }
}

async function resolveTencentPlayableUrl(
  sourceTrackId: string,
  _options?: { forceRefresh?: boolean },
): Promise<PlayableUrlResult> {
  throw new MusicSourceError(
    TENCENT_SOURCE_ID,
    "unplayable",
    `Tencent Music is metadata-only in Claudio; playback URL resolution is disabled for ${sourceTrackId}.`,
    { retriable: false },
  );
}

async function getTencentTrackDetail(sourceTrackId: string): Promise<MusicSourceTrack | null> {
  try {
    const result = await qqMusic.api("song", { id: sourceTrackId }) as {
      info?: { name?: string; singer?: Array<{ name: string }>; album?: { name: string; mid: string }; interval?: number };
    };
    const info = result?.info;
    if (!info?.name) return null;
    return {
      source: TENCENT_SOURCE_ID,
      sourceTrackId,
      title: info.name,
      artist: Array.isArray(info.singer)
        ? info.singer.map((s) => s.name).filter(Boolean).join(", ")
        : "Unknown",
      album: info.album?.name,
      picUrl: info.album?.mid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${info.album.mid}.jpg`
        : undefined,
      duration: info.interval ? info.interval * 1000 : undefined,
    };
  } catch {
    return null;
  }
}

async function tencentHealthCheck() {
  const enabled = isTencentEnabled();
  return {
    source: TENCENT_SOURCE_ID,
    ok: enabled,
    message: enabled
      ? "Tencent Music is enabled as a metadata-only fallback. Playback URL resolution is disabled."
      : "Disabled by TENCENT_ENABLED",
    checkedAt: Date.now(),
  };
}

export const tencentAdapter: MusicSourceAdapter = {
  id: TENCENT_SOURCE_ID,
  displayName: "Tencent Music (QQ)",

  async search(options) {
    try {
      return await searchTencent(options.keyword, options.limit ?? 10);
    } catch (error) {
      throw normalizeMusicSourceError(TENCENT_SOURCE_ID, error);
    }
  },

  async getTrackDetail(sourceTrackId) {
    return getTencentTrackDetail(sourceTrackId);
  },

  async resolvePlayableUrl(sourceTrackId, options) {
    return resolveTencentPlayableUrl(sourceTrackId, options);
  },

  async refreshPlayableUrl(sourceTrackId) {
    return resolveTencentPlayableUrl(sourceTrackId, { forceRefresh: true });
  },

  async healthCheck() {
    return tencentHealthCheck();
  },
};
