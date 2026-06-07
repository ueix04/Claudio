import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "../runtime.js";
import {
  MusicSourceAdapter,
  MusicSourceError,
  MusicSourceTrack,
  PlayableUrlResult,
} from "./types.js";

export const LOCAL_LIBRARY_SOURCE_ID = "local_library" as const;

const LOCAL_LIBRARY_URL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCAN_CACHE_MS = 60 * 1000;
const DEFAULT_MAX_FILES = 2_000;
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"]);

interface LocalLibraryTrack extends MusicSourceTrack {
  filePath: string;
  rootPath: string;
  relativePath: string;
  modifiedAt: number;
  fileSize: number;
  contentType: string;
}

interface LocalLibraryCache {
  envKey: string;
  scannedAt: number;
  tracks: LocalLibraryTrack[];
}

export interface LocalLibraryPlaybackFile {
  track: MusicSourceTrack;
  filePath: string;
  contentType: string;
}

export interface LocalLibraryStatus {
  source: typeof LOCAL_LIBRARY_SOURCE_ID;
  enabled: boolean;
  configuredDirectoryCount: number;
  availableDirectoryCount: number;
  trackCount: number;
  maxFiles: number;
  scanCacheMs: number;
  scannedAt?: number;
  sampleTracks: MusicSourceTrack[];
  message: string;
}

let libraryCache: LocalLibraryCache | null = null;

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

