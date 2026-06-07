import { createRequire } from "node:module";
import {
  MusicSourceAdapter,
  MusicSourceError,
  PlayableUrlResult,
  normalizeMusicSourceError,
} from "./types.js";

export const UNBLOCK_NETEASE_SOURCE_ID = "unblock_netease" as const;

const UNBLOCK_NETEASE_URL_TTL_MS = 30 * 60 * 1000;
const DEFAULT_UNBLOCK_NETEASE_SOURCES = ["kugou", "bodian", "migu"];

interface UnblockNeteaseAudioData {
  url?: string | null;
  br?: number | null;
  source?: string;
}

export type UnblockNeteaseMatcher = (
  id: number,
  sources?: string[],
  data?: unknown,
) => Promise<UnblockNeteaseAudioData>;

const require = createRequire(import.meta.url);
let testMatcher: UnblockNeteaseMatcher | null = null;

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

export function isUnblockNeteaseEnabled(): boolean {
  return parseBooleanEnv(process.env.UNBLOCK_NETEASE_ENABLED, true);
}

export function getUnblockNeteaseSources(): string[] {
  const configured = process.env.UNBLOCK_NETEASE_SOURCES
    ?.split(",")
    .map((source) => source.trim().toLowerCase())
    .filter(Boolean);

  return configured && configured.length > 0
    ? configured
    : DEFAULT_UNBLOCK_NETEASE_SOURCES;
}

export function setUnblockNeteaseMatcherForTests(match: UnblockNeteaseMatcher | null): void {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    return;
  }
  testMatcher = match;
}

function loadMatcher(): UnblockNeteaseMatcher {
  if (testMatcher) {
    return testMatcher;
  }

  const imported = require("@unblockneteasemusic/server") as unknown;
  const matcher = typeof imported === "function"
    ? imported
    : typeof (imported as { default?: unknown }).default === "function"
      ? (imported as { default: unknown }).default
      : null;

  if (!matcher) {
    throw new MusicSourceError(
      UNBLOCK_NETEASE_SOURCE_ID,
      "not_found",
      "@unblockneteasemusic/server did not export a matcher function",
    );
  }

  return matcher as UnblockNeteaseMatcher;
}

function normalizeUnblockError(error: unknown): MusicSourceError {
  const normalized = normalizeMusicSourceError(UNBLOCK_NETEASE_SOURCE_ID, error);
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (
    normalized.code === "unknown"
    && (
      lowered.includes("no audiodata")
      || lowered.includes("songnotavailable")
      || lowered.includes("all promises were rejected")
    )
  ) {
    return new MusicSourceError(UNBLOCK_NETEASE_SOURCE_ID, "unplayable", message, {
      retriable: false,
      cause: error,
    });
  }

  return normalized;
}

async function resolveUnblockPlayableUrl(
  sourceTrackId: string,
  matcher?: UnblockNeteaseMatcher,
): Promise<PlayableUrlResult> {
  if (!isUnblockNeteaseEnabled()) {
    throw new MusicSourceError(
      UNBLOCK_NETEASE_SOURCE_ID,
      "unplayable",
      "UnblockNeteaseMusic fallback is disabled",
    );
  }

  const numericId = Number(sourceTrackId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new MusicSourceError(
      UNBLOCK_NETEASE_SOURCE_ID,
      "not_found",
      `Invalid Netease track id for fallback: ${sourceTrackId}`,
    );
  }

  try {
    const refreshedAt = Date.now();
    const audioData = await (matcher ?? loadMatcher())(numericId, getUnblockNeteaseSources());
    const url = typeof audioData?.url === "string" ? audioData.url.trim() : "";
    if (!url) {
      throw new MusicSourceError(
        UNBLOCK_NETEASE_SOURCE_ID,
        "unplayable",
        `No fallback playable URL found for track ${sourceTrackId}`,
      );
    }

    return {
      source: UNBLOCK_NETEASE_SOURCE_ID,
      sourceTrackId,
      url,
      refreshedAt,
      expiresAt: refreshedAt + UNBLOCK_NETEASE_URL_TTL_MS,
    };
  } catch (error) {
    throw normalizeUnblockError(error);
  }
}

export function createUnblockNeteaseAdapter(
  options?: {
    match?: UnblockNeteaseMatcher;
  },
): MusicSourceAdapter {
  const resolveWithMatcher = (sourceTrackId: string) =>
    resolveUnblockPlayableUrl(sourceTrackId, options?.match);

  return {
    id: UNBLOCK_NETEASE_SOURCE_ID,
    displayName: "UnblockNeteaseMusic fallback",

    async search() {
      return [];
    },

    async getTrackDetail() {
      return null;
    },

    async resolvePlayableUrl(sourceTrackId) {
      return resolveWithMatcher(sourceTrackId);
    },

    async refreshPlayableUrl(sourceTrackId) {
      return resolveWithMatcher(sourceTrackId);
    },

    async healthCheck() {
      const enabled = isUnblockNeteaseEnabled();
      return {
        source: UNBLOCK_NETEASE_SOURCE_ID,
        ok: enabled,
        message: enabled
          ? `Fallback enabled with sources: ${getUnblockNeteaseSources().join(", ")}`
          : "Fallback disabled by UNBLOCK_NETEASE_ENABLED",
        checkedAt: Date.now(),
      };
    },
  };
}

export const unblockNeteaseAdapter = createUnblockNeteaseAdapter();
