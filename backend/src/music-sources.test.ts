import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as netease from "./netease.js";
import {
  NETEASE_LEGACY_SOURCE_ID,
  UNBLOCK_NETEASE_SOURCE_ID,
  inferStoredTrackSource,
  listMusicSourceAdapters,
  refreshStoredTrackPlayableUrl,
  resolveKnownTrack,
  resolveTrack,
  setUnblockNeteaseMatcherForTests,
} from "./music-sources/index.js";

vi.mock("./netease.js");

describe("music source adapters", () => {
  const originalUnblockEnabled = process.env.UNBLOCK_NETEASE_ENABLED;
  const originalUnblockSources = process.env.UNBLOCK_NETEASE_SOURCES;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.UNBLOCK_NETEASE_ENABLED = "false";
    delete process.env.UNBLOCK_NETEASE_SOURCES;
    setUnblockNeteaseMatcherForTests(null);
  });

  afterEach(() => {
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
    setUnblockNeteaseMatcherForTests(null);
  });

  it("lists the registered source adapters", () => {
    const ids = listMusicSourceAdapters().map((adapter) => adapter.id);
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
