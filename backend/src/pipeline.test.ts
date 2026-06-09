import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pipeline from "./pipeline.js";
import * as db from "./db.js";
import * as claude from "./claude.js";
import * as musicSources from "./music-sources/index.js";
import * as netease from "./netease.js";
import * as tasteProfile from "./taste-profile.js";
import * as tts from "./tts.js";
import * as weather from "./weather.js";

vi.mock("./db.js");
vi.mock("./claude.js");
vi.mock("./netease.js");
vi.mock("./taste-profile.js");
vi.mock("./tts.js");
vi.mock("./weather.js");

const baseState = {
  status: "idle" as const,
  currentTrack: null,
  radioQueue: [],
  currentQueueIndex: 0,
  currentProgram: null,
  chatHistory: [],
  djProfile: { voice: "温暖", style: "情感电台", name: "Claudio" },
  lastInteraction: Date.now(),
  playlists: [],
};

function mockNeteaseSearchTrack(track: {
  id: number;
  name: string;
  artist: string;
  album?: string;
  picUrl?: string;
  duration?: number;
}) {
  return {
    tracks: [
      {
        id: track.id,
        name: track.name,
        artists: [{ name: track.artist }],
        album: { name: track.album ?? "", picUrl: track.picUrl ?? "" },
        duration: track.duration ?? 0,
      },
    ],
    total: 1,
  };
}

function mockProgramResponse(overrides: Partial<{
  title: string;
  mood: string;
  plannedMinutes: number;
  speechPlan: Array<{ beforeTrackIndex: number; type: string; note?: string }>;
  say: string;
  ttsText: string;
  lineup: Array<{ id?: number; title: string; artist?: string }>;
  reason: string;
}> = {}) {
  const lineup = overrides.lineup ?? [
    { title: "Song 1", artist: "Artist 1" },
    { title: "Song 2", artist: "Artist 2" },
    { title: "Song 3", artist: "Artist 3" },
    { title: "Song 4", artist: "Artist 4" },
    { title: "Song 5", artist: "Artist 5" },
    { title: "Song 6", artist: "Artist 6" },
  ];

  return {
    title: overrides.title ?? "测试节目",
    mood: overrides.mood ?? "稳定测试",
    plannedMinutes: overrides.plannedMinutes ?? 24,
    speechPlan: overrides.speechPlan ?? [
      { beforeTrackIndex: 0, type: "intro", note: "开场" },
      { beforeTrackIndex: 3, type: "short_say", note: "短讲" },
    ],
    say: overrides.say ?? "我把节目重新接成一组完整队列，先保证音乐不断，后面按自然顺序继续。",
    ttsText: overrides.ttsText ?? "我把节目重新接成一组完整队列，先保证音乐不断，后面按自然顺序继续。",
    lineup,
    reason: overrides.reason ?? "测试节目编排。",
  };
}

function mockSearchFromLineup(lineup: Array<{ id?: number; title: string; artist?: string }>) {
  vi.mocked(netease.searchSongs).mockImplementation(async (keyword: string) => {
    const raw = String(keyword);
    const matched = lineup.find((track) => raw.includes(track.title));
    const index = vi.mocked(netease.searchSongs).mock.calls.length;
    return mockNeteaseSearchTrack({
      id: matched?.id ?? 100 + index,
      name: matched?.title ?? raw,
      artist: matched?.artist ?? `Artist ${index}`,
      duration: 240_000,
    });
  });
  vi.mocked(netease.getPlayableUrl).mockImplementation(async (id) => `url-${id}`);
}

