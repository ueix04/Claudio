import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as netease from "./netease.js";
import { fetchSourceJson, fetchSourceText } from "./music-sources/http-client.js";
import {
  LOCAL_LIBRARY_SOURCE_ID,
  NETEASE_LEGACY_SOURCE_ID,
  clearLocalLibraryCacheForTests,
  getLocalLibraryFileForPlayback,
  getLocalLibraryStatus,
  getLocalLibraryTasteMatchSummary,
  getMusicSourceRuntimeStatus,
  inferStoredTrackSource,
  listMusicSourceAdapters,
  refreshStoredTrackPlayableUrl,
  resolveKnownTrack,
  resolveTrack,
  summarizeLocalLibraryForPrompt,
} from "./music-sources/index.js";

vi.mock("./netease.js");
vi.mock("./music-sources/http-client.js");

function neteasePlayback(url: string) {
  const refreshedAt = Date.now();
  return { url, refreshedAt, expiresAt: refreshedAt + 1_200_000 };
}

describe("music source adapters", () => {
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
    vi.resetAllMocks();
    vi.mocked(netease.getOpenPlayableUrl).mockResolvedValue(null);
    delete process.env.LOCAL_MUSIC_ENABLED;
    delete process.env.LOCAL_MUSIC_DIRS;
    clearLocalLibraryCacheForTests();
  });

  afterEach(async () => {
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
    clearLocalLibraryCacheForTests();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("lists the registered source adapters", () => {
    const ids = listMusicSourceAdapters().map((adapter) => adapter.id);
    expect(ids).toContain(LOCAL_LIBRARY_SOURCE_ID);
    expect(ids).toContain(NETEASE_LEGACY_SOURCE_ID);
    expect(ids).not.toContain("unblock_netease");
    expect(ids).toContain("kugou");
    expect(ids).toContain("qq");
    expect(ids).toContain("kuwo");
    expect(ids).toContain("bodian");
  });

  it("summarizes the runtime source order and fallback chain", async () => {
    const filePath = await createTempMusicFile("Runtime Artist - Runtime Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(filePath);
    clearLocalLibraryCacheForTests();

    const status = await getMusicSourceRuntimeStatus();

    expect(status.searchOrder).toEqual([LOCAL_LIBRARY_SOURCE_ID, NETEASE_LEGACY_SOURCE_ID, "qq", "kuwo", "kugou", "bodian"]);
    expect(status.playableUrlFallbacks).toContainEqual({
      source: NETEASE_LEGACY_SOURCE_ID, fallbacks: ["qq", "kuwo", "kugou", "bodian", LOCAL_LIBRARY_SOURCE_ID],
    });
    expect(status.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: LOCAL_LIBRARY_SOURCE_ID,
        role: "library",
        enabled: true,
        ok: true,
      }),
      expect.objectContaining({
        source: NETEASE_LEGACY_SOURCE_ID,
        role: "primary",
        enabled: true,
        ok: true,
      }),
      expect.objectContaining({
        source: "kugou",
        role: "fallback",
        enabled: true,
        ok: true,
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

  it("infers legacy source identity for old numeric queue tracks", () => {
    expect(inferStoredTrackSource({ id: "123" })).toEqual({
      source: NETEASE_LEGACY_SOURCE_ID,
      sourceTrackId: "123",
    });
  });

  it("resolves a known source track into a playable track with url expiry metadata", async () => {
    vi.mocked(netease.getOpenPlayableUrl).mockResolvedValue(neteasePlayback("https://example.com/song.mp3"));

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

  it("prefers validated anonymous Netease audio and preserves the upstream expiry", async () => {
    const refreshedAt = Date.now();
    const openUrl = "https://m701.music.126.net/free.mp3";
    vi.mocked(netease.getOpenPlayableUrl).mockResolvedValueOnce({
      url: openUrl, refreshedAt, expiresAt: refreshedAt + 1_200_000,
    });

    const track = await resolveKnownTrack({
      source: NETEASE_LEGACY_SOURCE_ID, sourceTrackId: "123", title: "Song", artist: "Artist",
    });

    expect(track).toMatchObject({ url: openUrl, urlExpiresAt: refreshedAt + 1_200_000, urlSource: NETEASE_LEGACY_SOURCE_ID });
    expect(netease.getOpenPlayableUrl).toHaveBeenCalledWith(123);
  });

  it("tries a direct source if the Netease CDN cannot serve audio", async () => {
    const refreshedAt = Date.now();
    vi.mocked(netease.getOpenPlayableUrl).mockResolvedValueOnce({
      url: "https://m701.music.126.net/public.mp3", refreshedAt, expiresAt: refreshedAt + 1_200_000,
    });
    vi.mocked(fetchSourceJson).mockResolvedValueOnce({
      code: 0, data: { song: { list: [{
        songmid: "fromqq", songname: "Song", singer: [{ name: "Artist" }], interval: 180, pay: { payplay: 0 },
      }] } },
    }).mockResolvedValueOnce({
      code: 0, playback: { code: 0, data: {
        sip: ["https://aqqmusic.tc.qq.com/"],
        midurlinfo: [{ songmid: "fromqq", result: 0, purl: "fromqq.m4a" }],
      } },
    });
    vi.stubEnv("NODE_ENV", "production");
    const media = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response("ID3fixture", { status: 206, headers: { "Content-Type": "audio/mpeg" } }));
    try {
      const track = await resolveKnownTrack({
        source: NETEASE_LEGACY_SOURCE_ID, sourceTrackId: "307", title: "Song", artist: "Artist", duration: 180_000,
      });
      expect(track).toMatchObject({ url: "https://aqqmusic.tc.qq.com/fromqq.m4a", urlSource: "qq" });
      expect(media).toHaveBeenCalledTimes(2);
      expect(netease.getOpenPlayableUrl).toHaveBeenCalledTimes(1);
    } finally {
      media.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("matches free QQ audio without replacing the stored track identity or changing versions", async () => {
    const candidate = { songname: "Song", singer: [{ name: "Artist" }], interval: 180, pay: { payplay: 0 } };
    vi.mocked(fetchSourceJson).mockResolvedValueOnce({
      code: 0,
      data: { song: { list: [
        { ...candidate, songmid: "vip", pay: { payplay: 1 } },
        { ...candidate, songmid: "live", songname: "Song (Live)" },
        { ...candidate, songmid: "cover", singer: [{ name: "Another artist" }] },
        { ...candidate, songmid: "wrongduration", interval: 198 },
        { ...candidate, songmid: "sameversion", interval: 182 },
      ] } },
    }).mockResolvedValueOnce({
      code: 0,
      playback: { code: 0, data: {
        sip: ["https://aqqmusic.tc.qq.com/"],
        midurlinfo: [{ songmid: "sameversion", result: 0, purl: "same.m4a" }],
      } },
    });

    const restored = await refreshStoredTrackPlayableUrl({
      id: "123", name: "Song", artist: "Artist", duration: 180_000, url: "expired-url", urlSource: "unblock_netease",
    });

    expect(restored).toMatchObject({
      id: "123", source: NETEASE_LEGACY_SOURCE_ID, sourceTrackId: "123",
      urlSource: "qq", url: "https://aqqmusic.tc.qq.com/same.m4a", playbackHealth: "fallback",
    });
    expect(restored.lastResolveError).toBeUndefined();
    const vkeyRequest = vi.mocked(fetchSourceJson).mock.calls[1][0];
    expect(JSON.parse(vkeyRequest.searchParams.get("data") ?? "{}").playback.param).toMatchObject({
      songmid: ["sameversion"], loginflag: 0, uin: "0",
    });
  });

  it("tries Kuwo after QQ returns no stream and skips Kuwo previews", async () => {
    const payInfo = { cannotOnlinePlay: "0", listen_fragment: "0", feeType: { album: "0", song: "0", vip: "0" } };
    vi.mocked(fetchSourceJson).mockResolvedValueOnce({
      code: 0,
      data: { song: { list: [{ songmid: "empty", songname: "Song", singer: [{ name: "Artist" }], interval: 180, pay: { payplay: 0 } }] } },
    }).mockResolvedValueOnce({
      code: 0, playback: { code: 0, data: { midurlinfo: [{ songmid: "empty", result: 0, purl: "" }] } },
    }).mockResolvedValueOnce({ content: [{ musicpage: { abslist: [
      { MUSICRID: "MUSIC_1", SONGNAME: "Song", ARTIST: "Artist", DURATION: "180", PAY: "0", payInfo: { ...payInfo, listen_fragment: "1" } },
      { MUSICRID: "MUSIC_2", SONGNAME: "Song", ARTIST: "Artist", DURATION: "181", PAY: "0", payInfo },
    ] } }] });
    vi.mocked(fetchSourceText).mockResolvedValueOnce("https://kw-lv.kuwo.cn/recording.mp3");

    const track = await resolveKnownTrack({
      source: NETEASE_LEGACY_SOURCE_ID, sourceTrackId: "245", title: "Song", artist: "Artist", duration: 180_000,
    });

    expect(track).toMatchObject({ id: 245, sourceTrackId: "245", urlSource: "kuwo", url: "https://kw-lv.kuwo.cn/recording.mp3" });
    const streamRequest = vi.mocked(fetchSourceText).mock.calls[0][0];
    expect(streamRequest.searchParams.get("rid")).toBe("MUSIC_2");
  });

  it("uses the enabled local library after online sources fail when the exact file has no duration", async () => {
    const file = await createTempMusicFile("Artist - Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(file);

    const track = await resolveKnownTrack({
      source: NETEASE_LEGACY_SOURCE_ID, sourceTrackId: "309", title: "Song", artist: "Artist", duration: 180_000,
    });

    expect(track).toMatchObject({ id: 309, sourceTrackId: "309", urlSource: LOCAL_LIBRARY_SOURCE_ID });
    expect(track.url).toMatch(/^\/api\/audio\/local\//);
  });

  it("searches Kugou directly when Netease search fails and rejects paid tracks", async () => {
    const hash = "1234567890abcdef1234567890abcdef";
    const paidHash = "abcdef1234567890abcdef1234567890";
    vi.mocked(netease.searchSongs).mockRejectedValueOnce(new Error("network unavailable"));
    const recording = {
      AlbumID: "42", SongName: "Direct Song", SingerName: "Direct Artist", Duration: 180,
      PayType: 0, Privilege: 0, AlbumPrivilege: 0, Price: 0, PkgPrice: 0, FailProcess: 0,
    };
    vi.mocked(fetchSourceJson)
      .mockResolvedValueOnce({ code: 0 })
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce({ status: 1, data: { lists: [
        { ...recording, FileHash: paidHash, PayType: 3 },
        { ...recording, FileHash: hash },
      ] } })
      .mockResolvedValueOnce({ status: 1, url: ["https://audio.kugou.com/song.mp3"] });

    const track = await resolveTrack("Direct Song", "Direct Artist");

    expect(track).toMatchObject({ source: "kugou", sourceTrackId: `${hash}:42`, urlSource: "kugou" });
    const playbackRequest = vi.mocked(fetchSourceJson).mock.calls[3][0];
    expect(playbackRequest.hostname).toBe("trackercdn.kugou.com");
    expect(playbackRequest.searchParams.get("hash")).toBe(hash);
    expect(netease.getOpenPlayableUrl).not.toHaveBeenCalled();
  });

  it("renews a stored direct track with an empty search cache", async () => {
    vi.mocked(fetchSourceJson).mockResolvedValueOnce({
      code: 0, data: { song: { list: [{
        songmid: "coldcache", songname: "Stored Song", singer: [{ name: "Stored Artist" }],
        interval: 180, pay: { payplay: 0 },
      }] } },
    }).mockResolvedValueOnce({
      code: 0, playback: { code: 0, data: {
        sip: ["https://aqqmusic.tc.qq.com/"],
        midurlinfo: [{ songmid: "coldcache", result: 0, purl: "renewed.m4a" }],
      } },
    });
    const result = await refreshStoredTrackPlayableUrl({
      id: "coldcache", source: "qq", sourceTrackId: "coldcache",
      name: "Stored Song", artist: "Stored Artist", url: "expired", duration: 180_000,
    });
    expect(result).toMatchObject({
      id: "coldcache", source: "qq", urlSource: "qq", url: "https://aqqmusic.tc.qq.com/renewed.m4a",
    });
  });

  it("falls back to Bodian guest audio for a matching free recording", async () => {
    const payInfo = {
      cannotOnlinePlay: "0", listen_fragment: "0", feeType: { album: "0", song: "0", vip: "0" },
    };
    const song = { SONGNAME: "Bodian Song", ARTIST: "Artist", DURATION: "180", PAY: "0", payInfo };
    vi.mocked(fetchSourceJson)
      .mockResolvedValueOnce({ code: 0 })
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce({ status: 1, data: { lists: [] } })
      .mockResolvedValueOnce({ content: [{ musicpage: { abslist: [
        { ...song, MUSICRID: "MUSIC_210", PAY: "1" },
        { ...song, MUSICRID: "MUSIC_211", payInfo: { ...payInfo, listen_fragment: "1" } },
        { ...song, MUSICRID: "MUSIC_212" },
      ] } }] })
      .mockResolvedValueOnce({ code: 200, data: { audioUrl: "https://bd-lv.kuwo.cn/recording.mp3" } });

    const track = await refreshStoredTrackPlayableUrl({
      id: "985", source: NETEASE_LEGACY_SOURCE_ID, sourceTrackId: "985",
      name: "Bodian Song", artist: "Artist", url: "expired", duration: 180_000,
    });

    expect(track).toMatchObject({
      id: "985", sourceTrackId: "985", urlSource: "bodian", url: "https://bd-lv.kuwo.cn/recording.mp3",
    });
    const requests = vi.mocked(fetchSourceJson).mock.calls;
    expect(requests).toHaveLength(5);
    expect(requests[3][0].searchParams.get("mobi")).toBe("1");
    const [playback, init] = requests[4];
    expect(playback.origin).toBe("https://bd-api.kuwo.cn");
    expect(playback.searchParams.get("musicId")).toBe("212");
    expect(playback.searchParams.get("sign")).toMatch(/^[a-f0-9]{32}$/);
    expect(init?.headers).toEqual({
      plat: "ar", channel: "aliopen", devid: expect.any(String), ver: "3.9.0",
    });
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
    vi.mocked(netease.getOpenPlayableUrl).mockResolvedValue(neteasePlayback("found-url"));

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

    expect(netease.getOpenPlayableUrl).not.toHaveBeenCalled();
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
    vi.mocked(netease.getOpenPlayableUrl).mockRejectedValue(new Error("source 502"));

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
