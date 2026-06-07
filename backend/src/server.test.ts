import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";

vi.mock("./db.js");
vi.mock("./pipeline.js");
vi.mock("./claude.js");
vi.mock("./tts.js");
vi.mock("./netease.js");
vi.mock("./taste-profile.js");
vi.mock("./weather.js");

const originalUnblockEnabled = process.env.UNBLOCK_NETEASE_ENABLED;

describe("API Server", () => {
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
      currentProgram: { source: "startup", generatedAt: 1, title: "Night Flow", summary: "smooth transition" },
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