describe("Pipeline Engine", () => {
  const originalUnblockEnabled = process.env.UNBLOCK_NETEASE_ENABLED;
  const originalLocalEnabled = process.env.LOCAL_MUSIC_ENABLED;
  const originalLocalDirs = process.env.LOCAL_MUSIC_DIRS;
  let tempDirs: string[] = [];

  async function createTempMusicFile(filename: string, contents = "fake audio"): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claudio-pipeline-local-music-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
    return filePath;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(claude.getLlmTaskTimeoutMs).mockImplementation((task) => ({
      semantic_router: 20_000,
      startup: 120_000,
      chat_switch: 90_000,
      discovery: 45_000,
    })[task]);
    process.env.UNBLOCK_NETEASE_ENABLED = "false";
    delete process.env.LOCAL_MUSIC_ENABLED;
    delete process.env.LOCAL_MUSIC_DIRS;
    musicSources.clearLocalLibraryCacheForTests();
  });

  afterEach(async () => {
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
    musicSources.clearLocalLibraryCacheForTests();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("should complete morning_brief pipeline successfully", async () => {
    const mockClaudeResponse = mockProgramResponse({
      title: "晨间节目",
      say: "早上好，我把晨间节目接成一组完整队列，先从清爽的一首开始。",
      ttsText: "早上好，我把晨间节目接成一组完整队列，先从清爽的一首开始。",
      reason: "适合早晨",
    });

    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("Hong Kong当前天气晴，气温27°C，体感29°C，湿度76%");
    vi.mocked(claude.callJsonLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/mock.wav",
    });
    mockSearchFromLineup(mockClaudeResponse.lineup);

    const result = await pipeline.runPipeline("morning_brief");

    expect(result.status).toBe("success");
    expect(result.djMessage).toBe(mockClaudeResponse.say);
    expect(result.tracks).toHaveLength(6);
    expect(result.tracks[0].name).toBe("Song 1");
    expect(result.ttsAudioPath).toBe("data/audio/mock.wav");
    expect(result.programTitle).toBe("晨间节目");

    expect(db.setStatus).toHaveBeenNthCalledWith(1, "thinking");
    expect(db.setStatus).toHaveBeenNthCalledWith(2, "speaking");
    expect(db.setStatus).toHaveBeenNthCalledWith(3, "playing");

    expect(db.setRadioQueue).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Song 1",
          artist: "Artist 1",
          url: expect.stringContaining("url-"),
        }),
        expect.objectContaining({ name: "Song 6" }),
      ]),
      expect.objectContaining({
        currentIndex: 0,
        program: expect.objectContaining({
          source: "manual",
          title: "晨间节目",
          plannedMinutes: 24,
          speechPlan: expect.arrayContaining([
            expect.objectContaining({ beforeTrackIndex: 0, type: "intro" }),
          ]),
        }),
      }),
    );

    expect(db.addChatMessage).toHaveBeenCalledWith({
      role: "dj",
      text: mockClaudeResponse.say,
    });

    expect(tts.speak).toHaveBeenCalledWith(mockClaudeResponse.ttsText, {
      profile: baseState.djProfile,
      scene: "music_recommendation",
      atmosphere: "Hong Kong当前天气晴，气温27°C，体感29°C，湿度76%；适合早晨",
    });
    expect(weather.getDefaultWeatherPromptContext).toHaveBeenCalled();
    expect(claude.callJsonLLM).toHaveBeenCalledWith(
      expect.stringContaining("Hong Kong当前天气晴，气温27°C，体感29°C，湿度76%"),
      120_000,
    );
  });

  it("should fall back to a complete manual program when the LLM fails", async () => {
    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callJsonLLM).mockRejectedValue(new Error("Claude Error"));
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/manual-fallback.wav",
    });
    mockSearchFromLineup([
      { title: "Best Day Of My Life", artist: "American Authors" },
      { title: "Sunflower", artist: "Post Malone, Swae Lee" },
      { title: "Yellow", artist: "Coldplay" },
      { title: "晴天", artist: "周杰伦" },
      { title: "Viva La Vida", artist: "Coldplay" },
      { title: "夜空中最亮的星", artist: "逃跑计划" },
    ]);

    const result = await pipeline.runPipeline("morning_brief");

    expect(result.status).toBe("success");
    expect(result.tracks).toHaveLength(6);
    expect(result.programTitle).toBe("Claudio 晨间续播");
    expect(db.setStatus).toHaveBeenNthCalledWith(1, "thinking");
    expect(db.setStatus).toHaveBeenNthCalledWith(2, "speaking");
    expect(db.setStatus).toHaveBeenNthCalledWith(3, "playing");
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: "Best Day Of My Life" }),
        expect.objectContaining({ name: "夜空中最亮的星" }),
      ]),
      expect.objectContaining({
        program: expect.objectContaining({
          source: "manual",
          plannedMinutes: 24,
          speechPlan: expect.arrayContaining([
            expect.objectContaining({ beforeTrackIndex: 0, type: "intro" }),
            expect.objectContaining({ type: "short_say" }),
          ]),
        }),
      }),
    );
  });

  it("should continue when TTS fails", async () => {
    const mockClaudeResponse = mockProgramResponse({
      say: "TTS fails test",
      reason: "test",
    });

    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callJsonLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockRejectedValue(new Error("TTS Error"));
    mockSearchFromLineup(mockClaudeResponse.lineup);

    const result = await pipeline.runPipeline("morning_brief");

    expect(result.status).toBe("success");
    expect(result.ttsAudioPath).toBeUndefined();
    expect(result.tracks).toHaveLength(6);
    expect(db.setStatus).toHaveBeenCalledWith("playing");
  });

  it("should continue and skip track when netease.resolveTrack fails", async () => {
    const mockClaudeResponse = mockProgramResponse({
      say: "Netease fails test",
      lineup: [
        { title: "Fail", artist: "Artist" },
        { title: "Success", artist: "Artist" },
        { title: "Backup 1", artist: "Artist" },
        { title: "Backup 2", artist: "Artist" },
        { title: "Backup 3", artist: "Artist" },
        { title: "Backup 4", artist: "Artist" },
      ],
      reason: "test",
    });

    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callJsonLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: true,
      cachePath: "data/audio/cached.wav",
    });

    vi.mocked(netease.searchSongs).mockImplementation(async (keyword: string) => {
      const raw = String(keyword);
      const matched = mockClaudeResponse.lineup.find((track) => raw.includes(track.title));
      return mockNeteaseSearchTrack({
        id: matched?.title === "Fail" ? 111 : 200 + vi.mocked(netease.searchSongs).mock.calls.length,
        name: matched?.title ?? raw,
        artist: matched?.artist ?? "Artist",
        duration: 240_000,
      });
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (id) => {
      if (id === 111) throw new Error("Netease Error");
      return `url-${id}`;
    });

    const result = await pipeline.runPipeline("morning_brief");

    expect(result.status).toBe("success");
    expect(result.tracks.some((track) => track.name === "Fail")).toBe(false);
    expect(result.tracks.some((track) => track.name === "Success")).toBe(true);
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "Success" })]),
      expect.objectContaining({ currentIndex: 0 }),
    );
  });

  it("should avoid recently played tracks when building a program queue", async () => {
    const mockClaudeResponse = mockProgramResponse({
      say: "换一组不重复的歌。",
      lineup: [
        { title: "Recent Song", artist: "Artist A" },
        { title: "Fresh Song", artist: "Artist B" },
        { title: "Fresh Song 2", artist: "Artist C" },
        { title: "Fresh Song 3", artist: "Artist D" },
        { title: "Fresh Song 4", artist: "Artist E" },
        { title: "Fresh Song 5", artist: "Artist F" },
      ],
      reason: "test",
    });

    vi.mocked(db.getState).mockResolvedValue({
      ...baseState,
      playHistory: [{ title: "Recent Song", artist: "Artist A", playedAt: Date.now() }],
    } as any);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callJsonLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: true,
      cachePath: "data/audio/no-repeat.wav",
    });
    mockSearchFromLineup(mockClaudeResponse.lineup);

    const result = await pipeline.runPipeline("mood_pick");

    expect(result.tracks.some((track) => track.name === "Recent Song")).toBe(false);
    expect(result.tracks[0]).toMatchObject({
      name: "Fresh Song",
      artist: "Artist B",
    });
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "Fresh Song" })]),
      expect.objectContaining({ currentIndex: 0 }),
    );
  });

  it("should prefer local candidate id resolution when provided", async () => {
    const mockClaudeResponse = mockProgramResponse({
      say: "从你的本地曲库里挑了一首。",
      lineup: [
        { id: 999, title: "Local Song", artist: "Local Artist" },
        { title: "Online 1", artist: "Artist 1" },
        { title: "Online 2", artist: "Artist 2" },
        { title: "Online 3", artist: "Artist 3" },
        { title: "Online 4", artist: "Artist 4" },
        { title: "Online 5", artist: "Artist 5" },
      ],
      reason: "test",
    });

    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue({
      account: { userId: 1, nickname: "tester", avatarUrl: "" },
      syncedAt: 1,
      playlists: [
        {
          id: 1,
          name: "Snapshot",
          trackCount: 1,
          playCount: 1,
          coverImgUrl: "",
          creator: { nickname: "tester", userId: 1 },
          tracks: [{ id: 999, name: "Local Song", artist: "Local Artist", album: "Album" }],
        },
      ],
    } as any);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue({
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
      summary: "summary",
    } as any);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("summary");
    vi.mocked(tasteProfile.buildRecommendationCandidates).mockReturnValue([
      {
        id: 999,
        title: "Local Song",
        artist: "Local Artist",
        album: "Album",
        sourcePlaylists: ["Snapshot"],
        playlistCount: 1,
        occurrences: 1,
        score: 10,
        reasons: ["core-artist"],
      },
    ]);
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("candidate context");
    vi.mocked(claude.callJsonLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/mock.wav",
    });
    vi.mocked(netease.searchSongs).mockImplementation(async (keyword: string) => {
      const raw = String(keyword);
      const matched = mockClaudeResponse.lineup.find((track) => raw.includes(track.title));
      return mockNeteaseSearchTrack({
        id: 200 + vi.mocked(netease.searchSongs).mock.calls.length,
        name: matched?.title ?? raw,
        artist: matched?.artist ?? "Artist",
        duration: 240_000,
      });
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (id) =>
      id === 999 ? "http://example.com/local.mp3" : `url-${id}`,
    );

    const result = await pipeline.runPipeline("mood_pick");

    expect(netease.getPlayableUrl).toHaveBeenCalledWith(999, undefined);
    expect(weather.getDefaultWeatherPromptContext).not.toHaveBeenCalled();
    expect(result.tracks[0]).toMatchObject({
      id: 999,
      name: "Local Song",
      artist: "Local Artist",
      url: "http://example.com/local.mp3",
    });
    expect(result.tracks.length).toBeGreaterThanOrEqual(6);
  });

  it("should resolve random_discover through Discovery Scout directions", async () => {
    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(db.summarizeDiscoveryCandidates).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      say: "我先沿着你的口味旁边试一首新的。",
      ttsText: "我先沿着你的口味旁边试一首新的。",
      directions: [
        {
          query: "Discovery Lane",
          direction: "adjacent discovery",
          reason: "Near the current taste.",
          risk: "adjacent",
        },
      ],
      reason: "test discovery strategy",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/discovery.wav",
    });
    vi.mocked(netease.searchSongs).mockImplementation(async (keyword: string) => {
      if (keyword.includes("Discovery Lane")) {
        return mockNeteaseSearchTrack({
          id: 222,
          name: "Discovery Song",
          artist: "Discovery Artist",
        });
      }
      if (keyword.includes("Sunflower")) {
        return mockNeteaseSearchTrack({ id: 112, name: "Stable 2", artist: "Stable Artist" });
      }
      if (keyword.includes("Yellow")) {
        return mockNeteaseSearchTrack({ id: 113, name: "Stable 3", artist: "Stable Artist" });
      }
      return mockNeteaseSearchTrack({
        id: 111,
        name: "Stable 1",
        artist: "Stable Artist",
      });
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (trackId: number) => `url-${trackId}`);

    const result = await pipeline.runPipeline("random_discover");

    expect(claude.callLLM).not.toHaveBeenCalled();
    expect(claude.callJsonLLM).toHaveBeenCalledWith(expect.any(String), 45_000);
    expect(netease.searchSongs).toHaveBeenCalledWith("Discovery Lane", 5);
    expect(result.tracks.map((track) => track.name)).toEqual([
      "Stable 1",
      "Discovery Song",
      "Stable 2",
      "Stable 3",
    ]);
    expect(db.addDiscoveryCandidates).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Discovery Song",
        artist: "Discovery Artist",
        health: "ready",
      }),
    ]);
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: "111", name: "Stable 1" }),
        expect.objectContaining({ id: "222", name: "Discovery Song" }),
        expect.objectContaining({ id: "112", name: "Stable 2" }),
        expect.objectContaining({ id: "113", name: "Stable 3" }),
      ],
      expect.objectContaining({
        currentIndex: 0,
        program: expect.objectContaining({
          source: "manual",
          plannedMinutes: 20,
          speechPlan: expect.arrayContaining([
            expect.objectContaining({ beforeTrackIndex: 0, type: "intro" }),
          ]),
        }),
      }),
    );
  });

  it("limits Discovery Scout small adventures to one backend risk", async () => {
    vi.mocked(db.getState).mockResolvedValue({
      ...baseState,
      userFeedback: [{
        id: "feedback-1",
        type: "more_like_this",
        title: "Anchor",
        artist: "Artist",
        createdAt: Date.now(),
      }],
    } as any);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(db.summarizeDiscoveryCandidates).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      say: "我沿着正反馈试两个新方向。",
      ttsText: "我沿着正反馈试两个新方向。",
      directions: [
        {
          query: "Adventure Lane One",
          direction: "small adventure one",
          reason: "A wider but explainable step.",
          risk: "small_adventure",
        },
        {
          query: "Adventure Lane Two",
          direction: "small adventure two",
          reason: "Another wider step.",
          risk: "small_adventure",
        },
      ],
      reason: "test bounded discovery strategy",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/bounded-discovery.wav",
    });
    vi.mocked(netease.searchSongs).mockImplementation(async (keyword: string) => {
      if (keyword.includes("Adventure Lane One")) {
        return mockNeteaseSearchTrack({ id: 331, name: "Adventure One", artist: "Discovery Artist" });
      }
      if (keyword.includes("Adventure Lane Two")) {
        return mockNeteaseSearchTrack({ id: 332, name: "Adventure Two", artist: "Discovery Artist" });
      }
      return mockNeteaseSearchTrack({ id: 111, name: "Stable Anchor", artist: "Stable Artist" });
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (trackId: number) => `url-${trackId}`);

    await pipeline.runPipeline("random_discover");

    expect(db.addDiscoveryCandidates).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Adventure One",
        risk: "small_adventure",
      }),
      expect.objectContaining({
        title: "Adventure Two",
        risk: "adjacent",
      }),
    ]);
  });

  it("should include configured local library files in recommendation context", async () => {
    const filePath = await createTempMusicFile("Library Artist - Library Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(filePath);
    musicSources.clearLocalLibraryCacheForTests();

    const mockClaudeResponse = mockProgramResponse({
      say: "从本地文件库里挑一首。",
      lineup: [{ title: "Library Song", artist: "Library Artist" }],
      reason: "test",
    });

    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callJsonLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/local-library.wav",
    });
    vi.mocked(netease.searchSongs).mockImplementation(async (keyword: string) => {
      const raw = String(keyword);
      const index = vi.mocked(netease.searchSongs).mock.calls.length;
      return mockNeteaseSearchTrack({
        id: 700 + index,
        name: raw.split(" ").slice(0, -1).join(" ") || raw,
        artist: `Fallback Artist ${index}`,
        duration: 240_000,
      });
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (id) => `url-${id}`);

    const result = await pipeline.runPipeline("mood_pick");

    expect(String(vi.mocked(claude.callJsonLLM).mock.calls[0]?.[0] ?? "")).toContain("Library Song - Library Artist");
    expect(result.tracks[0]).toMatchObject({
      name: "Library Song",
      artist: "Library Artist",
      source: musicSources.LOCAL_LIBRARY_SOURCE_ID,
      urlSource: musicSources.LOCAL_LIBRARY_SOURCE_ID,
    });
  });

  it("should build startup radio program with multiple tracks", async () => {
    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("【收藏】A - B");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("广州多云，25°C");
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      title: "午间电台",
      mood: "轻松午间",
      plannedMinutes: 28,
      speechPlan: [
        { beforeTrackIndex: 0, type: "intro", note: "开场" },
        { beforeTrackIndex: 2, type: "short_say", note: "短讲" },
      ],
      say: "中午了，我们开一档轻松的节目。",
      ttsText: "（轻声）中午了，我们开一档轻松的节目。",
      lineup: [
        { title: "Song A", artist: "Artist A" },
        { title: "Song B", artist: "Artist B" },
      ],
      reason: "天气温和，适合松弛一点。",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/startup.wav",
    });
    vi.mocked(netease.searchSongs)
      .mockResolvedValueOnce(mockNeteaseSearchTrack({
        id: 11,
        name: "Song A",
        artist: "Artist A",
        picUrl: "pic-a",
        duration: 100,
      }))
      .mockResolvedValueOnce(mockNeteaseSearchTrack({
        id: 12,
        name: "Song B",
        artist: "Artist B",
        picUrl: "pic-b",
        duration: 120,
      }))
      .mockImplementation(async (keyword) => {
        const index = vi.mocked(netease.searchSongs).mock.calls.length;
        return mockNeteaseSearchTrack({
          id: 100 + index,
          name: `Fallback ${index}`,
          artist: `Fallback Artist ${index}`,
          duration: 240_000,
        });
      });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (id) => `url-${id}`);

    const result = await pipeline.runStartupRadioProgram();

    expect(result.programTitle).toBe("午间电台");
    expect(result.tracks.length).toBeGreaterThanOrEqual(6);
    expect(result.tracks.length).toBeLessThanOrEqual(10);
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "11", name: "Song A" }),
        expect.objectContaining({ id: "12", name: "Song B" }),
      ]),
      expect.objectContaining({
        currentIndex: 0,
        program: expect.objectContaining({
          source: "startup",
          title: "午间电台",
          mood: "轻松午间",
          plannedMinutes: 28,
          sessionId: expect.stringMatching(/^startup_/),
          speechPlan: expect.arrayContaining([
            expect.objectContaining({ beforeTrackIndex: 0, type: "intro" }),
          ]),
        }),
      }),
    );
  });

  it("adds verified discoveries after a stable opening in long programs", async () => {
    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue({
      account: { userId: 1, nickname: "tester", avatarUrl: "" },
      syncedAt: 1,
      playlists: [
        {
          id: 1,
          name: "Snapshot",
          trackCount: 4,
          playCount: 1,
          coverImgUrl: "",
          creator: { nickname: "tester", userId: 1 },
          tracks: [
            { id: 1, name: "Stable 1", artist: "Stable Artist", album: "Album" },
          ],
        },
      ],
    } as any);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(db.summarizeDiscoveryCandidates).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue({
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
      summary: "summary",
    } as any);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("summary");
    vi.mocked(tasteProfile.buildRecommendationCandidates).mockReturnValue([
      {
        id: 1,
        title: "Stable 1",
        artist: "Stable Artist",
        album: "Album",
        sourcePlaylists: ["Snapshot"],
        playlistCount: 1,
        occurrences: 1,
        score: 10,
        reasons: ["core-artist"],
      },
    ]);
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("candidate context");
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("广州多云，25°C");
    vi.mocked(claude.callJsonLLM)
      .mockResolvedValueOnce({
        title: "稳定探索节目",
        mood: "steady discovery",
        plannedMinutes: 24,
        speechPlan: [{ beforeTrackIndex: 0, type: "intro", note: "开场" }],
        say: "先稳住主线，再试一点新方向。",
        ttsText: "先稳住主线，再试一点新方向。",
        lineup: [
          { title: "Stable 1", artist: "Stable Artist" },
          { title: "Stable 2", artist: "Stable Artist" },
          { title: "Stable 3", artist: "Stable Artist" },
          { title: "Stable 4", artist: "Stable Artist" },
          { title: "Stable 5", artist: "Stable Artist" },
          { title: "Stable 6", artist: "Stable Artist" },
        ],
        reason: "先稳定，后探索。",
      })
      .mockResolvedValueOnce({
        say: "第三首后试一个相邻方向。",
        ttsText: "第三首后试一个相邻方向。",
        directions: [
          {
            query: "Discovery Lane",
            direction: "adjacent discovery",
            reason: "Near the current taste.",
            risk: "adjacent",
          },
        ],
        reason: "controlled discovery",
      });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/program-discovery.wav",
    });
    vi.mocked(netease.searchSongs).mockImplementation(async (keyword: string) => {
      if (keyword.includes("Discovery Lane")) {
        return mockNeteaseSearchTrack({ id: 900, name: "Discovery Song", artist: "Discovery Artist" });
      }
      const match = keyword.match(/Stable\s+(\d)/);
      const id = match ? Number(match[1]) : 1;
      return mockNeteaseSearchTrack({ id, name: `Stable ${id}`, artist: "Stable Artist" });
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (trackId: number) => `url-${trackId}`);

    const result = await pipeline.runStartupRadioProgram();

    expect(result.tracks.map((track) => track.name)).toEqual([
      "Stable 1",
      "Stable 2",
      "Stable 3",
      "Discovery Song",
      "Stable 4",
      "Stable 5",
      "Stable 6",
    ]);
    expect(result.tracks[0].name).toBe("Stable 1");
    expect(db.addDiscoveryCandidates).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Discovery Song",
        risk: "adjacent",
        health: "ready",
      }),
    ]);
  });

  it("should generate English startup copy when Dean preset is active", async () => {
    vi.mocked(db.getState).mockResolvedValue({
      ...baseState,
      djProfile: { voice: "Dean", style: "late-night radio", name: "Claudio" },
    } as any);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("【收藏】Coldplay - Yellow");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("Hong Kong cloudy, 24°C");
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      title: "Midnight Ease",
      say: "Let's ease into the room with something soft and open.",
      ttsText: "(softly) Let's ease into the room with something soft and open.",
      lineup: [{ title: "Yellow", artist: "Coldplay" }],
      reason: "The weather and timing both lean naturally into a gentler start.",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/dean-startup.wav",
    });
    vi.mocked(netease.searchSongs).mockResolvedValue(mockNeteaseSearchTrack({
      id: 88,
      name: "Yellow",
      artist: "Coldplay",
      picUrl: "yellow-pic",
      duration: 100,
    }));
    vi.mocked(netease.getPlayableUrl).mockResolvedValue("yellow-url");

    await pipeline.runStartupRadioProgram();

    const prompt = String(vi.mocked(claude.callJsonLLM).mock.calls[0]?.[0] ?? "");
    expect(prompt).toContain("natural English");
    expect(prompt).not.toContain("中文 40-120 字");
    expect(claude.callJsonLLM).toHaveBeenCalledWith(expect.any(String), 120_000);
  });

  it("should fall back to a deterministic startup program when LLM is rate limited", async () => {
    vi.mocked(db.getState).mockResolvedValue(baseState as any);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("【收藏】Coldplay - Yellow");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("Hong Kong cloudy, 24°C");
    vi.mocked(claude.callJsonLLM).mockRejectedValue(new Error("rate limited"));
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/fallback-startup.wav",
    });
    vi.mocked(netease.searchSongs).mockImplementation(async (keyword) => {
      const title = String(keyword).split(" ").slice(0, -1).join(" ") || String(keyword);
      const index = vi.mocked(netease.searchSongs).mock.calls.length;
      return mockNeteaseSearchTrack({
        id: 900 + index,
        name: title,
        artist: `Fallback Artist ${index}`,
        duration: 240_000,
      });
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (id) => `fallback-url-${id}`);

    const result = await pipeline.runStartupRadioProgram({ background: true });

    expect(result.status).toBe("success");
    expect(result.programTitle).toBe("Claudio 续播电台");
    expect(result.tracks).toHaveLength(6);
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: expect.any(String), url: expect.stringContaining("fallback-url-") }),
      ]),
      expect.objectContaining({
        currentIndex: 0,
        program: expect.objectContaining({
          source: "startup",
          title: "Claudio 续播电台",
          plannedMinutes: 24,
          speechPlan: expect.arrayContaining([
            expect.objectContaining({ beforeTrackIndex: 0, type: "intro" }),
            expect.objectContaining({ type: "short_say" }),
          ]),
        }),
      }),
    );
    expect(db.setStatus).toHaveBeenLastCalledWith("playing");
  });

  it("keeps a full fallback startup queue even when all fallback tracks are recent", async () => {
    vi.mocked(db.getState).mockResolvedValue({
      ...baseState,
      playHistory: [
        { title: "Best Day Of My Life", artist: "American Authors", playedAt: 1 },
        { title: "Sunflower", artist: "Post Malone, Swae Lee", playedAt: 2 },
        { title: "Yellow", artist: "Coldplay", playedAt: 3 },
        { title: "晴天", artist: "周杰伦", playedAt: 4 },
        { title: "The Scientist", artist: "Coldplay", playedAt: 5 },
        { title: "夜空中最亮的星", artist: "逃跑计划", playedAt: 6 },
      ],
    } as any);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("Hong Kong cloudy, 24°C");
    vi.mocked(claude.callJsonLLM).mockRejectedValue(new Error("rate limited"));
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/fallback-startup.wav",
    });
    const fallbackTracks = [
      { title: "Best Day Of My Life", artist: "American Authors" },
      { title: "Sunflower", artist: "Post Malone, Swae Lee" },
      { title: "Yellow", artist: "Coldplay" },
      { title: "晴天", artist: "周杰伦" },
      { title: "The Scientist", artist: "Coldplay" },
      { title: "夜空中最亮的星", artist: "逃跑计划" },
    ];
    vi.mocked(netease.searchSongs).mockImplementation(async (keyword) => {
      const raw = String(keyword);
      const matched = fallbackTracks.find((track) => raw.startsWith(track.title));
      const index = vi.mocked(netease.searchSongs).mock.calls.length;
      return mockNeteaseSearchTrack({
        id: 1000 + index,
        name: matched?.title ?? raw,
        artist: matched?.artist ?? `Fallback Artist ${index}`,
        duration: 240_000,
      });
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (id) => `fallback-url-${id}`);

    const result = await pipeline.runStartupRadioProgram({ background: true });

    expect(result.tracks).toHaveLength(6);
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: "Best Day Of My Life" }),
        expect.objectContaining({ name: "Sunflower" }),
        expect.objectContaining({ name: "Yellow" }),
        expect.objectContaining({ name: "晴天" }),
        expect.objectContaining({ name: "The Scientist" }),
        expect.objectContaining({ name: "夜空中最亮的星" }),
      ]),
      expect.objectContaining({
        program: expect.objectContaining({
          source: "startup",
          plannedMinutes: 24,
        }),
      }),
    );
  });

  it("should build chat switch program from user request", async () => {
    vi.mocked(db.getState).mockResolvedValue({
      ...baseState,
      currentTrack: {
        id: "1",
        name: "Old Song",
        artist: "Old Artist",
        url: "old-url",
      },
    });
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("【收藏】A - B");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("广州小雨，22°C");
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      title: "夜雨换歌",
      say: "那我给你换一组更安静的。",
      lineup: [{ title: "Rain Song", artist: "Artist R" }],
      reason: "贴合你的聊天需求。",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/switch.wav",
    });
    vi.mocked(netease.searchSongs).mockResolvedValue(mockNeteaseSearchTrack({
      id: 66,
      name: "Rain Song",
      artist: "Artist R",
      picUrl: "rain-pic",
      duration: 88,
    }));
    vi.mocked(netease.getPlayableUrl).mockResolvedValue("rain-url");

    const result = await pipeline.runChatSwitchProgram("换一组安静一点的歌");

    expect(result.djMessage).toBe("那我给你换一组更安静的。");
    expect(claude.callJsonLLM).toHaveBeenCalledWith(expect.any(String), 90_000);
    expect(weather.getDefaultWeatherPromptContext).not.toHaveBeenCalled();
    expect(String(vi.mocked(claude.callJsonLLM).mock.calls[0]?.[0] ?? "")).toContain("天气不是这次调整的依据。");
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "66", name: "Rain Song" })],
      expect.objectContaining({
        program: expect.objectContaining({
          source: "chat_switch",
          userRequest: "换一组安静一点的歌",
        }),
      }),
    );
  });

  it("should use deterministic fallback when chat switch LLM fails", async () => {
    const currentTrack = {
      id: "1",
      name: "Old Song",
      artist: "Old Artist",
      url: "old-url",
      picUrl: "old-pic",
      duration: 100,
    };

    vi.mocked(db.getState).mockResolvedValue({
      ...baseState,
      status: "playing",
      currentTrack,
      radioQueue: [currentTrack],
      currentQueueIndex: 0,
    });
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("【收藏】A - B");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callJsonLLM).mockRejectedValue(new Error("LLM Error"));
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/fallback-switch.wav",
    });
    vi.mocked(netease.searchSongs).mockImplementation(async (keyword: string) => {
      const index = vi.mocked(netease.searchSongs).mock.calls.length;
      const fallbackTrack = keyword.includes("Strobe")
        ? { name: "Strobe", artist: "deadmau5" }
        : keyword.includes("Shelter")
          ? { name: "Shelter", artist: "Porter Robinson, Madeon" }
          : keyword.includes("Midnight City")
            ? { name: "Midnight City", artist: "M83" }
            : keyword.includes("Faded")
              ? { name: "Faded", artist: "Alan Walker" }
              : { name: "After Midnight", artist: "KLYMVX, Emily Zeck" };
      return mockNeteaseSearchTrack({
        id: 2000 + index,
        name: fallbackTrack.name,
        artist: fallbackTrack.artist,
        duration: 240_000,
      });
    });
    vi.mocked(netease.getPlayableUrl).mockImplementation(async (id) => `fallback-url-${id}`);

    const result = await pipeline.runChatSwitchProgram("我要听电子音乐", {
      preserveCurrentTrack: true,
    });

    expect(result.status).toBe("success");
    expect(result.currentTrackPreserved).toBe(true);
    expect(result.shouldStartTrack).toBe(false);
    expect(result.djMessage).toContain("收到");
    expect(db.setStatus).toHaveBeenCalledWith("thinking");
    expect(db.setStatus).toHaveBeenCalledWith("speaking");
    expect(db.setStatus).toHaveBeenCalledWith("playing");
    expect(db.setStatus).not.toHaveBeenCalledWith("error");
    expect(claude.callJsonLLM).toHaveBeenCalledWith(expect.any(String), 90_000);
    expect(claude.callJsonLLM).toHaveBeenCalledTimes(1);
    const [queue, options] = vi.mocked(db.setRadioQueue).mock.calls[0] ?? [];
    expect(queue).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "1", name: "Old Song", url: "old-url" }),
      expect.objectContaining({ name: "Strobe", artist: "deadmau5", url: expect.stringMatching(/^fallback-url-/) }),
      expect.objectContaining({ name: "Shelter", artist: "Porter Robinson, Madeon", url: expect.stringMatching(/^fallback-url-/) }),
      expect.objectContaining({ name: "Midnight City", artist: "M83", url: expect.stringMatching(/^fallback-url-/) }),
    ]));
    expect(queue?.[0]).toEqual(expect.objectContaining({ id: "1", name: "Old Song", url: "old-url" }));
    expect(queue?.length).toBeGreaterThanOrEqual(4);
    expect(options).toEqual(
      expect.objectContaining({
        currentIndex: 0,
        program: expect.objectContaining({
          source: "chat_switch",
          userRequest: "我要听电子音乐",
        }),
      }),
    );
  });

  it("should preserve the current track when chat replan is for upcoming queue", async () => {
    const currentTrack = {
      id: "1",
      name: "Old Song",
      artist: "Old Artist",
      url: "old-url",
      picUrl: "old-pic",
      duration: 100,
    };

    vi.mocked(db.getState).mockResolvedValue({
      ...baseState,
      status: "playing",
      currentTrack,
      radioQueue: [currentTrack],
      currentQueueIndex: 0,
    });
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("【收藏】A - B");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      title: "安静一点",
      say: "我会把后面换得安静一点，先让这首自然放完。",
      lineup: [{ title: "Quiet Song", artist: "Artist Q" }],
      reason: "承接用户想要更安静的需求。",
    });
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/replan.wav",
    });
    vi.mocked(netease.searchSongs).mockResolvedValue(mockNeteaseSearchTrack({
      id: 77,
      name: "Quiet Song",
      artist: "Artist Q",
      picUrl: "quiet-pic",
      duration: 120,
    }));
    vi.mocked(netease.getPlayableUrl).mockResolvedValue("quiet-url");

    const result = await pipeline.runChatSwitchProgram("换安静一点", {
      preserveCurrentTrack: true,
    });

    expect(result.shouldStartTrack).toBe(false);
    expect(result.currentTrackPreserved).toBe(true);
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: "1", name: "Old Song", url: "old-url" }),
        expect.objectContaining({ id: "77", name: "Quiet Song", url: "quiet-url" }),
      ],
      expect.objectContaining({
        currentIndex: 0,
        program: expect.objectContaining({
          source: "chat_switch",
          userRequest: "换安静一点",
        }),
      }),
    );
    expect(db.recordPlay).not.toHaveBeenCalled();
  });
});
