import type { Track } from "../db.js";
import type { TasteProfile } from "../taste-profile.js";
import {
  LOCAL_LIBRARY_SOURCE_ID,
  isLocalLibraryEnabled,
  localLibraryAdapter,
} from "./local-library.js";
import { NETEASE_LEGACY_SOURCE_ID, neteaseLegacyAdapter, toPlayableTrack } from "./netease-legacy.js";
import {
  UNBLOCK_NETEASE_SOURCE_ID,
  isUnblockNeteaseEnabled,
  unblockNeteaseAdapter,
} from "./unblock-netease.js";
import {
  MusicSourceAdapter,
  MusicSourceError,
  MusicSourceHealth,
  MusicSourceId,
  MusicSourceTrack,
  PlayableTrack,
  PlayableUrlResult,
  normalizeMusicSourceError,
} from "./types.js";

export * from "./types.js";
export {
  LOCAL_LIBRARY_SOURCE_ID,
  clearLocalLibraryCacheForTests,
  getLocalLibraryFileForPlayback,
  getLocalLibraryStatus,
  getLocalMusicDirectories,
  isLocalLibraryEnabled,
  localLibraryAdapter,
  summarizeLocalLibraryForPrompt,
} from "./local-library.js";
export { NETEASE_LEGACY_SOURCE_ID, neteaseLegacyAdapter };
export {
  UNBLOCK_NETEASE_SOURCE_ID,
  createUnblockNeteaseAdapter,
  getUnblockNeteaseSources,
  isUnblockNeteaseEnabled,
  setUnblockNeteaseMatcherForTests,
  unblockNeteaseAdapter,
} from "./unblock-netease.js";

const adapters = new Map<MusicSourceId, MusicSourceAdapter>([
  [localLibraryAdapter.id, localLibraryAdapter],
  [neteaseLegacyAdapter.id, neteaseLegacyAdapter],
  [unblockNeteaseAdapter.id, unblockNeteaseAdapter],
]);

const PLAYABLE_URL_FALLBACKS: Partial<Record<MusicSourceId, MusicSourceId[]>> = {
  [NETEASE_LEGACY_SOURCE_ID]: [UNBLOCK_NETEASE_SOURCE_ID],
};
const PLAYABLE_URL_VALIDATION_TIMEOUT_MS = 5_000;
const PLAYABLE_URL_VALIDATION_BYTES = "bytes=0-4095";

export interface MusicSourceRuntimeStatus {
  generatedAt: number;
  searchOrder: MusicSourceId[];
  playableUrlFallbacks: Array<{
    source: MusicSourceId;
    fallbacks: MusicSourceId[];
  }>;
  sources: Array<MusicSourceHealth & {
    displayName: string;
    role: "library" | "primary" | "fallback";
    enabled: boolean;
  }>;
}

export interface LocalLibraryTasteMatchSummary {
  source: typeof LOCAL_LIBRARY_SOURCE_ID;
  enabled: boolean;
  profileAvailable: boolean;
  checkedAt: number;
  targetCount: number;
  matchedCount: number;
  coveragePercent: number;
  samples: Array<{
    title: string;
    artist: string;
    album?: string;
    matched: boolean;
    localTrack?: {
      sourceTrackId: string;
      title: string;
      artist: string;
      album?: string;
    };
  }>;
  message: string;
}

export function getMusicSourceAdapter(source: MusicSourceId): MusicSourceAdapter {
  const adapter = adapters.get(source);
  if (!adapter) {
    throw new MusicSourceError(source, "not_found", `Music source adapter not found: ${source}`);
  }

  return adapter;
}

export function listMusicSourceAdapters(): MusicSourceAdapter[] {
  return Array.from(adapters.values());
}

function getPlayableUrlFallbacks(source: MusicSourceId): MusicSourceId[] {
  return (PLAYABLE_URL_FALLBACKS[source] ?? [])
    .filter((fallbackSource) => {
      if (fallbackSource === UNBLOCK_NETEASE_SOURCE_ID) {
        return isUnblockNeteaseEnabled();
      }
      return true;
    });
}

function getRuntimeSearchOrder(): MusicSourceId[] {
  return [
    ...(isLocalLibraryEnabled() ? [LOCAL_LIBRARY_SOURCE_ID] : []),
    NETEASE_LEGACY_SOURCE_ID,
  ];
}

function getSourceRole(source: MusicSourceId): "library" | "primary" | "fallback" {
  if (source === LOCAL_LIBRARY_SOURCE_ID) return "library";
  if (source === UNBLOCK_NETEASE_SOURCE_ID) return "fallback";
  return "primary";
}

