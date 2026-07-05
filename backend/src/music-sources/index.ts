import type { Track } from "../db.js";
import {
  fetchViaProxy,
  hasNetworkProxyConfigured,
} from "../network.js";
import type { TasteProfile } from "../taste-profile.js";
import {
  LOCAL_LIBRARY_SOURCE_ID,
  isLocalLibraryEnabled,
  localLibraryAdapter,
} from "./local-library.js";
import {
  YOUTUBE_SOURCE_ID,
  clearYouTubeStreamLease,
  getYouTubeAudioProxyUrl,
  getYouTubeStreamLease,
  isValidYouTubeVideoId,
  isYouTubeEnabled,
  setYouTubeClientForTests,
  youtubeAdapter,
} from "./youtube.js";
import {
  KUGOU_SOURCE_ID,
  isKugouEnabled,
  kugouAdapter,
} from "./kugou-music.js";
import {
  TENCENT_SOURCE_ID,
  isTencentEnabled,
  tencentAdapter,
} from "./tencent-music.js";
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
export {
  YOUTUBE_SOURCE_ID,
  clearYouTubeStreamLease,
  getYouTubeAudioProxyUrl,
  getYouTubeStreamLease,
  isValidYouTubeVideoId,
  isYouTubeEnabled,
  setYouTubeClientForTests,
  youtubeAdapter,
} from "./youtube.js";
export {
  KUGOU_SOURCE_ID,
  isKugouEnabled,
  kugouAdapter,
} from "./kugou-music.js";
export {
  TENCENT_SOURCE_ID,
  isTencentEnabled,
  tencentAdapter,
} from "./tencent-music.js";

const adapters = new Map<MusicSourceId, MusicSourceAdapter>([
  [localLibraryAdapter.id, localLibraryAdapter],
  [youtubeAdapter.id, youtubeAdapter],
  [kugouAdapter.id, kugouAdapter],
  [tencentAdapter.id, tencentAdapter],
]);

const PLAYABLE_URL_VALIDATION_TIMEOUT_MS = 5_000;
const PLAYABLE_URL_VALIDATION_BYTES = "bytes=0-4095";

