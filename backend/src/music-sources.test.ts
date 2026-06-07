import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as netease from "./netease.js";
import {
  LOCAL_LIBRARY_SOURCE_ID,
  NETEASE_LEGACY_SOURCE_ID,
  UNBLOCK_NETEASE_SOURCE_ID,
  clearLocalLibraryCacheForTests,
  getLocalLibraryFileForPlayback,
  getLocalLibraryStatus,
  inferStoredTrackSource,
  listMusicSourceAdapters,
  refreshStoredTrackPlayableUrl,
  resolveKnownTrack,
  resolveTrack,
  setUnblockNeteaseMatcherForTests,
  summarizeLocalLibraryForPrompt,
} from "./music-sources/index.js";

vi.mock("./netease.js");

describe("music source adapters", () => {
  const originalUnblockEnabled = process.env.UNBLOCK_NETEASE_ENABLED;
  const originalUnblockSources = process.env.UNBLOCK_NETEASE_SOURCES;
  const originalLocalEnabled = process.env.LOCAL_MUSIC_ENABLED;
  const originalLocalDirs = process.env.LOCAL_MUSIC_DIRS;
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
    setUnblockNeteaseMatcherForTests(null);
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
    setUnblockNeteaseMatcherForTests(null);
    clearLocalLibraryCacheForTests();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("lists the registered source adapters", () => {
    const ids = listMusicSourceAdapters().map((adapter) => adapter.id);
    expect(ids).toContain(LOCAL_LIBRARY_SOURCE_ID);
    expect(ids).toContain(NETEASE_LEGACY_SOURCE_ID);
    expect(ids).toContain(UNBLOCK_NETEASE_SOURCE_ID);
  });

  it("infers legacy source identity for old numeric queue tracks", () => {
    expect(inferStoredTrackSource({ id: "123" })).toEqual({
      source: NETEASE_LEGACY_SOURCE_ID,
      sourceTrackId: "123",
    });
  });

  it("resolves a known source track into a playable track with url expiry metadata", async () => {
    vi.mocked(netease.getPlayableUrl).mockResolvedValue("https://example.com/song.mp3");

    const track = await resolveKnownTrack({
      source: NETEASE_LEGACY_SOURCE_ID,
      sourceTrackId: "123",
      title: "Song",
      artist: "Artist",
      album: "Album",
      duration: 180000,
      picUrl: "pic",
    });

    expect(track).toMatchObject({
      id: 123,
      name: "Song",
      artist: "Artist",
      url: "https://example.com/song.mp3",
      source: NETEASE_LEGACY_SOURCE_ID,
      sourceTrackId: "123",
      urlSource: NETEASE_LEGACY_SOURCE_ID,
    });
    expect(track.urlExpiresAt).toBeGreaterThan(Date.now());
  });

  it("falls back to UnblockNeteaseMusic when the primary URL resolver fails", async () => {
    process.env.UNBLOCK_NETEASE_ENABLED = "true";
    const fallbackMatcher = vi.fn().mockResolvedValue({
      url: "https://fallback.example.com/song.mp3",
      br: 320000,
      source: "migu",
    });
    setUnblockNeteaseMatcherForTests(fallbackMatcher);
    vi.mocked(netease.getPlayableUrl).mockRejectedValue(new Error("source 502"));

    const track = await resolveKnownTrack({
      source: NETEASE_LEGACY_SOURCE_ID,
      sourceTrackId: "123",
      title: "Song",
      artist: "Artist",
    });

    expect(track).toMatchObject({
      id: 123,
      name: "Song",
      artist: "Artist",
      url: "https://fallback.example.com/song.mp3",
      source: NETEASE_LEGACY_SOURCE_ID,
      sourceTrackId: "123",
      urlSource: UNBLOCK_NETEASE_SOURCE_ID,
    });
    expect(fallbackMatcher).toHaveBeenCalledWith(123, ["kugou", "bodian", "migu"]);
  });

  it("searches and resolves through the adapter registry", async () => {
    vi.mocked(netease.searchSongs).mockResolvedValue({
      tracks: [
        {
          id: 456,
          name: "Found Song",
          artists: [{ name: "Found Artist" }],
          album: { name: "Found Album", picUrl: "pic" },
          duration: 200000,
        },
      ],
      total: 1,
    });
    vi.mocked(netease.getPlayableUrl).mockResolvedValue("found-url");

    const track = await resolveTrack("Found Song", "Found Artist");

    expect(track).toMatchObject({
      id: 456,
      name: "Found Song",
      artist: "Found Artist",
      url: "found-url",
      sourceTrackId: "456",
    });
  });

  it("prefers configured local music files before remote search", async () => {
    const filePath = await createTempMusicFile("Local Artist - Local Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(filePath);
    clearLocalLibraryCacheForTests();

    const track = await resolveTrack("Local Song", "Local Artist");

    expect(netease.searchSongs).not.toHaveBeenCalled();
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

    expect(netease.getPlayableUrl).not.toHaveBeenCalled();
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

  it("refreshes stored tracks and records structured errors without throwing", async () => {
    vi.mocked(netease.getPlayableUrl).mockRejectedValue(new Error("source 502"));

    const refreshed = await refreshStoredTrackPlayableUrl({
      id: "789",
      name: "Old",
      artist: "Artist",
      url: "old-url",
    });

    expect(refreshed.url).toBe("old-url");
    expect(refreshed.source).toBe(NETEASE_LEGACY_SOURCE_ID);
    expect(refreshed.sourceTrackId).toBe("789");
    expect(refreshed.lastResolveError).toMatchObject({
      code: "source_502",
      message: "source 502",
    });
  });
});