function isSourceEnabled(source: MusicSourceId): boolean {
  if (source === LOCAL_LIBRARY_SOURCE_ID) return isLocalLibraryEnabled();
  if (source === UNBLOCK_NETEASE_SOURCE_ID) return isUnblockNeteaseEnabled();
  return true;
}

function shouldValidatePlayableUrl(url: string): boolean {
  return process.env.NODE_ENV !== "test" && /^https?:\/\//i.test(url);
}

function looksLikeAudioResponse(contentType: string | null, head: Uint8Array): boolean {
  const normalizedType = contentType?.toLowerCase() ?? "";
  if (normalizedType.startsWith("audio/")) {
    return true;
  }

  const bytes = Buffer.from(head);
  if (bytes.length < 4) {
    return false;
  }

  const asciiHead = bytes.subarray(0, 12).toString("latin1");
  const first = bytes[0];
  const second = bytes[1];
  return (
    asciiHead.startsWith("ID3")
    || asciiHead.startsWith("OggS")
    || asciiHead.startsWith("RIFF")
    || asciiHead.includes("ftyp")
    || (first === 0xff && (second & 0xe0) === 0xe0)
  );
}

async function validatePlayableUrlResult(result: PlayableUrlResult): Promise<PlayableUrlResult> {
  if (!shouldValidatePlayableUrl(result.url)) {
    return result;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLAYABLE_URL_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(result.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 Claudio/1.0",
        "Accept": "audio/*,*/*;q=0.9",
        "Range": PLAYABLE_URL_VALIDATION_BYTES,
      },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new MusicSourceError(
        result.source,
        response.status >= 500 ? "source_502" : "unplayable",
        `Resolved URL validation failed with status ${response.status}`,
      );
    }

    const reader = response.body.getReader();
    const chunk = await reader.read();
    await reader.cancel().catch(() => {});
    const head = chunk.value ?? new Uint8Array();
    if (!looksLikeAudioResponse(response.headers.get("content-type"), head)) {
      throw new MusicSourceError(
        result.source,
        "unplayable",
        "Resolved URL did not return recognizable audio data",
      );
    }

    return result;
  } catch (error) {
    if (error instanceof MusicSourceError) {
      throw error;
    }

    throw normalizeMusicSourceError(result.source, error);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getMusicSourceRuntimeStatus(): Promise<MusicSourceRuntimeStatus> {
  const sourceStatuses = await Promise.all(
    listMusicSourceAdapters().map(async (adapter) => {
      let health: MusicSourceHealth;
      try {
        health = await adapter.healthCheck();
      } catch (error) {
        const normalized = normalizeMusicSourceError(adapter.id, error);
        health = {
          source: adapter.id,
          ok: false,
          message: normalized.message,
          checkedAt: Date.now(),
        };
      }

      return {
        ...health,
        displayName: adapter.displayName,
        role: getSourceRole(adapter.id),
        enabled: isSourceEnabled(adapter.id),
      };
    }),
  );

  return {
    generatedAt: Date.now(),
    searchOrder: getRuntimeSearchOrder(),
    playableUrlFallbacks: [
      {
        source: NETEASE_LEGACY_SOURCE_ID,
        fallbacks: getPlayableUrlFallbacks(NETEASE_LEGACY_SOURCE_ID),
      },
    ],
    sources: sourceStatuses,
  };
}

export async function getLocalLibraryTasteMatchSummary(
  profile: TasteProfile | null,
  options?: {
    limit?: number;
  },
): Promise<LocalLibraryTasteMatchSummary> {
  const checkedAt = Date.now();
  const limit = options?.limit ?? 12;
  const targetTracks = profile?.topTracks.slice(0, limit) ?? [];
  const enabled = isLocalLibraryEnabled();

  if (!profile || targetTracks.length === 0) {
    return {
      source: LOCAL_LIBRARY_SOURCE_ID,
      enabled,
      profileAvailable: Boolean(profile),
      checkedAt,
      targetCount: 0,
      matchedCount: 0,
      coveragePercent: 0,
      samples: [],
      message: profile
        ? "Taste profile has no top tracks to check yet."
        : "No taste profile available. Sync your library before checking local coverage.",
    };
  }

  const samples = await Promise.all(targetTracks.map(async (track) => {
    const query = `${track.name} ${track.artist}`;
    const matches = enabled
      ? await localLibraryAdapter.search({ keyword: query, limit: 1 })
      : [];
    const localTrack = matches[0];

    return {
      title: track.name,
      artist: track.artist,
      album: track.album,
      matched: Boolean(localTrack),
      localTrack: localTrack
        ? {
            sourceTrackId: localTrack.sourceTrackId,
            title: localTrack.title,
            artist: localTrack.artist,
            album: localTrack.album,
          }
        : undefined,
    };
  }));
  const matchedCount = samples.filter((sample) => sample.matched).length;
  const coveragePercent = targetTracks.length > 0
    ? Math.round((matchedCount / targetTracks.length) * 100)
    : 0;

  return {
    source: LOCAL_LIBRARY_SOURCE_ID,
    enabled,
    profileAvailable: true,
    checkedAt,
    targetCount: targetTracks.length,
    matchedCount,
    coveragePercent,
    samples,
    message: enabled
      ? `Matched ${matchedCount}/${targetTracks.length} taste-profile tracks in local library.`
      : "Local music library is disabled. Set LOCAL_MUSIC_DIRS to enable coverage checks.",
  };
}

export function inferStoredTrackSource(
  track: Pick<Track, "id" | "source" | "sourceTrackId">,
): { source: MusicSourceId; sourceTrackId: string } | null {
  if (track.source && track.sourceTrackId) {
    return {
      source: track.source as MusicSourceId,
      sourceTrackId: track.sourceTrackId,
    };
  }

  const numericId = Number(track.id);
  if (Number.isFinite(numericId)) {
    return {
      source: NETEASE_LEGACY_SOURCE_ID,
      sourceTrackId: String(track.id),
    };
  }

  return null;
}

export async function resolveKnownTrack(
  track: MusicSourceTrack,
  options?: {
    forceRefresh?: boolean;
  },
): Promise<PlayableTrack> {
  const playableUrl = await resolvePlayableUrlWithFallback(track.source, track.sourceTrackId, options);
  return toPlayableTrack(track, playableUrl);
}

async function resolvePlayableUrlWithFallback(
  source: MusicSourceId,
  sourceTrackId: string,
  options?: {
    forceRefresh?: boolean;
  },
): Promise<PlayableUrlResult> {
  try {
    const adapter = getMusicSourceAdapter(source);
    const result = await adapter.resolvePlayableUrl(sourceTrackId, options);
    return await validatePlayableUrlResult(result);
  } catch (error) {
    const primaryError = normalizeMusicSourceError(source, error);
    const fallbackSources = getPlayableUrlFallbacks(source);

    for (const fallbackSource of fallbackSources) {
      try {
        const fallbackAdapter = getMusicSourceAdapter(fallbackSource);
        const fallbackResult = await fallbackAdapter.resolvePlayableUrl(sourceTrackId, {
          forceRefresh: options?.forceRefresh ?? true,
        });
        return await validatePlayableUrlResult(fallbackResult);
      } catch (fallbackError) {
        const normalizedFallbackError = normalizeMusicSourceError(fallbackSource, fallbackError);
        console.warn(
          `[music-source] fallback ${fallbackSource} failed for ${source}:${sourceTrackId}: ${normalizedFallbackError.message}`,
        );
      }
    }

    throw primaryError;
  }
}

export async function resolveTrack(
  title: string,
  artist?: string,
  source?: MusicSourceId,
): Promise<PlayableTrack | null> {
  const query = artist ? `${title} ${artist}` : title;
  const searchSources = source
    ? [source]
    : getRuntimeSearchOrder();
  let lastError: MusicSourceError | null = null;

  for (const searchSource of searchSources) {
    try {
      const adapter = getMusicSourceAdapter(searchSource);
      const tracks = await adapter.search({ keyword: query, limit: 5 });
      const track = tracks[0];
      if (!track) {
        continue;
      }

      return await resolveKnownTrack(track);
    } catch (error) {
      lastError = normalizeMusicSourceError(searchSource, error);
      if (source) {
        throw lastError;
      }
      console.warn(`[music-source] search source ${searchSource} failed for ${query}: ${lastError.message}`);
    }
  }

  return null;
}

export async function refreshStoredTrackPlayableUrl(
  track: Track,
  options?: {
    forceRefresh?: boolean;
  },
): Promise<Track> {
  const identity = inferStoredTrackSource(track);
  if (!identity) {
    return track;
  }

  try {
    const playableUrl = await resolvePlayableUrlWithFallback(identity.source, identity.sourceTrackId, {
      forceRefresh: options?.forceRefresh ?? true,
    });
    return {
      ...track,
      source: identity.source,
      sourceTrackId: identity.sourceTrackId,
      urlSource: playableUrl.source,
      url: playableUrl.url,
      urlExpiresAt: playableUrl.expiresAt,
      urlRefreshedAt: playableUrl.refreshedAt,
      playbackHealth: playableUrl.source !== identity.source ? "fallback" : "ready",
      lastPlaybackIssue: undefined,
      lastResolveError: undefined,
    };
  } catch (error) {
    const normalized = normalizeMusicSourceError(identity.source, error);
    return {
      ...track,
      source: identity.source,
      sourceTrackId: identity.sourceTrackId,
      lastResolveError: {
        code: normalized.code,
        message: normalized.message,
        at: Date.now(),
      },
    };
  }
}
