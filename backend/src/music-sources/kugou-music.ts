import {
  MusicSourceAdapter,
  MusicSourceError,
  MusicSourceTrack,
  PlayableUrlResult,
  normalizeMusicSourceError,
} from "./types.js";

export const KUGOU_SOURCE_ID = "kugou" as const;

const KUGOU_URL_TTL_MS = 30 * 60 * 1000;

const SEARCH_API = "https://songsearch.kugou.com/song_search_v2";
const INFO_API = "https://m.kugou.com/app/i/getSongInfo.php";

interface KugouSearchListEntry {
  SongName?: string;
  SingerName?: string;
  FileHash?: string;
  AlbumName?: string;
  AlbumID?: string;
  Duration?: number;
}

interface KugouSearchResponse {
  data?: {
    lists?: KugouSearchListEntry[];
  };
}

interface KugouSongInfo {
  url?: string;
  hash?: string;
  extName?: string;
  songName?: string;
  singerName?: string;
  imgUrl?: string;
  albumid?: string;
  timeLength?: number;
  bitRate?: number;
  fileSize?: number;
  status?: number;
  error?: string;
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

export function isKugouEnabled(): boolean {
  return parseBooleanEnv(process.env.KUGOU_ENABLED, true);
}

function getUrlTtlMs(): number {
  const configured = Number(process.env.KUGOU_URL_TTL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : KUGOU_URL_TTL_MS;
}

function kugouSearchEntryToTrack(entry: KugouSearchListEntry): MusicSourceTrack | null {
  const hash = entry.FileHash;
  if (!hash || !entry.SongName) {
    return null;
  }
  return {
    source: KUGOU_SOURCE_ID,
    sourceTrackId: hash,
    title: entry.SongName,
    artist: entry.SingerName ?? "Unknown",
    album: entry.AlbumName,
    picUrl: entry.AlbumID
      ? `https://imge.kugou.com/stdmusic/${entry.AlbumID}/jpg`
      : undefined,
    duration: entry.Duration ? entry.Duration * 1000 : undefined,
  };
}

async function searchKugou(keyword: string, limit: number): Promise<MusicSourceTrack[]> {
  const url = `${SEARCH_API}?keyword=${encodeURIComponent(keyword)}&page=1&pagesize=${Math.min(limit, 20)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Claudio/1.0)",
    },
  });
  if (!response.ok) {
    throw new MusicSourceError(
      KUGOU_SOURCE_ID,
      "network_error",
      `Kugou search API returned ${response.status}`,
    );
  }
  const data = (await response.json()) as KugouSearchResponse;
  const lists = data?.data?.lists ?? [];
  const tracks: MusicSourceTrack[] = [];
  for (const entry of lists) {
    if (tracks.length >= limit) break;
    const track = kugouSearchEntryToTrack(entry);
    if (track) tracks.push(track);
  }
  return tracks;
}

async function resolveKugouPlayableUrl(
  sourceTrackId: string,
  options?: { forceRefresh?: boolean },
): Promise<PlayableUrlResult> {
  const url = `${INFO_API}?cmd=playInfo&hash=${encodeURIComponent(sourceTrackId)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Claudio/1.0)",
    },
  });
  if (!response.ok) {
    throw new MusicSourceError(
      KUGOU_SOURCE_ID,
      "network_error",
      `Kugou info API returned ${response.status}`,
    );
  }
  const data = (await response.json()) as KugouSongInfo;
  if (!data.url || data.status !== 1) {
    throw new MusicSourceError(
      KUGOU_SOURCE_ID,
      "unplayable",
      data.error ?? `No playable URL for hash ${sourceTrackId}`,
    );
  }
  const refreshedAt = Date.now();
  return {
    source: KUGOU_SOURCE_ID,
    sourceTrackId,
    url: data.url,
    refreshedAt,
    expiresAt: refreshedAt + getUrlTtlMs(),
  };
}

async function getKugouTrackDetail(sourceTrackId: string): Promise<MusicSourceTrack | null> {
  const url = `${INFO_API}?cmd=playInfo&hash=${encodeURIComponent(sourceTrackId)}`;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Claudio/1.0)",
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as KugouSongInfo;
    if (!data.songName) return null;
    return {
      source: KUGOU_SOURCE_ID,
      sourceTrackId,
      title: data.songName,
      artist: data.singerName ?? "Unknown",
      album: undefined,
      picUrl: data.imgUrl,
      duration: data.timeLength ? data.timeLength * 1000 : undefined,
    };
  } catch {
    return null;
  }
}

async function kugouHealthCheck() {
  const enabled = isKugouEnabled();
  return {
    source: KUGOU_SOURCE_ID,
    ok: enabled,
    message: enabled
      ? "KuGou Music source is configured. Availability is checked during search/url resolution."
      : "Disabled by KUGOU_ENABLED",
    checkedAt: Date.now(),
  };
}

export const kugouAdapter: MusicSourceAdapter = {
  id: KUGOU_SOURCE_ID,
  displayName: "KuGou Music",

  async search(options) {
    try {
      return await searchKugou(options.keyword, options.limit ?? 10);
    } catch (error) {
      throw normalizeMusicSourceError(KUGOU_SOURCE_ID, error);
    }
  },

  async getTrackDetail(sourceTrackId) {
    return getKugouTrackDetail(sourceTrackId);
  },

  async resolvePlayableUrl(sourceTrackId, options) {
    return resolveKugouPlayableUrl(sourceTrackId, options);
  },

  async refreshPlayableUrl(sourceTrackId) {
    return resolveKugouPlayableUrl(sourceTrackId, { forceRefresh: true });
  },

  async healthCheck() {
    return kugouHealthCheck();
  },
};
