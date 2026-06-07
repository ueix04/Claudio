import type { Track } from "../db.js";
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
    return await adapter.resolvePlayableUrl(sourceTrackId, options);
  } catch (error) {
    const primaryError = normalizeMusicSourceError(source, error);
    const fallbackSources = getPlayableUrlFallbacks(source);

    for (const fallbackSource of fallbackSources) {
      try {
        const fallbackAdapter = getMusicSourceAdapter(fallbackSource);
        return await fallbackAdapter.resolvePlayableUrl(sourceTrackId, {
          forceRefresh: options?.forceRefresh ?? true,
        });
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
    : [
      ...(isLocalLibraryEnabled() ? [LOCAL_LIBRARY_SOURCE_ID] : []),
      NETEASE_LEGACY_SOURCE_ID,
    ];
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