export interface MusicSourceRuntimeStatus {
  generatedAt: number;
  searchOrder: MusicSourceId[];
  sources: Array<MusicSourceHealth & {
    displayName: string;
    role: "library" | "primary" | "metadata";
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

// Known source IDs from the removed netease_legacy adapter that may
// still appear in stored Track records. These trigger a cross-source
// migration search when encountered.
const DEPRECATED_SOURCE_IDS = new Set(["netease_legacy", "unblock_netease"]);
const METADATA_ONLY_SOURCE_IDS = new Set<MusicSourceId>([TENCENT_SOURCE_ID]);

function toPlayableTrack(track: MusicSourceTrack, playableUrl: PlayableUrlResult): PlayableTrack {
  const numericId = Number(track.sourceTrackId);
  return {
    id: Number.isFinite(numericId) ? numericId : track.sourceTrackId,
    name: track.title,
    artist: track.artist,
    url: playableUrl.url,
    picUrl: track.picUrl ?? "",
    duration: track.duration ?? 0,
    album: track.album,
    source: track.source,
    sourceTrackId: track.sourceTrackId,
    urlSource: playableUrl.source,
    urlExpiresAt: playableUrl.expiresAt,
    urlRefreshedAt: playableUrl.refreshedAt,
  };
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

function getRuntimeSearchOrder(): MusicSourceId[] {
  return [
    ...(isLocalLibraryEnabled() ? [LOCAL_LIBRARY_SOURCE_ID] : []),
    ...(isKugouEnabled() ? [KUGOU_SOURCE_ID] : []),
    ...(isYouTubeEnabled() ? [YOUTUBE_SOURCE_ID] : []),
  ];
}

function getMetadataFallbackOrder(): MusicSourceId[] {
  return [
    ...(isTencentEnabled() ? [TENCENT_SOURCE_ID] : []),
  ];
}

function getSourceRole(source: MusicSourceId): "library" | "primary" | "metadata" {
  if (source === LOCAL_LIBRARY_SOURCE_ID) return "library";
  if (source === TENCENT_SOURCE_ID) return "metadata";
  return "primary";
}

function isSourceEnabled(source: MusicSourceId): boolean {
  if (source === LOCAL_LIBRARY_SOURCE_ID) return isLocalLibraryEnabled();
  if (source === YOUTUBE_SOURCE_ID) return isYouTubeEnabled();
  if (source === KUGOU_SOURCE_ID) return isKugouEnabled();
  if (source === TENCENT_SOURCE_ID) return isTencentEnabled();
  return true;
}

function shouldValidatePlayableUrl(url: string): boolean {
  return process.env.NODE_ENV !== "test" && /^https?:\/\//i.test(url);
}

function shouldRetryPlayableFetchViaProxy(result: PlayableUrlResult): boolean {
  return result.source === YOUTUBE_SOURCE_ID;
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
  const validationUrl = result.validationUrl ?? result.url;
  if (!shouldValidatePlayableUrl(validationUrl)) {
    return result;
  }

  const response = await fetchPlayableUrlForValidation(result, validationUrl);
  try {
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
  }
}

async function fetchPlayableUrlForValidation(
  result: PlayableUrlResult,
  validationUrl: string,
): Promise<Response> {
  const useProxy = shouldRetryPlayableFetchViaProxy(result) && hasNetworkProxyConfigured();
  return fetchPlayableUrlValidationAttempt(validationUrl, useProxy);
}

async function fetchPlayableUrlValidationAttempt(
  url: string,
  viaProxy: boolean,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLAYABLE_URL_VALIDATION_TIMEOUT_MS);
  try {
    const init: RequestInit = {
      headers: {
        "User-Agent": "Mozilla/5.0 Claudio/1.0",
        "Accept": "audio/*,*/*;q=0.9",
        "Range": PLAYABLE_URL_VALIDATION_BYTES,
      },
      signal: controller.signal,
    };
    return viaProxy ? fetchViaProxy(url, init) : fetch(url, init);
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
  track: Pick<Track, "id" | "source" | "sourceTrackId" | "name" | "artist">,
): { source: MusicSourceId; sourceTrackId: string } | null {
  // If the track has a valid known source, use it directly
  if (
    track.source
    && track.sourceTrackId
    && !DEPRECATED_SOURCE_IDS.has(track.source)
    && !METADATA_ONLY_SOURCE_IDS.has(track.source as MusicSourceId)
  ) {
    return {
      source: track.source as MusicSourceId,
      sourceTrackId: track.sourceTrackId,
    };
  }

  // For deprecated netease_legacy tracks with numeric IDs, return null
  // so refreshStoredTrackPlayableUrl can attempt a cross-source migration.
  if (DEPRECATED_SOURCE_IDS.has(track.source ?? "")) {
    return null;
  }

  // Old records without explicit source, with numeric IDs (former netease default)
  const numericId = Number(track.id);
  if (Number.isFinite(numericId)) {
    return null;
  }

  return null;
}

export async function resolveKnownTrack(
  track: MusicSourceTrack,
  options?: {
    forceRefresh?: boolean;
  },
): Promise<PlayableTrack> {
  const adapter = getMusicSourceAdapter(track.source);
  const playableUrl = await adapter.resolvePlayableUrl(track.sourceTrackId, options);
  const validated = await validatePlayableUrlResult(playableUrl);
  return toPlayableTrack(track, validated);
}

export async function resolveTrack(
  title: string,
  artist?: string,
  source?: MusicSourceId,
): Promise<PlayableTrack | null> {
  const query = artist ? `${title} ${artist}` : title;
  if (source && !METADATA_ONLY_SOURCE_IDS.has(source)) {
    return resolveTrackFromPlayableSources(query, [source], { throwOnFailure: true });
  }

  if (source && METADATA_ONLY_SOURCE_IDS.has(source)) {
    return resolveTrackUsingMetadataFallback(query);
  }

  const direct = await resolveTrackFromPlayableSources(query, getRuntimeSearchOrder());
  if (direct) {
    return direct;
  }

  return resolveTrackUsingMetadataFallback(query);
}

async function resolveTrackFromPlayableSources(
  query: string,
  searchSources: MusicSourceId[],
  options?: {
    throwOnFailure?: boolean;
  },
): Promise<PlayableTrack | null> {
  for (const searchSource of searchSources) {
    try {
      const track = await findFirstSourceTrack(query, [searchSource], undefined, {
        throwOnFailure: options?.throwOnFailure,
      });
      if (track) {
        return await resolveKnownTrack(track);
      }
    } catch (error) {
      const normalized = normalizeMusicSourceError(searchSource, error);
      if (options?.throwOnFailure) {
        throw normalized;
      }
      console.warn(`[music-source] search source ${searchSource} failed for ${query}: ${normalized.message}`);
    }
  }

  return null;
}

async function resolveTrackUsingMetadataFallback(query: string): Promise<PlayableTrack | null> {
  const metadataTracks = await findMetadataFallbackTracks(query, 5);
  for (const metadataTrack of metadataTracks) {
    const metadataQuery = [metadataTrack.title, metadataTrack.artist].filter(Boolean).join(" ");
    const resolved = await resolveTrackFromPlayableSources(metadataQuery, getRuntimeSearchOrder());
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

async function findMetadataFallbackTracks(query: string, limit: number): Promise<MusicSourceTrack[]> {
  const tracks: MusicSourceTrack[] = [];
  for (const metadataSource of getMetadataFallbackOrder()) {
    try {
      const adapter = getMusicSourceAdapter(metadataSource);
      const results = await adapter.search({ keyword: query, limit });
      tracks.push(...results);
      if (tracks.length >= limit) {
        return tracks.slice(0, limit);
      }
    } catch (error) {
      const normalized = normalizeMusicSourceError(metadataSource, error);
      console.warn(`[music-source] metadata source ${metadataSource} failed for ${query}: ${normalized.message}`);
    }
  }
  return tracks;
}

async function findFirstSourceTrack(
  query: string,
  searchSources: MusicSourceId[],
  preferredTitle?: string,
  options?: {
    throwOnFailure?: boolean;
  },
): Promise<MusicSourceTrack | null> {
  for (const searchSource of searchSources) {
    try {
      const adapter = getMusicSourceAdapter(searchSource);
      const results = await adapter.search({ keyword: query, limit: 3 });
      if (preferredTitle) {
        const exact = results.find(
          (result) => result.title.toLowerCase() === preferredTitle.toLowerCase(),
        );
        if (exact) {
          return exact;
        }
      }
      if (results.length > 0) {
        return results[0];
      }
    } catch (error) {
      const normalized = normalizeMusicSourceError(searchSource, error);
      if (options?.throwOnFailure) {
        throw normalized;
      }
      console.warn(`[music-source] search source ${searchSource} failed for ${query}: ${normalized.message}`);
    }
  }
  return null;
}

function getPreferredPlayableSourcesBefore(source: MusicSourceId): MusicSourceId[] {
  const searchOrder = getRuntimeSearchOrder();
  const sourceIndex = searchOrder.indexOf(source);
  if (sourceIndex <= 0) {
    return [];
  }
  return searchOrder.slice(0, sourceIndex);
}

function filterAvoidedSources(
  sources: MusicSourceId[],
  avoidSources: Set<MusicSourceId>,
): MusicSourceId[] {
  if (avoidSources.size === 0) {
    return sources;
  }
  return sources.filter((source) => !avoidSources.has(source));
}

async function findTrackIdentityInSources(
  track: Track,
  searchSources: MusicSourceId[],
): Promise<{ source: MusicSourceId; sourceTrackId: string } | null> {
  const searchQuery = [track.name, track.artist].filter(Boolean).join(" ");
  if (!searchQuery) return null;

  const direct = await findFirstSourceTrack(searchQuery, searchSources, track.name);
  if (direct) {
    return { source: direct.source, sourceTrackId: direct.sourceTrackId };
  }

  const metadataTracks = await findMetadataFallbackTracks(searchQuery, 3);
  for (const metadataTrack of metadataTracks) {
    const metadataQuery = [metadataTrack.title, metadataTrack.artist].filter(Boolean).join(" ");
    const resolved = await findFirstSourceTrack(metadataQuery, searchSources, track.name);
    if (resolved) {
      return { source: resolved.source, sourceTrackId: resolved.sourceTrackId };
    }
  }
  return null;
}

async function migrateDeprecatedTrack(
  track: Track,
  searchSources = getRuntimeSearchOrder(),
): Promise<{ source: MusicSourceId; sourceTrackId: string } | null> {
  return findTrackIdentityInSources(track, searchSources);
}

async function migrateFailedTrackToPreferredSource(
  track: Track,
  currentSource: MusicSourceId,
  avoidSources = new Set<MusicSourceId>(),
): Promise<{ source: MusicSourceId; sourceTrackId: string } | null> {
  if (!track.lastPlaybackIssue && !track.lastResolveError) {
    return null;
  }

  const preferredSources = filterAvoidedSources(
    getPreferredPlayableSourcesBefore(currentSource),
    avoidSources,
  );
  if (preferredSources.length === 0) {
    return null;
  }

  return findTrackIdentityInSources(track, preferredSources);
}

export async function refreshStoredTrackPlayableUrl(
  track: Track,
  options?: {
    forceRefresh?: boolean;
    avoidSources?: MusicSourceId[];
    fallbackOnly?: boolean;
  },
): Promise<Track> {
  const avoidSources = new Set(options?.avoidSources ?? []);
  const fallbackSources = filterAvoidedSources(getRuntimeSearchOrder(), avoidSources);
  let identity = options?.fallbackOnly ? null : inferStoredTrackSource(track);

  if (identity && avoidSources.has(identity.source)) {
    identity = null;
  }

  // Cross-source migration for deprecated netease tracks
  if (!identity && (track.name || track.artist)) {
    const migrated = await migrateDeprecatedTrack(track, fallbackSources);
    if (migrated) {
      identity = migrated;
    }
  }

  // If a lower-priority source fails in the browser, retry higher-priority
  // playable sources first before refreshing the same failing provider.
  if (identity) {
    const migrated = await migrateFailedTrackToPreferredSource(track, identity.source, avoidSources);
    if (migrated) {
      identity = migrated;
    }
  }

  if (!identity) {
    return track;
  }

  try {
    const adapter = getMusicSourceAdapter(identity.source);
    const playableUrl = await adapter.resolvePlayableUrl(identity.sourceTrackId, {
      forceRefresh: options?.forceRefresh ?? true,
    });
    const validated = await validatePlayableUrlResult(playableUrl);
    return {
      ...track,
      source: identity.source,
      sourceTrackId: identity.sourceTrackId,
      urlSource: validated.source,
      url: validated.url,
      urlExpiresAt: validated.expiresAt,
      urlRefreshedAt: validated.refreshedAt,
      playbackHealth: validated.source !== identity.source ? "fallback" : "ready",
      lastPlaybackIssue: undefined,
      lastResolveError: undefined,
    };
  } catch (error) {
    const normalized = normalizeMusicSourceError(identity.source, error);
    const shouldDropStalePlayableUrl = Boolean(track.lastPlaybackIssue)
      || (track.urlSource !== undefined && track.urlSource !== identity.source)
      || (track.source !== undefined && track.source !== identity.source);
    return {
      ...track,
      source: identity.source,
      sourceTrackId: identity.sourceTrackId,
      url: shouldDropStalePlayableUrl ? "" : track.url,
      urlSource: shouldDropStalePlayableUrl ? identity.source : track.urlSource,
      urlExpiresAt: shouldDropStalePlayableUrl ? undefined : track.urlExpiresAt,
      urlRefreshedAt: shouldDropStalePlayableUrl ? undefined : track.urlRefreshedAt,
      playbackHealth: "failed",
      lastResolveError: {
        code: normalized.code,
        message: normalized.message,
        at: Date.now(),
      },
    };
  }
}
