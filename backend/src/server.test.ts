import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

vi.mock("./db.js");
vi.mock("./pipeline.js");
vi.mock("./claude.js");
vi.mock("./tts.js");
vi.mock("./netease.js");
vi.mock("./taste-profile.js");
vi.mock("./weather.js");

const originalUnblockEnabled = process.env.UNBLOCK_NETEASE_ENABLED;
const originalLocalEnabled = process.env.LOCAL_MUSIC_ENABLED;
const originalLocalDirs = process.env.LOCAL_MUSIC_DIRS;
let tempDirs: string[] = [];

async function createTempMusicFile(filename: string, contents = "fake audio"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claudio-server-local-music-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
  return filePath;
}

describe("API Server", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.UNBLOCK_NETEASE_ENABLED = "false";
    delete process.env.LOCAL_MUSIC_ENABLED;
    delete process.env.LOCAL_MUSIC_DIRS;
    const musicSources = await import("./music-sources/index.js");
    musicSources.clearLocalLibraryCacheForTests();
    const { startServer } = await import("./server.js");
    server = startServer(0);
    await new Promise<void>((resolve) => server.on("listening", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalUnblockEnabled === undefined) {
      delete process.env.UNBLOCK_NETEASE_ENABLED;
    } else {
      process.env.UNBLOCK_NETEASE_ENABLED = originalUnblockEnabled;
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
    const musicSources = await import("./music-sources/index.js");
    musicSources.clearLocalLibraryCacheForTests();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("GET /api/health 返回 200", async () => {
    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("number");
  });

  it("GET /api/weather/current 返回实时天气", async () => {
    const weather = await import("./weather.js");
    vi.mocked(weather.getCurrentWeather).mockResolvedValue({
      source: "openweather",
      fetchedAt: Date.now(),
      location: { name: "Hong Kong", country: "HK", lat: 22.3, lon: 114.2 },
      weather: { description: "多云", icon: "03d" },
      temperature: { actual: 28, feelsLike: 31, min: 27, max: 29, unit: "°C" },
      wind: { speed: 4.1, unit: "m/s" },
      humidity: 82,
      pressure: 1007,
      precipitation: { unit: "mm" },
      observedAt: Date.now(),
      timezoneOffset: 28800,
    });

    const res = await fetch(`http://localhost:${port}/api/weather/current?city=Hong%20Kong&units=metric`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.location.name).toBe("Hong Kong");
    expect(body.weather.description).toBe("多云");
    expect(weather.getCurrentWeather).toHaveBeenCalledWith(expect.objectContaining({
      city: "Hong Kong",
      units: "metric",
    }));
  });

  it("GET /api/weather/current 拒绝无效经纬度", async () => {
    const res = await fetch(`http://localhost:${port}/api/weather/current?lat=abc&lon=114.2`);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("lat and lon");
  });

  it("POST /api/pipeline/trigger 正确调用 pipeline", async () => {
    const pipeline = await import("./pipeline.js");
    const mockResult = { status: "success" as const, djMessage: "Hello", tracks: [], reason: "test" };
    vi.mocked(pipeline.runPipeline).mockResolvedValue(mockResult);

    const res = await fetch(`http://localhost:${port}/api/pipeline/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "morning_brief" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("success");
    expect(pipeline.runPipeline).toHaveBeenCalledWith("morning_brief");
  });

  it("POST /api/pipeline/trigger 拒绝无效 mode", async () => {
    const res = await fetch(`http://localhost:${port}/api/pipeline/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "invalid" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/audio/local/:sourceTrackId 返回本地音频文件", async () => {
    const musicSources = await import("./music-sources/index.js");
    const filePath = await createTempMusicFile("Local API Artist - Local API Song.wav", "local wav body");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(filePath);
    musicSources.clearLocalLibraryCacheForTests();

    const track = await musicSources.resolveTrack(
      "Local API Song",
      "Local API Artist",
      musicSources.LOCAL_LIBRARY_SOURCE_ID,
    );
    expect(track?.sourceTrackId).toMatch(/^local_/);

    const res = await fetch(
      `http://localhost:${port}/api/audio/local/${encodeURIComponent(track!.sourceTrackId)}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/wav");
    expect(await res.text()).toBe("local wav body");
  });

  it("GET/POST /api/music-sources/local-library 返回状态并支持重扫", async () => {
    const musicSources = await import("./music-sources/index.js");
    const firstFilePath = await createTempMusicFile("Scan Artist - First Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(firstFilePath);
    musicSources.clearLocalLibraryCacheForTests();

    const initialRes = await fetch(`http://localhost:${port}/api/music-sources/local-library`);
    expect(initialRes.status).toBe(200);
    const initialBody = await initialRes.json() as { trackCount: number; sampleTracks: unknown[] };
    expect(initialBody.trackCount).toBe(1);
    expect(initialBody.sampleTracks).toHaveLength(1);

    await fs.writeFile(path.join(path.dirname(firstFilePath), "Scan Artist - Second Song.mp3"), "new audio");
    const rescanRes = await fetch(`http://localhost:${port}/api/music-sources/local-library/rescan`, {
      method: "POST",
    });

    expect(rescanRes.status).toBe(200);
    const rescanBody = await rescanRes.json() as { trackCount: number; sampleTracks: Array<{ title: string }> };
    expect(rescanBody.trackCount).toBe(2);
    expect(rescanBody.sampleTracks.map((track) => track.title)).toContain("Second Song");
    expect(JSON.stringify(rescanBody)).not.toContain(path.dirname(firstFilePath));
  });

  it("GET /api/music-sources 返回主源备用源运行摘要", async () => {
    const musicSources = await import("./music-sources/index.js");
    const firstFilePath = await createTempMusicFile("Source Artist - Source Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(firstFilePath);
    process.env.UNBLOCK_NETEASE_ENABLED = "true";
    musicSources.clearLocalLibraryCacheForTests();

    const res = await fetch(`http://localhost:${port}/api/music-sources`);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      searchOrder: string[];
      playableUrlFallbacks: Array<{ source: string; fallbacks: string[] }>;
      sources: Array<{ source: string; role: string; enabled: boolean; ok: boolean }>;
    };
    expect(body.searchOrder).toEqual(["local_library", "netease_legacy"]);
    expect(body.playableUrlFallbacks).toEqual([
      { source: "netease_legacy", fallbacks: ["unblock_netease"] },
    ]);
    expect(body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "local_library", role: "library", enabled: true, ok: true }),
      expect.objectContaining({ source: "netease_legacy", role: "primary", enabled: true, ok: true }),
      expect.objectContaining({ source: "unblock_netease", role: "fallback", enabled: true, ok: true }),
    ]));
    expect(JSON.stringify(body)).not.toContain(path.dirname(firstFilePath));
  });

  it("GET /api/music-sources/local-library/matches 返回本地曲库口味命中率", async () => {
    const musicSources = await import("./music-sources/index.js");
    const tasteProfile = await import("./taste-profile.js");
    const firstFilePath = await createTempMusicFile("Match Artist - Match Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(firstFilePath);
    musicSources.clearLocalLibraryCacheForTests();
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue({
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

    const res = await fetch(`http://localhost:${port}/api/music-sources/local-library/matches`);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      targetCount: number;
      matchedCount: number;
      coveragePercent: number;
      samples: Array<{ title: string; matched: boolean; localTrack?: { title: string } }>;
    };
    expect(body.targetCount).toBe(2);
    expect(body.matchedCount).toBe(1);
    expect(body.coveragePercent).toBe(50);
    expect(body.samples[0]).toMatchObject({
      title: "Match Song",
      matched: true,
      localTrack: { title: "Match Song" },
    });
    expect(JSON.stringify(body)).not.toContain(path.dirname(firstFilePath));
  });

  it("POST /api/netease/sync 同步并保存网易云歌单快照", async () => {
    const netease = await import("./netease.js");
    const db = await import("./db.js");
    const tasteProfile = await import("./taste-profile.js");

    vi.mocked(netease.getUserAccount).mockResolvedValue({
      userId: 123,
      nickname: "tester",
      avatarUrl: "https://example.com/avatar.jpg",
    });
    vi.mocked(netease.getUserPlaylists).mockResolvedValue([
      {
        tracks: [],
        id: 1,
        name: "我的歌单",
        trackCount: 10,
        playCount: 20,
        coverImgUrl: "https://example.com/cover.jpg",
        creator: { nickname: "tester", userId: 123 },
      },
    ]);
    vi.mocked(netease.getPlaylistTracks).mockResolvedValue([
      { id: 101, name: "Song A", artist: "Artist A", album: "Album A" },
    ]);
    vi.mocked(tasteProfile.rebuildTasteProfileFromSnapshot).mockResolvedValue({
      generatedAt: 1,
      sourceSyncedAt: 1,
      playlistCount: 1,
      totalTrackCount: 1,
      uniqueTrackCount: 1,
      uniqueArtistCount: 1,
      uniqueAlbumCount: 1,
      languageMix: { chinese: 0, latin: 1, mixed: 0, other: 0 },
      topArtists: [],
      topAlbums: [],
      topTracks: [],
      titleKeywords: [],
      artistKeywords: [],
      playlistFingerprints: [],
      summary: "ok",
    });

    const res = await fetch(`http://localhost:${port}/api/netease/sync`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.playlistCount).toBe(1);
    expect(body.totalTrackCount).toBe(1);
    expect(body.tasteProfile.uniqueArtistCount).toBe(1);
    expect(vi.mocked(db.setNeteaseSnapshot).mock.calls[0]?.[0]).toMatchObject({
      account: { nickname: "tester" },
      playlists: [
        {
          name: "我的歌单",
          tracks: [{ name: "Song A" }],
        },
      ],
    });
  });

  it("POST /api/netease/retry-failed 重试空曲目歌单", async () => {
    const db = await import("./db.js");
    const netease = await import("./netease.js");
    const tasteProfile = await import("./taste-profile.js");

    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue({
      account: { userId: 123, nickname: "tester", avatarUrl: "x" },
      playlists: [
        {
          id: 1,
          name: "失败歌单",
          trackCount: 2,
          playCount: 0,
          coverImgUrl: "",
          creator: { nickname: "tester", userId: 123 },
          tracks: [],
        },
      ],
      syncedAt: 1,
    } as any);
    vi.mocked(netease.getPlaylistTracks).mockResolvedValue([
      { id: 1, name: "Song A", artist: "Artist A", album: "Album A" },
      { id: 2, name: "Song B", artist: "Artist B", album: "Album B" },
    ]);
    vi.mocked(tasteProfile.rebuildTasteProfileFromSnapshot).mockResolvedValue({
      generatedAt: 2,
      sourceSyncedAt: 2,
      playlistCount: 1,
      totalTrackCount: 2,
      uniqueTrackCount: 2,
      uniqueArtistCount: 2,
      uniqueAlbumCount: 2,
      languageMix: { chinese: 0, latin: 2, mixed: 0, other: 0 },
      topArtists: [],
      topAlbums: [],
      topTracks: [],
      titleKeywords: [],
      artistKeywords: [],
      playlistFingerprints: [],
      summary: "ok",
    });

    const res = await fetch(`http://localhost:${port}/api/netease/retry-failed`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.retriedCount).toBe(1);
    expect(body.recoveredCount).toBe(1);
  });

  it("GET /api/radio/program-audit 返回当前节目体验审计", async () => {
    const db = await import("./db.js");
    const tracks = Array.from({ length: 5 }, (_, index) => ({
      id: `track-${index + 1}`,
      name: `Song ${index + 1}`,
      artist: `Artist ${index + 1}`,
      url: `/audio/${index + 1}.mp3`,
      duration: 240000,
    }));
    vi.mocked(db.getState).mockResolvedValue({
      status: "playing",
      currentTrack: tracks[0],
      radioQueue: tracks,
      currentQueueIndex: 0,
      currentProgram: {
        source: "startup",
        title: "Audit Set",
        mood: "steady",
        summary: "A restrained long-form set.",
        plannedMinutes: 20,
        speechPlan: [
          { beforeTrackIndex: 0, type: "intro", note: "开场" },
          { beforeTrackIndex: 2, type: "short_say", note: "短讲" },
          { beforeTrackIndex: 4, type: "bumper", note: "station ID" },
        ],
        generatedAt: 1,
      },
      chatHistory: [
        { role: "dj", text: "今晚先把这一段慢慢铺开。", timestamp: 1 },
        { role: "dj", text: "下一首把情绪再往里收一点。", timestamp: 2 },
      ],
      playHistory: [],
      listenChecks: [],
      djProfile: { voice: "冰糖", style: "情感电台", name: "Claudio" },
      playlists: [],
      neteaseSnapshot: null,
      favorites: [],
      lastInteraction: 1,
    });

    const res = await fetch(`http://localhost:${port}/api/radio/program-audit`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.trackCount).toBe(5);
    expect(body.plannedMinutes).toBe(20);
    expect(body.checks.map((check: { id: string }) => check.id)).toContain("speech_cadence");
  });

  it("GET/POST /api/radio/listen-checks 保存并返回长时实听记录", async () => {
    const db = await import("./db.js");
    const tracks = Array.from({ length: 6 }, (_, index) => ({
      id: `track-${index + 1}`,
      name: `Song ${index + 1}`,
      artist: `Artist ${index + 1}`,
      url: `/audio/${index + 1}.mp3`,
      duration: 240000,
      source: "local_library",
    }));
    vi.mocked(db.getState).mockResolvedValue({
      status: "playing",
      currentTrack: tracks[0],
      radioQueue: tracks,
      currentQueueIndex: 0,
      currentProgram: {
        source: "startup",
        sessionId: "startup_test",
        title: "Night Flow",
        mood: "quiet",
        summary: "A restrained long-form set.",
        plannedMinutes: 24,
        speechPlan: [
          { beforeTrackIndex: 0, type: "intro", note: "开场" },
          { beforeTrackIndex: 2, type: "short_say", note: "短讲" },
          { beforeTrackIndex: 5, type: "bumper", note: "station ID" },
        ],
        generatedAt: 1,
      },
      chatHistory: [
        { role: "dj", text: "今晚先把这一段慢慢铺开。", timestamp: 1 },
      ],
      playHistory: [],
      listenChecks: [],
      djProfile: { voice: "冰糖", style: "情感电台", name: "Claudio" },
      playlists: [],
      neteaseSnapshot: null,
      favorites: [],
      lastInteraction: 1,
    });
    const record = {
      id: "listen_test",
      startedAt: 1,
      completedAt: 1_200_001,
      durationMs: 1_200_000,
      playbackMs: 1_200_000,
      playbackSegments: [
        { trackId: "track-1", title: "Song 1", artist: "Artist 1", playedMs: 1_200_000 },
      ],
      checks: { program: true, dj: true, context: true },
      note: "No repeated greetings.",
      needsFollowUp: false,
      programAudit: {
        ok: true,
        plannedMinutes: 24,
        trackCount: 6,
        speechSlotCount: 3,
        issueCount: 0,
      },
      programContinuity: {
        ok: true,
        startedSessionId: "startup_test",
        completedSessionId: "startup_test",
        startedGeneratedAt: 1,
        completedGeneratedAt: 1,
      },
      programSnapshot: {
        sessionId: "startup_test",
        title: "Night Flow",
        mood: "quiet",
        source: "startup",
        generatedAt: 1,
        currentQueueIndex: 0,
        tracks: [
          { id: "track-1", name: "Song A", artist: "Artist A", source: "local_library", duration: 240000 },
        ],
      },
      recordedAt: 1_200_002,
    };
    vi.mocked(db.addListenCheckRecord).mockResolvedValue(record);
    vi.mocked(db.getListenCheckRecords).mockResolvedValue([record]);

    const postRes = await fetch(`http://localhost:${port}/api/radio/listen-checks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        playbackMs: record.playbackMs,
        playbackSegments: [
          { trackId: "track-1", title: "Song 1", artist: "Artist 1", playedMs: 1_300_000 },
        ],
        checks: record.checks,
        note: record.note,
        needsFollowUp: record.needsFollowUp,
        programAudit: {
          ok: false,
          plannedMinutes: 1,
          trackCount: 1,
          speechSlotCount: 99,
          issueCount: 99,
        },
        startedProgram: {
          sessionId: "startup_test",
          generatedAt: 1,
        },
      }),
    });

    expect(postRes.status).toBe(201);
    expect(await postRes.json()).toMatchObject({ id: "listen_test" });
    expect(db.addListenCheckRecord).toHaveBeenCalledWith(expect.objectContaining({
      durationMs: 1_200_000,
      playbackMs: 1_200_000,
      playbackSegments: [
        { trackId: "track-1", title: "Song 1", artist: "Artist 1", playedMs: 1_200_000 },
      ],
      checks: { program: true, dj: true, context: true },
      note: "No repeated greetings.",
      needsFollowUp: false,
      programAudit: {
        ok: true,
        plannedMinutes: 24,
        trackCount: 6,
        speechSlotCount: 3,
        issueCount: 0,
      },
      programContinuity: {
        ok: true,
        startedSessionId: "startup_test",
        completedSessionId: "startup_test",
        startedGeneratedAt: 1,
        completedGeneratedAt: 1,
      },
      programSnapshot: expect.objectContaining({
        currentQueueIndex: 0,
        tracks: expect.any(Array),
      }),
    }));

    const getRes = await fetch(`http://localhost:${port}/api/radio/listen-checks?limit=5`);

    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toHaveLength(1);
    expect(db.getListenCheckRecords).toHaveBeenCalledWith(5);
  });

  it("GET /api/radio/listen-acceptance 汇总最终实听验收证据", async () => {
    const db = await import("./db.js");
    vi.mocked(db.getListenCheckRecords).mockResolvedValue([{
      id: "listen_ready",
      startedAt: 1,
      completedAt: 1_200_001,
      durationMs: 1_200_000,
      playbackMs: 1_200_000,
      playbackSegments: [
        { trackId: "track-1", title: "Song 1", artist: "Artist 1", playedMs: 1_200_000 },
      ],
      checks: { program: true, dj: true, context: true },
      note: "Clean long listen.",
      needsFollowUp: false,
      programAudit: {
        ok: true,
        plannedMinutes: 24,
        trackCount: 6,
        speechSlotCount: 3,
        issueCount: 0,
      },
      programContinuity: {
        ok: true,
        startedSessionId: "startup_test",
        completedSessionId: "startup_test",
        startedGeneratedAt: 1,
        completedGeneratedAt: 1,
      },
      recordedAt: 1_200_002,
    }]);

    const res = await fetch(`http://localhost:${port}/api/radio/listen-acceptance`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.criteria).toHaveLength(3);
    expect(body.criteria.every((criterion: { passed: boolean }) => criterion.passed)).toBe(true);
    expect(db.getListenCheckRecords).toHaveBeenCalledWith(20);
  });
});

describe("WebSocket Server", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.UNBLOCK_NETEASE_ENABLED = "false";
    const { startServer } = await import("./server.js");
    server = startServer(0);
    await new Promise<void>((resolve) => server.on("listening", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalUnblockEnabled === undefined) {
      delete process.env.UNBLOCK_NETEASE_ENABLED;
    } else {
      process.env.UNBLOCK_NETEASE_ENABLED = originalUnblockEnabled;
    }
  });

  it("连接并接收初始状态消息", async () => {
    const db = await import("./db.js");
    const mockState = { status: "idle", currentTrack: null, chatHistory: [], djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" }, lastInteraction: Date.now() };
    vi.mocked(db.getState).mockResolvedValue(mockState);

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    const message: unknown = await new Promise((resolve) => {
      ws.on("message", (data) => resolve(JSON.parse(data.toString())));
    });

    expect(message).toMatchObject({ type: "state" });
    ws.close();
  });

  it("trigger 消息触发 pipeline 并广播状态更新", async () => {
    const pipeline = await import("./pipeline.js");
    const mockResult = {
      status: "success" as const,
      djMessage: "DJ 向你问候",
      ttsAudioPath: "audio/tts/test.wav",
      tracks: [{ id: 1, name: "Song", artist: "Artist", url: "url", picUrl: "pic", duration: 100 }],
      reason: "test reason",
    };
    vi.mocked(pipeline.runPipeline).mockResolvedValue(mockResult);

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const messages: unknown[] = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    ws.send(JSON.stringify({ type: "trigger", mode: "mood_pick" }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error(`超时: 收到 ${messages.length} 条消息`));
      }, 3000);
      const check = setInterval(() => {
        if (messages.length >= 2) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    const hasThinking = messages.some(
      (m: Record<string, unknown>) => m.type === "status" && m.data === "thinking"
    );
    expect(hasThinking).toBe(true);

    ws.close();
  });

  it("chat 消息会返回带 TTS 的 DJ 回复", async () => {
    const db = await import("./db.js");
    const claude = await import("./claude.js");
    const netease = await import("./netease.js");
    const tts = await import("./tts.js");
    const weather = await import("./weather.js");

    const mockState = {
      status: "idle",
      currentTrack: null,
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
    };

    vi.mocked(db.getState).mockResolvedValue(mockState as any);
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      action: "reply_only",
      say: "你好呀，今晚想听什么？",
      ttsText: "（轻声）你好呀，今晚想听什么？",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/chat.wav",
    });

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const messages: Array<Record<string, any>> = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    ws.send(JSON.stringify({ type: "chat", data: { text: "hi" } }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for dj_message")), 3000);
      const check = setInterval(() => {
        if (messages.some((m) => m.type === "dj_message")) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    expect(messages.some((m) => m.type === "chat" && m.data?.role === "user" && m.data?.text === "hi")).toBe(true);
    expect(messages.some((m) => m.type === "dj_message" && m.data?.ttsAudioPath === "data/audio/chat.wav")).toBe(true);
    expect(claude.callJsonLLM).toHaveBeenCalledWith(
      expect.stringContaining('action: "reply_only"'),
      20_000,
    );
    expect(weather.getDefaultWeatherPromptContext).not.toHaveBeenCalled();

    ws.close();
  });

  it("chat 里明确问天气时才会调用天气并回答天气", async () => {
    const db = await import("./db.js");
    const claude = await import("./claude.js");
    const netease = await import("./netease.js");
    const tts = await import("./tts.js");
    const weather = await import("./weather.js");

    vi.mocked(db.getState).mockResolvedValue({
      status: "idle",
      currentTrack: null,
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
    } as any);
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("Panyu, CN当前天气多云，气温29°C，体感33°C，湿度79%");
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      action: "answer_weather",
      say: "现在番禺多云，气温 29 度，体感会更热一点，出门可以穿轻薄些。",
      ttsText: "现在番禺多云，气温 29 度，体感会更热一点，出门可以穿轻薄些。",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/weather-chat.wav",
    });

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const messages: Array<Record<string, any>> = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    ws.send(JSON.stringify({ type: "chat", data: { text: "天气怎么样" } }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for weather reply")), 3000);
      const check = setInterval(() => {
        if (messages.some((m) => m.type === "dj_message" && m.data?.ttsAudioPath === "data/audio/weather-chat.wav")) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    expect(weather.getDefaultWeatherPromptContext).toHaveBeenCalled();
    expect(claude.callJsonLLM).toHaveBeenCalledWith(
      expect.stringContaining('action: "answer_weather"'),
      20_000,
    );
    expect(String(vi.mocked(claude.callJsonLLM).mock.calls[0]?.[0] ?? "")).toContain("Panyu, CN当前天气多云");

    ws.close();
  });

  it("chat 里问推荐原因时不会携带天气上下文", async () => {
    const db = await import("./db.js");
    const claude = await import("./claude.js");
    const tts = await import("./tts.js");
    const weather = await import("./weather.js");

    vi.mocked(db.getState).mockResolvedValue({
      status: "playing",
      currentTrack: { id: "1", name: "Song A", artist: "Artist A", url: "url-a" },
      radioQueue: [],
      currentQueueIndex: 0,
      currentProgram: { source: "startup", generatedAt: 1, title: "夜间节目", summary: "想让氛围慢慢安静下来。" },
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
      playlists: [],
    } as any);
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      action: "reply_only",
      say: "这首接在这里，是想让刚才的情绪慢慢落下来，不急着把节奏推高。",
      ttsText: "这首接在这里，是想让刚才的情绪慢慢落下来，不急着把节奏推高。",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/reason-chat.wav",
    });

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({ type: "chat", data: { text: "这首为什么推荐" } }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for reason reply")), 3000);
      const check = setInterval(() => {
        if (vi.mocked(claude.callJsonLLM).mock.calls.length > 0) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    const prompt = String(vi.mocked(claude.callJsonLLM).mock.calls[0]?.[0] ?? "");
    expect(prompt).toContain("recommendation_reason");
    expect(prompt).toContain('action: "reply_only"');
    expect(weather.getDefaultWeatherPromptContext).not.toHaveBeenCalled();

    ws.close();
  });

  it("Dean 音色下 chat 提示词会要求英文回复", async () => {
    const db = await import("./db.js");
    const claude = await import("./claude.js");
    const tts = await import("./tts.js");
    const weather = await import("./weather.js");

    vi.mocked(db.getState).mockResolvedValue({
      status: "idle",
      currentTrack: null,
      chatHistory: [],
      djProfile: { voice: "Dean", style: "late-night radio", name: "Claudio" },
      lastInteraction: Date.now(),
    } as any);
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      action: "reply_only",
      say: "Stay with me for a second and tell me what kind of night you're having.",
      ttsText: "(softly) Stay with me for a second and tell me what kind of night you're having.",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/dean-chat.wav",
    });

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({ type: "chat", data: { text: "talk to me" } }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for Dean prompt")), 3000);
      const check = setInterval(() => {
        if (vi.mocked(claude.callJsonLLM).mock.calls.length > 0) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    const prompt = String(vi.mocked(claude.callJsonLLM).mock.calls[0]?.[0] ?? "");
    expect(prompt).toContain("natural English");
    expect(prompt).toContain('action: "reply_only"');
    expect(prompt).not.toContain("中文 30-80 字");
    expect(weather.getDefaultWeatherPromptContext).not.toHaveBeenCalled();

    ws.close();
  });

  it("chat 里的推荐请求会触发 random_discover 管线", async () => {
    const db = await import("./db.js");
    const pipeline = await import("./pipeline.js");

    const mockState = {
      status: "idle",
      currentTrack: null,
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
    };

    vi.mocked(db.getState).mockResolvedValue(mockState as any);
    vi.mocked(pipeline.runPipeline).mockResolvedValue({
      status: "success",
      djMessage: "给你来一首适合今晚的歌。",
      ttsAudioPath: "data/audio/reco.wav",
      tracks: [{ id: 1, name: "Song", artist: "Artist", url: "url", picUrl: "pic", duration: 100 }],
      reason: "test",
    });

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({ type: "chat", data: { text: "帮我随机推荐一首歌" } }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for pipeline call")), 3000);
      const check = setInterval(() => {
        if (vi.mocked(pipeline.runPipeline).mock.calls.length > 0) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    expect(pipeline.runPipeline).toHaveBeenCalledWith("random_discover");

    ws.close();
  });

  it("chat 里的下一首请求会切到队列下一首", async () => {
    const db = await import("./db.js");
    const claude = await import("./claude.js");
    const netease = await import("./netease.js");
    const tts = await import("./tts.js");
    const weather = await import("./weather.js");

    vi.mocked(db.getState).mockResolvedValue({
      status: "playing",
      currentTrack: { id: "1", name: "Song A", artist: "Artist A", url: "url-a" },
      radioQueue: [],
      currentQueueIndex: 0,
      currentProgram: null,
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
      playlists: [],
    } as any);
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("Panyu, CN当前天气多云");
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      say: "那我们切到 Song B，让情绪顺着往下走。",
      ttsText: "（轻声）那我们切到 Song B，让情绪顺着往下走。",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/segue.wav",
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (trackId: number) => (
      trackId === 2 ? "url-b" : "url-a"
    ));
    vi.mocked(db.advanceRadioQueue).mockResolvedValue({
      status: "playing",
      currentTrack: { id: "2", name: "Song B", artist: "Artist B", url: "url-b", duration: 100, picUrl: "pic-b" },
      radioQueue: [],
      currentQueueIndex: 1,
      currentProgram: null,
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
      playlists: [],
    } as any);

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const messages: Array<Record<string, any>> = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    ws.send(JSON.stringify({ type: "chat", data: { text: "下一首" } }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for track")), 3000);
      const check = setInterval(() => {
        if (messages.some((m) => m.type === "track" && m.data?.name === "Song B")) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    expect(db.advanceRadioQueue).toHaveBeenCalled();
    expect(messages.some((m) => m.type === "dj_message" && String(m.data?.text).includes("Song B"))).toBe(true);
    expect(messages.some((m) => m.type === "track" && m.data?.name === "Song B")).toBe(true);

    ws.close();
  });

  it("会在 queue_prefetch 时提前缓存下一首链接和串场，并在切歌时复用", async () => {
    const db = await import("./db.js");
    const claude = await import("./claude.js");
    const tts = await import("./tts.js");
    const weather = await import("./weather.js");
    const netease = await import("./netease.js");

    const trackA = { id: "1", name: "Song A", artist: "Artist A", url: "url-a", duration: 100, picUrl: "pic-a" };
    const trackB = { id: "2", name: "Song B", artist: "Artist B", url: "url-b", duration: 100, picUrl: "pic-b" };
    let currentState = {
      status: "playing",
      currentTrack: trackA,
      radioQueue: [trackA, trackB],
      currentQueueIndex: 0,
      currentProgram: {
        source: "startup",
        generatedAt: 1,
        title: "Night Flow",
        summary: "smooth transition",
        speechPlan: [{ beforeTrackIndex: 1, type: "short_say", note: "接到下一首" }],
      },
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
      playlists: [],
    } as any;

    vi.mocked(db.getState).mockImplementation(async () => currentState);
    vi.mocked(db.updateState).mockImplementation(async (patch: any) => {
      currentState = {
        ...currentState,
        ...patch,
        radioQueue: patch.radioQueue ?? currentState.radioQueue,
        currentTrack: patch.currentTrack ?? currentState.currentTrack,
      };
      return currentState;
    });
    vi.mocked(db.advanceRadioQueue).mockImplementation(async () => {
      currentState = {
        ...currentState,
        currentQueueIndex: 1,
        currentTrack: trackB,
      };
      return currentState;
    });
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("Panyu, CN当前天气多云");
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      say: "马上接 Song B，让气氛自然落下来。",
      ttsText: "（轻声）马上接 Song B，让气氛自然落下来。",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/prefetch-segue.wav",
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (trackId: number) => (
      trackId === 1 ? "url-a" : "url-b-fresh"
    ));

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const messages: Array<Record<string, any>> = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    ws.send(JSON.stringify({ type: "queue_prefetch" }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for prefetch")), 3000);
      const check = setInterval(() => {
        if (vi.mocked(claude.callJsonLLM).mock.calls.length > 0 && vi.mocked(tts.speak).mock.calls.length > 0) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    ws.send(JSON.stringify({ type: "queue_next" }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for prefetched track")), 3000);
      const check = setInterval(() => {
        if (messages.some((m) => m.type === "track" && m.data?.name === "Song B" && m.data?.url === "url-b-fresh")) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    expect(vi.mocked(netease.getPlayableUrl).mock.calls).toEqual([
      [1, { forceRefresh: true }],
      [2, { forceRefresh: true }],
    ]);
    expect(claude.callJsonLLM).toHaveBeenCalledTimes(1);
    expect(tts.speak).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.type === "dj_message" && String(m.data?.text).includes("Song B"))).toBe(true);

    ws.close();
  });

  it("queue_prefetch 会刷新后续 2 到 3 首的播放链接", async () => {
    const db = await import("./db.js");
    const claude = await import("./claude.js");
    const tts = await import("./tts.js");
    const netease = await import("./netease.js");

    const trackA = { id: "1", name: "Song A", artist: "Artist A", url: "url-a", duration: 100, picUrl: "pic-a" };
    const trackB = { id: "2", name: "Song B", artist: "Artist B", url: "url-b", duration: 100, picUrl: "pic-b" };
    const trackC = { id: "3", name: "Song C", artist: "Artist C", url: "url-c", duration: 100, picUrl: "pic-c" };
    const trackD = { id: "4", name: "Song D", artist: "Artist D", url: "url-d", duration: 100, picUrl: "pic-d" };
    let currentState = {
      status: "playing",
      currentTrack: trackA,
      radioQueue: [trackA, trackB, trackC, trackD],
      currentQueueIndex: 0,
      currentProgram: { source: "startup", sessionId: "startup_test", generatedAt: 1, title: "Night Flow", summary: "smooth transition" },
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
      playlists: [],
    } as any;

    vi.mocked(db.getState).mockImplementation(async () => currentState);
    vi.mocked(db.updateState).mockImplementation(async (patch: any) => {
      currentState = {
        ...currentState,
        ...patch,
        radioQueue: patch.radioQueue ?? currentState.radioQueue,
        currentTrack: patch.currentTrack ?? currentState.currentTrack,
        currentProgram: patch.currentProgram ?? currentState.currentProgram,
      };
      return currentState;
    });
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      say: "马上接 Song B，让气氛自然落下来。",
      ttsText: "马上接 Song B，让气氛自然落下来。",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/prefetch-window.wav",
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (trackId: number) => `url-${trackId}-fresh`);

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({ type: "queue_prefetch" }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for prefetch window")), 3000);
      const check = setInterval(() => {
        if (
          vi.mocked(netease.getPlayableUrl).mock.calls.length >= 4
          && currentState.currentProgram?.preparedUntilIndex === 3
        ) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    expect(vi.mocked(netease.getPlayableUrl).mock.calls).toEqual(expect.arrayContaining([
      [2, { forceRefresh: true }],
      [3, { forceRefresh: true }],
      [4, { forceRefresh: true }],
    ]));
    expect(currentState.radioQueue[1].url).toBe("url-2-fresh");
    expect(currentState.radioQueue[2].url).toBe("url-3-fresh");
    expect(currentState.radioQueue[3].url).toBe("url-4-fresh");
    expect(currentState.currentProgram.preparedUntilIndex).toBe(3);
    expect(claude.callJsonLLM).not.toHaveBeenCalled();

    ws.close();
  });

  it("节目没有 speechPlan 发言点时，切歌不生成 DJ 串场", async () => {
    const db = await import("./db.js");
    const claude = await import("./claude.js");
    const tts = await import("./tts.js");
    const netease = await import("./netease.js");

    const trackA = { id: "1", name: "Song A", artist: "Artist A", url: "url-a", duration: 100, picUrl: "pic-a" };
    const trackB = { id: "2", name: "Song B", artist: "Artist B", url: "url-b", duration: 100, picUrl: "pic-b" };
    let currentState = {
      status: "playing",
      currentTrack: trackA,
      radioQueue: [trackA, trackB],
      currentQueueIndex: 0,
      currentProgram: {
        source: "startup",
        generatedAt: 1,
        title: "Night Flow",
        speechPlan: [{ beforeTrackIndex: 0, type: "intro", note: "开场已说过" }],
      },
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
      playlists: [],
    } as any;

    vi.mocked(db.getState).mockImplementation(async () => currentState);
    vi.mocked(db.updateState).mockImplementation(async (patch: any) => {
      currentState = {
        ...currentState,
        ...patch,
        radioQueue: patch.radioQueue ?? currentState.radioQueue,
        currentTrack: patch.currentTrack ?? currentState.currentTrack,
      };
      return currentState;
    });
    vi.mocked(db.advanceRadioQueue).mockImplementation(async () => {
      currentState = {
        ...currentState,
        currentQueueIndex: 1,
        currentTrack: trackB,
      };
      return currentState;
    });
    vi.mocked(netease.getPlayableUrl).mockResolvedValue("url-b-fresh");

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const messages: Array<Record<string, any>> = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    ws.send(JSON.stringify({ type: "queue_next" }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for track without segue")), 3000);
      const check = setInterval(() => {
        if (messages.some((m) => m.type === "track" && m.data?.name === "Song B")) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    expect(claude.callJsonLLM).not.toHaveBeenCalled();
    expect(tts.speak).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === "dj_message")).toBe(false);

    ws.close();
  });

  it("bumper 发言点使用 station ID，不额外调用 LLM", async () => {
    const db = await import("./db.js");
    const claude = await import("./claude.js");
    const tts = await import("./tts.js");
    const netease = await import("./netease.js");

    const trackA = { id: "1", name: "Song A", artist: "Artist A", url: "url-a", duration: 100, picUrl: "pic-a" };
    const trackB = { id: "2", name: "Song B", artist: "Artist B", url: "url-b", duration: 100, picUrl: "pic-b" };
    let currentState = {
      status: "playing",
      currentTrack: trackA,
      radioQueue: [trackA, trackB],
      currentQueueIndex: 0,
      currentProgram: {
        source: "startup",
        generatedAt: 1,
        title: "Night Flow",
        mood: "夜间",
        speechPlan: [{ beforeTrackIndex: 1, type: "bumper", note: "轻量 station ID" }],
      },
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
      playlists: [],
    } as any;

    vi.mocked(db.getState).mockImplementation(async () => currentState);
    vi.mocked(db.updateState).mockImplementation(async (patch: any) => {
      currentState = {
        ...currentState,
        ...patch,
        radioQueue: patch.radioQueue ?? currentState.radioQueue,
        currentTrack: patch.currentTrack ?? currentState.currentTrack,
      };
      return currentState;
    });
    vi.mocked(db.advanceRadioQueue).mockImplementation(async () => {
      currentState = {
        ...currentState,
        currentQueueIndex: 1,
        currentTrack: trackB,
      };
      return currentState;
    });
    vi.mocked(netease.getPlayableUrl).mockResolvedValue("url-b-fresh");
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/bumper.wav",
    });

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const messages: Array<Record<string, any>> = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    ws.send(JSON.stringify({ type: "queue_next" }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for bumper")), 3000);
      const check = setInterval(() => {
        if (messages.some((m) => m.type === "dj_message" && String(m.data?.text).includes("Claudio FM"))) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    expect(claude.callJsonLLM).not.toHaveBeenCalled();
    expect(tts.speak).toHaveBeenCalledWith(
      expect.stringContaining("Claudio FM"),
      expect.objectContaining({ scene: "segue" }),
    );

    ws.close();
  });

  it("20 分钟控制节目连续切歌时保持审计通过且不重复开场", async () => {
    const db = await import("./db.js");
    const claude = await import("./claude.js");
    const tts = await import("./tts.js");
    const netease = await import("./netease.js");

    const tracks = Array.from({ length: 6 }, (_, index) => ({
      id: String(index + 1),
      name: `Program Song ${index + 1}`,
      artist: `Program Artist ${index + 1}`,
      url: `url-${index + 1}`,
      picUrl: `pic-${index + 1}`,
      duration: 240000,
      source: "netease_legacy",
      sourceTrackId: String(index + 1),
      urlSource: "netease_legacy",
    }));
    let currentState = {
      status: "playing",
      currentTrack: tracks[0],
      radioQueue: tracks,
      currentQueueIndex: 0,
      currentProgram: {
        source: "startup",
        sessionId: "startup_long_program",
        generatedAt: 1,
        title: "Long Program Validation",
        mood: "steady night flow",
        summary: "A controlled long-form program for runtime validation.",
        plannedMinutes: 24,
        speechPlan: [
          { beforeTrackIndex: 0, type: "intro", note: "开场只在节目启动时说一次" },
          { beforeTrackIndex: 2, type: "short_say", note: "两首歌后短讲一次" },
          { beforeTrackIndex: 4, type: "bumper", note: "轻量 station ID" },
        ],
      },
      chatHistory: [
        { role: "dj", text: "今晚先把这一段慢慢铺开。", timestamp: 1 },
      ],
      playHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      playlists: [],
      neteaseSnapshot: null,
      favorites: [],
      lastInteraction: Date.now(),
    } as any;

    vi.mocked(db.getState).mockImplementation(async () => currentState);
    vi.mocked(db.updateState).mockImplementation(async (patch: any) => {
      currentState = {
        ...currentState,
        ...patch,
        radioQueue: patch.radioQueue ?? currentState.radioQueue,
        currentTrack: patch.currentTrack ?? currentState.currentTrack,
        currentProgram: patch.currentProgram ?? currentState.currentProgram,
        chatHistory: patch.chatHistory ?? currentState.chatHistory,
        playHistory: patch.playHistory ?? currentState.playHistory,
      };
      return currentState;
    });
    vi.mocked(db.advanceRadioQueue).mockImplementation(async () => {
      const nextIndex = (currentState.currentQueueIndex + 1) % currentState.radioQueue.length;
      currentState = {
        ...currentState,
        currentQueueIndex: nextIndex,
        currentTrack: currentState.radioQueue[nextIndex],
      };
      return currentState;
    });
    vi.mocked(db.addChatMessage).mockImplementation(async (message: any) => {
      currentState = {
        ...currentState,
        chatHistory: [
          ...currentState.chatHistory,
          {
            role: message.role,
            text: message.text,
            timestamp: message.timestamp ?? Date.now(),
          },
        ],
      };
      return currentState;
    });
    vi.mocked(db.recordPlay).mockImplementation(async (title: string, artist: string) => {
      currentState = {
        ...currentState,
        playHistory: [
          { title, artist, playedAt: Date.now() },
          ...currentState.playHistory,
        ],
      };
      return currentState;
    });
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      say: "前两首把节奏铺稳了，下一首把情绪再往里收一点。",
      ttsText: "前两首把节奏铺稳了，下一首把情绪再往里收一点。",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/long-program.wav",
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (trackId: number) => `url-${trackId}-fresh`);

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const messages: Array<Record<string, any>> = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    const waitForTrack = async (trackName: string) => {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${trackName}`)), 3000);
        const check = setInterval(() => {
          if (messages.some((m) => m.type === "track" && m.data?.name === trackName)) {
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          }
        }, 10);
      });
    };

    for (const track of [...tracks.slice(1), tracks[0]]) {
      ws.send(JSON.stringify({ type: "queue_next" }));
      await waitForTrack(track.name);

      const auditRes = await fetch(`http://localhost:${port}/api/radio/program-audit`);
      expect(auditRes.status).toBe(200);
      const audit = await auditRes.json() as { ok: boolean; plannedMinutes: number; issues: unknown[] };
      expect(audit.ok).toBe(true);
      expect(audit.plannedMinutes).toBeGreaterThanOrEqual(20);
      expect(audit.issues).toHaveLength(0);
    }

    const djMessages = messages.filter((m) => m.type === "dj_message");
    expect(djMessages).toHaveLength(2);
    expect(djMessages[0].data?.text).toBe("前两首把节奏铺稳了，下一首把情绪再往里收一点。");
    expect(String(djMessages[1].data?.text)).toContain("Claudio FM");
    expect(claude.callJsonLLM).toHaveBeenCalledTimes(1);
    expect(currentState.chatHistory.map((message: { text: string }) => message.text).join("\n")).not.toMatch(
      /欢迎回来|欢迎收听|我是\s*Claudio|天气/,
    );

    ws.close();
  });

  it("chat 里的换风格请求会触发节目重编", async () => {
    const db = await import("./db.js");
    const pipeline = await import("./pipeline.js");

    vi.mocked(db.getState).mockResolvedValue({
      status: "playing",
      currentTrack: { id: "1", name: "Song A", artist: "Artist A", url: "url-a" },
      radioQueue: [],
      currentQueueIndex: 0,
      currentProgram: null,
      chatHistory: [],
      djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
      lastInteraction: Date.now(),
      playlists: [],
    } as any);
    vi.mocked(pipeline.runChatSwitchProgram).mockResolvedValue({
      status: "success",
      djMessage: "那我给你换一组更安静的。",
      ttsAudioPath: "data/audio/switch.wav",
      tracks: [{ id: 9, name: "Quiet Song", artist: "Artist Q", url: "url-q", picUrl: "pic-q", duration: 90 }],
      reason: "test",
      programTitle: "Quiet Set",
      shouldStartTrack: false,
      currentTrackPreserved: true,
    });

    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({ type: "chat", data: { text: "来点安静一点的歌" } }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for switch program")), 3000);
      const check = setInterval(() => {
        if (vi.mocked(pipeline.runChatSwitchProgram).mock.calls.length > 0) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    expect(pipeline.runChatSwitchProgram).toHaveBeenCalledWith("来点安静一点的歌", {
      preserveCurrentTrack: true,
    });

    ws.close();
  });
});
