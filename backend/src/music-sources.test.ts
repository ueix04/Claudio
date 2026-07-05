import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KUGOU_SOURCE_ID,
  LOCAL_LIBRARY_SOURCE_ID,
  TENCENT_SOURCE_ID,
  YOUTUBE_SOURCE_ID,
  clearLocalLibraryCacheForTests,
  getLocalLibraryFileForPlayback,
  getLocalLibraryStatus,
  getLocalLibraryTasteMatchSummary,
  getMusicSourceRuntimeStatus,
  inferStoredTrackSource,
  listMusicSourceAdapters,
  refreshStoredTrackPlayableUrl,
  resolveTrack,
  summarizeLocalLibraryForPrompt,
} from "./music-sources/index.js";

describe("music source adapters", () => {
  const originalUnblockEnabled = process.env.UNBLOCK_NETEASE_ENABLED;
  const originalUnblockSources = process.env.UNBLOCK_NETEASE_SOURCES;
  const originalLocalEnabled = process.env.LOCAL_MUSIC_ENABLED;
  const originalLocalDirs = process.env.LOCAL_MUSIC_DIRS;
  const originalYouTubeEnabled = process.env.YOUTUBE_ENABLED;
  let tempDirs: string[] = [];

  async function createTempMusicFile(filename: string, contents = "fake audio"): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claudio-local-music-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
    return filePath;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.UNBLOCK_NETEASE_ENABLED = "false";
    delete process.env.UNBLOCK_NETEASE_SOURCES;
    delete process.env.LOCAL_MUSIC_ENABLED;
    delete process.env.LOCAL_MUSIC_DIRS;
    delete process.env.YOUTUBE_ENABLED;
    clearLocalLibraryCacheForTests();
  });

  afterEach(async () => {
    if (originalUnblockEnabled === undefined) {
      delete process.env.UNBLOCK_NETEASE_ENABLED;
    } else {
      process.env.UNBLOCK_NETEASE_ENABLED = originalUnblockEnabled;
    }
    if (originalUnblockSources === undefined) {
      delete process.env.UNBLOCK_NETEASE_SOURCES;
    } else {
      process.env.UNBLOCK_NETEASE_SOURCES = originalUnblockSources;
    }
    if (originalLocalEnabled === undefined) {
      delete process.env.LOCAL_MUSIC_ENABLED;
    } else {
      process.env.LOCAL_MUSIC_ENABLED = originalLocalEnabled;
    }
    if (originalLocalDirs === undefined) {
      delete process.env.LOCAL_MUSIC_DIRS;
    } else {
      process.env.LOCAL_MUSIC_DIRS = originalLocalDirs;
    }
    if (originalYouTubeEnabled === undefined) {
      delete process.env.YOUTUBE_ENABLED;
    } else {
      process.env.YOUTUBE_ENABLED = originalYouTubeEnabled;
    }
    clearLocalLibraryCacheForTests();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("lists the registered source adapters", () => {
    const ids = listMusicSourceAdapters().map((adapter) => adapter.id);
    expect(ids).toContain(LOCAL_LIBRARY_SOURCE_ID);
    expect(ids).toContain(KUGOU_SOURCE_ID);
    expect(ids).toContain(TENCENT_SOURCE_ID);
  });

  it("summarizes the runtime source order", async () => {
    const filePath = await createTempMusicFile("Runtime Artist - Runtime Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(filePath);
    clearLocalLibraryCacheForTests();

    const status = await getMusicSourceRuntimeStatus();

    // local_library is first when enabled, then playable remote sources.
    // Tencent is metadata-only and is not part of the playable search order.
    expect(status.searchOrder).toEqual([
      LOCAL_LIBRARY_SOURCE_ID,
      KUGOU_SOURCE_ID,
    ]);
    expect(status.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: LOCAL_LIBRARY_SOURCE_ID,
        role: "library",
        enabled: true,
        ok: true,
      }),
      expect.objectContaining({
        source: KUGOU_SOURCE_ID,
        role: "primary",
        enabled: true,
      }),
      expect.objectContaining({
        source: TENCENT_SOURCE_ID,
        role: "metadata",
        enabled: true,
      }),
    ]));
  });

  it("checks how much of the taste profile is covered by local library tracks", async () => {
    const filePath = await createTempMusicFile("Match Artist - Match Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(filePath);
    clearLocalLibraryCacheForTests();

    const summary = await getLocalLibraryTasteMatchSummary({
      generatedAt: 1,
      sourceSyncedAt: 1,
      playlistCount: 1,
      totalTrackCount: 2,
      uniqueTrackCount: 2,
      uniqueArtistCount: 2,
      uniqueAlbumCount: 0,
      languageMix: { chinese: 0, latin: 2, mixed: 0, other: 0 },
      topArtists: [],
      topAlbums: [],
      topTracks: [
        { id: 1, name: "Match Song", artist: "Match Artist", occurrences: 2, playlistCount: 1 },
        { id: 2, name: "Missing Song", artist: "Missing Artist", occurrences: 1, playlistCount: 1 },
      ],
      titleKeywords: [],
      artistKeywords: [],
      playlistFingerprints: [],
      summary: "taste",
    });

    expect(summary).toMatchObject({
      source: LOCAL_LIBRARY_SOURCE_ID,
      enabled: true,
      profileAvailable: true,
      targetCount: 2,
      matchedCount: 1,
      coveragePercent: 50,
    });
    expect(summary.samples[0]).toMatchObject({
      title: "Match Song",
      artist: "Match Artist",
      matched: true,
      localTrack: {
        title: "Match Song",
        artist: "Match Artist",
      },
    });
    expect(JSON.stringify(summary)).not.toContain(path.dirname(filePath));
  });

  it("returns null from inferStoredTrackSource for deprecated netease_legacy source, triggering migration", () => {
    // Tracks with the old netease_legacy source trigger cross-source migration
    expect(inferStoredTrackSource({
      id: "123",
      source: "netease_legacy",
      sourceTrackId: "123",
      name: "Old Song",
      artist: "Old Artist",
    })).toBeNull();
  });

  it("returns null from inferStoredTrackSource for deprecated unblock_netease source", () => {
    expect(inferStoredTrackSource({
      id: "456",
      source: "unblock_netease",
      sourceTrackId: "456",
      name: "Old Song",
      artist: "Old Artist",
    })).toBeNull();
  });

  it("returns source identity from inferStoredTrackSource for known playable sources", () => {
    expect(inferStoredTrackSource({
      id: "1",
      source: LOCAL_LIBRARY_SOURCE_ID,
      sourceTrackId: "local_abc",
      name: "Song",
      artist: "Artist",
    })).toEqual({ source: LOCAL_LIBRARY_SOURCE_ID, sourceTrackId: "local_abc" });

    expect(inferStoredTrackSource({
      id: "2",
      source: KUGOU_SOURCE_ID,
      sourceTrackId: "hash123",
      name: "Song",
      artist: "Artist",
    })).toEqual({ source: KUGOU_SOURCE_ID, sourceTrackId: "hash123" });
  });

  it("treats stored Tencent tracks as metadata-only and migrates them before playback", () => {
    expect(inferStoredTrackSource({
      id: "3",
      source: TENCENT_SOURCE_ID,
      sourceTrackId: "mid123",
      name: "Song",
      artist: "Artist",
    })).toBeNull();
  });

  it("prefers configured local music files before remote search", async () => {
    const filePath = await createTempMusicFile("Local Artist - Local Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(filePath);
    clearLocalLibraryCacheForTests();

    const track = await resolveTrack("Local Song", "Local Artist");

    expect(track).toMatchObject({
      name: "Local Song",
      artist: "Local Artist",
      source: LOCAL_LIBRARY_SOURCE_ID,
      urlSource: LOCAL_LIBRARY_SOURCE_ID,
    });
    expect(track?.sourceTrackId).toMatch(/^local_/);
    expect(track?.url).toBe(`/api/audio/local/${encodeURIComponent(track!.sourceTrackId)}`);

    const playbackFile = await getLocalLibraryFileForPlayback(track!.sourceTrackId);
    expect(playbackFile.filePath).toBe(filePath);
    expect(playbackFile.contentType).toBe("audio/mpeg");
  });

  it("refreshes stored local library tracks without remote fallback", async () => {
    const filePath = await createTempMusicFile("Album/Stable Artist - Stable Song.wav");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(path.dirname(filePath));
    clearLocalLibraryCacheForTests();

    const track = await resolveTrack("Stable Song", "Stable Artist");
    const refreshed = await refreshStoredTrackPlayableUrl({
      id: track!.sourceTrackId,
      name: track!.name,
      artist: track!.artist,
      url: "old-local-url",
      source: LOCAL_LIBRARY_SOURCE_ID,
      sourceTrackId: track!.sourceTrackId,
    });

    expect(refreshed).toMatchObject({
      id: track!.sourceTrackId,
      source: LOCAL_LIBRARY_SOURCE_ID,
      sourceTrackId: track!.sourceTrackId,
      urlSource: LOCAL_LIBRARY_SOURCE_ID,
      url: `/api/audio/local/${encodeURIComponent(track!.sourceTrackId)}`,
    });
    expect(refreshed.urlExpiresAt).toBeGreaterThan(Date.now());
  });

  it("reports local library status and summarizes playable local candidates for prompts", async () => {
    await createTempMusicFile("Prompt Artist - Prompt Song.mp3");
    await createTempMusicFile("Prompt Artist - Second Song.ogg");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = tempDirs.join(path.delimiter);
    clearLocalLibraryCacheForTests();

    const status = await getLocalLibraryStatus();
    const summary = await summarizeLocalLibraryForPrompt(1);

    expect(status).toMatchObject({
      source: LOCAL_LIBRARY_SOURCE_ID,
      enabled: true,
      configuredDirectoryCount: 2,
      availableDirectoryCount: 2,
      trackCount: 2,
    });
    expect(status.sampleTracks).toHaveLength(2);
    expect(summary).toContain("本地音乐文件库");
    expect(summary).toContain("Prompt Song - Prompt Artist");
    expect(summary).not.toContain(tempDirs[0]);
  });

  it("refreshes stored tracks from deprecated sources by playable-source migration", async () => {
    const filePath = await createTempMusicFile("Coldplay - Yellow.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(filePath);
    clearLocalLibraryCacheForTests();

    const refreshed = await refreshStoredTrackPlayableUrl({
      id: "789",
      name: "Yellow",
      artist: "Coldplay",
      url: "old-url",
      source: "netease_legacy",
      sourceTrackId: "789",
    });

    expect(refreshed).toMatchObject({
      source: LOCAL_LIBRARY_SOURCE_ID,
      urlSource: LOCAL_LIBRARY_SOURCE_ID,
      url: `/api/audio/local/${encodeURIComponent(refreshed.sourceTrackId!)}`,
    });
  });

  it("migrates failed youtube tracks to higher-priority playable sources", async () => {
    const filePath = await createTempMusicFile("Coldplay - Yellow.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(filePath);
    process.env.YOUTUBE_ENABLED = "true";
    clearLocalLibraryCacheForTests();

    const refreshed = await refreshStoredTrackPlayableUrl({
      id: "yt-123",
      name: "Yellow",
      artist: "Coldplay",
      url: "https://example.invalid/youtube-audio",
      source: YOUTUBE_SOURCE_ID,
      sourceTrackId: "yt-123",
      urlSource: YOUTUBE_SOURCE_ID,
      lastPlaybackIssue: {
        code: "media_error",
        message: "browser playback failed",
        at: Date.now(),
      },
    });

    expect(refreshed).toMatchObject({
      source: LOCAL_LIBRARY_SOURCE_ID,
      urlSource: LOCAL_LIBRARY_SOURCE_ID,
      url: `/api/audio/local/${encodeURIComponent(refreshed.sourceTrackId!)}`,
    });
    expect(refreshed.lastPlaybackIssue).toBeUndefined();
  });

  it("clears stale playable urls when a failed refresh cannot resolve the new source", async () => {
    const refreshed = await refreshStoredTrackPlayableUrl({
      id: "local-missing",
      name: "Missing Song",
      artist: "Missing Artist",
      url: "https://example.invalid/youtube-audio",
      source: LOCAL_LIBRARY_SOURCE_ID,
      sourceTrackId: "missing-track",
      urlSource: YOUTUBE_SOURCE_ID,
      urlExpiresAt: Date.now() + 60_000,
      urlRefreshedAt: Date.now(),
      lastPlaybackIssue: {
        code: "audio_error",
        message: "browser playback failed",
        at: Date.now(),
      },
    });

    expect(refreshed).toMatchObject({
      source: LOCAL_LIBRARY_SOURCE_ID,
      sourceTrackId: "missing-track",
      url: "",
      urlSource: LOCAL_LIBRARY_SOURCE_ID,
      playbackHealth: "failed",
    });
    expect(refreshed.urlExpiresAt).toBeUndefined();
    expect(refreshed.urlRefreshedAt).toBeUndefined();
    expect(refreshed.lastResolveError).toBeDefined();
  });
});
