export type MusicSourceId = "netease_legacy" | "unblock_netease";

export type MusicSourceErrorCode =
  | "url_expired"
  | "source_502"
  | "unplayable"
  | "not_found"
  | "network_error"
  | "unknown";

export interface MusicSourceTrack {
  source: MusicSourceId;
  sourceTrackId: string;
  title: string;
  artist: string;
  album?: string;
  picUrl?: string;
  duration?: number;
}

export interface PlayableUrlResult {
  source: MusicSourceId;
  sourceTrackId: string;
  url: string;
  expiresAt: number;
  refreshedAt: number;
}

export interface PlayableTrack {
  id: number | string;
  name: string;
  artist: string;
  url: string;
  picUrl: string;
  duration: number;
  album?: string;
  source: MusicSourceId;
  sourceTrackId: string;
  urlSource?: MusicSourceId;
  urlExpiresAt: number;
  urlRefreshedAt: number;
}

export interface MusicSourceSearchOptions {
  keyword: string;
  limit?: number;
}

export interface MusicSourceHealth {
  source: MusicSourceId;
  ok: boolean;
  message?: string;
  checkedAt: number;
}

export interface MusicSourceAdapter {
  id: MusicSourceId;
  displayName: string;
  search(options: MusicSourceSearchOptions): Promise<MusicSourceTrack[]>;
  getTrackDetail(sourceTrackId: string): Promise<MusicSourceTrack | null>;
  resolvePlayableUrl(
    sourceTrackId: string,
    options?: { forceRefresh?: boolean },
  ): Promise<PlayableUrlResult>;
  refreshPlayableUrl(sourceTrackId: string): Promise<PlayableUrlResult>;
  healthCheck(): Promise<MusicSourceHealth>;
}

export class MusicSourceError extends Error {
  readonly source: MusicSourceId;
  readonly code: MusicSourceErrorCode;
  readonly retriable: boolean;

  constructor(
    source: MusicSourceId,
    code: MusicSourceErrorCode,
    message: string,
    options?: {
      retriable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "MusicSourceError";
    this.source = source;
    this.code = code;
    this.retriable = options?.retriable ?? false;
  }
}

export function normalizeMusicSourceError(
  source: MusicSourceId,
  error: unknown,
): MusicSourceError {
  if (error instanceof MusicSourceError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes("502")) {
    return new MusicSourceError(source, "source_502", message, { retriable: true, cause: error });
  }
  if (
    lowered.includes("no playable")
    || lowered.includes("unplayable")
    || lowered.includes("no audiodata")
    || lowered.includes("songnotavailable")
    || lowered.includes("版权")
  ) {
    return new MusicSourceError(source, "unplayable", message, { retriable: false, cause: error });
  }
  if (lowered.includes("not found") || lowered.includes("未找到")) {
    return new MusicSourceError(source, "not_found", message, { retriable: false, cause: error });
  }
  if (
    lowered.includes("fetch failed")
    || lowered.includes("network")
    || lowered.includes("timeout")
    || lowered.includes("econn")
  ) {
    return new MusicSourceError(source, "network_error", message, { retriable: true, cause: error });
  }

  return new MusicSourceError(source, "unknown", message, { retriable: true, cause: error });
}