function parsePositiveIntegerEnv(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function splitConfiguredDirectories(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  const separator = path.delimiter === ";" ? /[;\n]+/ : /[:\n]+/;
  return raw
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getLocalMusicDirectories(): string[] {
  return splitConfiguredDirectories(process.env.LOCAL_MUSIC_DIRS)
    .map((dir) => path.isAbsolute(dir) ? dir : path.resolve(repoRoot, dir))
    .map((dir) => path.resolve(dir))
    .filter((dir, index, all) => all.indexOf(dir) === index);
}

export function isLocalLibraryEnabled(): boolean {
  const configuredDirs = getLocalMusicDirectories();
  return parseBooleanEnv(process.env.LOCAL_MUSIC_ENABLED, configuredDirs.length > 0);
}

export function clearLocalLibraryCacheForTests(): void {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    return;
  }
  libraryCache = null;
}

function getScanCacheMs(): number {
  return parsePositiveIntegerEnv(process.env.LOCAL_MUSIC_SCAN_CACHE_MS, DEFAULT_SCAN_CACHE_MS);
}

function getMaxFiles(): number {
  return parsePositiveIntegerEnv(process.env.LOCAL_MUSIC_MAX_FILES, DEFAULT_MAX_FILES);
}

function createLocalTrackId(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = relativePath.split(path.sep).join("/");
  const hash = createHash("sha256")
    .update(`${path.resolve(rootPath)}\0${normalizedRelativePath}`)
    .digest("base64url")
    .slice(0, 24);
  return `local_${hash}`;
}

function getAudioContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".flac":
      return "audio/flac";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

function parseTrackName(filePath: string, rootPath: string): Pick<MusicSourceTrack, "title" | "artist" | "album"> {
  const ext = path.extname(filePath);
  const rawName = path.basename(filePath, ext).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  const relativeDir = path.dirname(path.relative(rootPath, filePath));
  const parentName = relativeDir && relativeDir !== "."
    ? path.basename(relativeDir).replace(/[_]+/g, " ").trim()
    : "";
  const match = rawName.match(/^(.+?)\s+[-\u2013\u2014]\s+(.+)$/);

  if (match) {
    return {
      artist: match[1].trim() || parentName || "Local Library",
      title: match[2].trim() || rawName,
      album: parentName || undefined,
    };
  }

  return {
    artist: parentName || "Local Library",
    title: rawName || path.basename(filePath, ext),
    album: parentName || undefined,
  };
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function scanDirectory(
  rootPath: string,
  currentPath: string,
  tracks: LocalLibraryTrack[],
  maxFiles: number,
): Promise<void> {
  if (tracks.length >= maxFiles) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (tracks.length >= maxFiles) {
      return;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = path.resolve(currentPath, entry.name);
    if (!isPathInside(entryPath, rootPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await scanDirectory(rootPath, entryPath, tracks, maxFiles);
      continue;
    }

    if (!entry.isFile() || !AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(entryPath);
    } catch {
      continue;
    }

    const relativePath = path.relative(rootPath, entryPath);
    const parsed = parseTrackName(entryPath, rootPath);
    tracks.push({
      source: LOCAL_LIBRARY_SOURCE_ID,
      sourceTrackId: createLocalTrackId(rootPath, relativePath),
      title: parsed.title,
      artist: parsed.artist,
      album: parsed.album,
      duration: 0,
      filePath: entryPath,
      rootPath,
      relativePath,
      modifiedAt: stat.mtimeMs,
      fileSize: stat.size,
      contentType: getAudioContentType(entryPath),
    });
  }
}

function buildEnvKey(): string {
  return [
    isLocalLibraryEnabled() ? "enabled" : "disabled",
    getLocalMusicDirectories().join("|"),
    getMaxFiles(),
  ].join("::");
}

async function scanLocalLibraryTracks(options?: { forceRefresh?: boolean }): Promise<LocalLibraryTrack[]> {
  if (!isLocalLibraryEnabled()) {
    return [];
  }

  const envKey = buildEnvKey();
  const now = Date.now();
  if (
    !options?.forceRefresh
    && libraryCache
    && libraryCache.envKey === envKey
    && now - libraryCache.scannedAt < getScanCacheMs()
  ) {
    return libraryCache.tracks;
  }

  const roots = getLocalMusicDirectories().filter((dir) => existsSync(dir));
  const tracks: LocalLibraryTrack[] = [];
  const maxFiles = getMaxFiles();
  for (const root of roots) {
    if (tracks.length >= maxFiles) {
      break;
    }
    await scanDirectory(root, root, tracks, maxFiles);
  }

  libraryCache = {
    envKey,
    scannedAt: now,
    tracks,
  };
  return tracks;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\-\u2013\u2014/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function scoreTrack(track: LocalLibraryTrack, keyword: string): number {
  const query = normalizeSearchText(keyword);
  if (!query) {
    return 1;
  }

  const terms = query.split(" ").filter(Boolean);
  const title = normalizeSearchText(track.title);
  const artist = normalizeSearchText(track.artist);
  const album = normalizeSearchText(track.album ?? "");
  const relativePath = normalizeSearchText(track.relativePath);
  const haystack = `${title} ${artist} ${album} ${relativePath}`;

  if (!terms.every((term) => haystack.includes(term))) {
    return 0;
  }

  let score = 10;
  if (title === query) score += 30;
  if (`${title} ${artist}` === query || `${artist} ${title}` === query) score += 22;
  if (title.includes(query)) score += 14;
  if (artist.includes(query)) score += 8;
  if (album.includes(query)) score += 4;
  return score;
}

function toPublicTrack(track: LocalLibraryTrack): MusicSourceTrack {
  return {
    source: track.source,
    sourceTrackId: track.sourceTrackId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
  };
}

async function findLocalTrack(sourceTrackId: string): Promise<LocalLibraryTrack | null> {
  const tracks = await scanLocalLibraryTracks();
  return tracks.find((track) => track.sourceTrackId === sourceTrackId) ?? null;
}

export async function getLocalLibraryStatus(
  options?: {
    forceRefresh?: boolean;
    sampleLimit?: number;
  },
): Promise<LocalLibraryStatus> {
  const enabled = isLocalLibraryEnabled();
  const directories = getLocalMusicDirectories();
  const availableDirectoryCount = directories.filter((dir) => existsSync(dir)).length;
  const sampleLimit = options?.sampleLimit ?? 8;
  const tracks = enabled
    ? await scanLocalLibraryTracks({ forceRefresh: options?.forceRefresh })
    : [];

  return {
    source: LOCAL_LIBRARY_SOURCE_ID,
    enabled,
    configuredDirectoryCount: directories.length,
    availableDirectoryCount,
    trackCount: tracks.length,
    maxFiles: getMaxFiles(),
    scanCacheMs: getScanCacheMs(),
    scannedAt: enabled ? libraryCache?.scannedAt : undefined,
    sampleTracks: tracks.slice(0, sampleLimit).map(toPublicTrack),
    message: enabled
      ? `Local library directories: ${availableDirectoryCount}/${directories.length}; playable files: ${tracks.length}`
      : "Local music library is disabled. Set LOCAL_MUSIC_DIRS to enable it.",
  };
}

export async function summarizeLocalLibraryForPrompt(limit = 20): Promise<string> {
  if (!isLocalLibraryEnabled()) {
    return "";
  }

  const tracks = await scanLocalLibraryTracks();
  if (tracks.length === 0) {
    return "";
  }

  const lines = tracks
    .slice(0, limit)
    .map((track) => {
      const album = track.album ? ` | album=${track.album}` : "";
      return `- source=local_library | ${track.title} - ${track.artist}${album}`;
    })
    .join("\n");

  return `本地音乐文件库（已扫描 ${tracks.length} 首，可优先用于可靠播放；使用这些歌曲时请原样返回 title 和 artist，不要返回本地文件路径）：\n${lines}`;
}

async function resolveLocalPlayableUrl(sourceTrackId: string): Promise<PlayableUrlResult> {
  if (!isLocalLibraryEnabled()) {
    throw new MusicSourceError(
      LOCAL_LIBRARY_SOURCE_ID,
      "unplayable",
      "Local music library is disabled",
    );
  }

  const track = await findLocalTrack(sourceTrackId);
  if (!track) {
    throw new MusicSourceError(
      LOCAL_LIBRARY_SOURCE_ID,
      "not_found",
      `Local music track not found: ${sourceTrackId}`,
    );
  }

  const refreshedAt = Date.now();
  return {
    source: LOCAL_LIBRARY_SOURCE_ID,
    sourceTrackId,
    url: `/api/audio/local/${encodeURIComponent(sourceTrackId)}`,
    refreshedAt,
    expiresAt: refreshedAt + LOCAL_LIBRARY_URL_TTL_MS,
  };
}

export async function getLocalLibraryFileForPlayback(sourceTrackId: string): Promise<LocalLibraryPlaybackFile> {
  const track = await findLocalTrack(sourceTrackId);
  if (!track) {
    throw new MusicSourceError(
      LOCAL_LIBRARY_SOURCE_ID,
      "not_found",
      `Local music track not found: ${sourceTrackId}`,
    );
  }

  return {
    track: toPublicTrack(track),
    filePath: track.filePath,
    contentType: track.contentType,
  };
}

export const localLibraryAdapter: MusicSourceAdapter = {
  id: LOCAL_LIBRARY_SOURCE_ID,
  displayName: "Local music library",

  async search(options) {
    const tracks = await scanLocalLibraryTracks();
    const limit = options.limit ?? 10;
    return tracks
      .map((track) => ({
        track,
        score: scoreTrack(track, options.keyword),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title))
      .slice(0, limit)
      .map((item) => toPublicTrack(item.track));
  },

  async getTrackDetail(sourceTrackId) {
    const track = await findLocalTrack(sourceTrackId);
    return track ? toPublicTrack(track) : null;
  },

  async resolvePlayableUrl(sourceTrackId) {
    return resolveLocalPlayableUrl(sourceTrackId);
  },

  async refreshPlayableUrl(sourceTrackId) {
    return resolveLocalPlayableUrl(sourceTrackId);
  },

  async healthCheck() {
    const status = await getLocalLibraryStatus({ sampleLimit: 0 });
    return {
      source: LOCAL_LIBRARY_SOURCE_ID,
      ok: status.enabled && status.trackCount > 0,
      message: status.message,
      checkedAt: Date.now(),
    };
  },
};
