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
    vi.clearAllMocks();
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
    const mockClaudeResponse: claude.LLMResponse = {
      say: "早上好，这是你的晨间简报。",
      ttsText: "（轻声）早上好，这是你的晨间简报。",
      play: [{ title: "Song 1", artist: "Artist 1" }],
      reason: "适合早晨",
      segue: "接下来请听",
    };

    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(weather.getDefaultWeatherPromptContext).mockResolvedValue("Hong Kong当前天气晴，气温27°C，体感29°C，湿度76%");
    vi.mocked(claude.buildContextPrompt).mockReturnValue("prompt with weather");
    vi.mocked(claude.callLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/mock.wav",
    });
    vi.mocked(netease.searchSongs).mockResolvedValue(mockNeteaseSearchTrack({
      id: 123,
      name: "Song 1",
      artist: "Artist 1",
      picUrl: "http://example.com/pic1.jpg",
      duration: 180000,
    }));
    vi.mocked(netease.getPlayableUrl).mockResolvedValue("http://example.com/song1.mp3");

    const result = await pipeline.runPipeline("morning_brief");

    expect(result.status).toBe("success");
    expect(result.djMessage).toBe(mockClaudeResponse.say);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].id).toBe(123);
    expect(result.ttsAudioPath).toBe("data/audio/mock.wav");

    expect(db.setStatus).toHaveBeenNthCalledWith(1, "thinking");
    expect(db.setStatus).toHaveBeenNthCalledWith(2, "speaking");
    expect(db.setStatus).toHaveBeenNthCalledWith(3, "playing");

    expect(db.setRadioQueue).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "123",
        name: "Song 1",
        artist: "Artist 1",
        url: "http://example.com/song1.mp3",
      }),
    ], expect.objectContaining({
      currentIndex: 0,
    }));

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
    expect(claude.buildContextPrompt).toHaveBeenCalledWith(expect.objectContaining({
      djVoice: baseState.djProfile.voice,
      weatherContext: "Hong Kong当前天气晴，气温27°C，体感29°C，湿度76%",
    }));
    expect(claude.callLLM).toHaveBeenCalledWith("prompt with weather");
  });

  it("should update status to error and throw when Claude fails", async () => {
    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callLLM).mockRejectedValue(new Error("Claude Error"));

    await expect(pipeline.runPipeline("morning_brief")).rejects.toThrow("Claude Error");

    expect(db.setStatus).toHaveBeenCalledWith("thinking");
    expect(db.setStatus).toHaveBeenCalledWith("idle");
    expect(db.setStatus).toHaveBeenCalledWith("error");
  });

  it("should continue when TTS fails", async () => {
    const mockClaudeResponse: claude.LLMResponse = {
      say: "TTS fails test",
      play: [],
      reason: "test",
    };

    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockRejectedValue(new Error("TTS Error"));

    const result = await pipeline.runPipeline("morning_brief");

    expect(result.status).toBe("success");
    expect(result.ttsAudioPath).toBeUndefined();
    expect(db.setStatus).toHaveBeenCalledWith("playing");
  });

  it("should continue and skip track when netease.resolveTrack fails", async () => {
    const mockClaudeResponse: claude.LLMResponse = {
      say: "Netease fails test",
      play: [
        { title: "Fail", artist: "Artist" },
        { title: "Success", artist: "Artist" },
      ],
      reason: "test",
    };

    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: true,
      cachePath: "data/audio/cached.wav",
    });

    vi.mocked(netease.searchSongs)
      .mockResolvedValueOnce(mockNeteaseSearchTrack({
        id: 111,
        name: "Fail",
        artist: "Artist",
      }))
      .mockResolvedValueOnce(mockNeteaseSearchTrack({
        id: 456,
        name: "Success",
        artist: "Artist",
        picUrl: "pic",
        duration: 100,
      }));
    vi.mocked(netease.getPlayableUrl)
      .mockRejectedValueOnce(new Error("Netease Error"))
      .mockResolvedValueOnce("url");

    const result = await pipeline.runPipeline("morning_brief");

    expect(result.status).toBe("success");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].id).toBe(456);
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "456" })],
      expect.objectContaining({ currentIndex: 0 }),
    );
  });

  it("should avoid recently played tracks when building a program queue", async () => {
    const mockClaudeResponse: claude.LLMResponse = {
      say: "换一组不重复的歌。",
      play: [
        { title: "Recent Song", artist: "Artist A" },
        { title: "Fresh Song", artist: "Artist B" },
      ],
      reason: "test",
    };

    vi.mocked(db.getState).mockResolvedValue({
      ...baseState,
      playHistory: [{ title: "Recent Song", artist: "Artist A", playedAt: Date.now() }],
    } as any);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.callLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: true,
      cachePath: "data/audio/no-repeat.wav",
    });

    vi.mocked(netease.searchSongs)
      .mockResolvedValueOnce(mockNeteaseSearchTrack({
        id: 111,
        name: "Recent Song",
        artist: "Artist A",
      }))
      .mockResolvedValueOnce(mockNeteaseSearchTrack({
        id: 222,
        name: "Fresh Song",
        artist: "Artist B",
      }));
    vi.mocked(netease.getPlayableUrl)
      .mockResolvedValueOnce("recent-url")
      .mockResolvedValueOnce("fresh-url");

    const result = await pipeline.runPipeline("mood_pick");

    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({
      id: 222,
      name: "Fresh Song",
      artist: "Artist B",
    });
    expect(db.setRadioQueue).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "222", name: "Fresh Song" })],
      expect.objectContaining({ currentIndex: 0 }),
    );
  });

  it("should prefer local candidate id resolution when provided", async () => {
    const mockClaudeResponse: claude.LLMResponse = {
      say: "从你的本地曲库里挑了一首。",
      play: [{ id: 999, title: "Local Song", artist: "Local Artist" }],
      reason: "test",
    };

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
    vi.mocked(claude.callLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/mock.wav",
    });
    vi.mocked(netease.getPlayableUrl).mockResolvedValue("http://example.com/local.mp3");

    const result = await pipeline.runPipeline("random_discover");

    expect(netease.getPlayableUrl).toHaveBeenCalledWith(999, undefined);
    expect(netease.searchSongs).not.toHaveBeenCalled();
    expect(weather.getDefaultWeatherPromptContext).not.toHaveBeenCalled();
    expect(result.tracks[0]).toMatchObject({
      id: 999,
      name: "Local Song",
      artist: "Local Artist",
      url: "http://example.com/local.mp3",
    });
  });

  it("should include configured local library files in recommendation context", async () => {
    const filePath = await createTempMusicFile("Library Artist - Library Song.mp3");
    process.env.LOCAL_MUSIC_ENABLED = "true";
    process.env.LOCAL_MUSIC_DIRS = path.dirname(filePath);
    musicSources.clearLocalLibraryCacheForTests();

    const mockClaudeResponse: claude.LLMResponse = {
      say: "从本地文件库里挑一首。",
      play: [{ title: "Library Song", artist: "Library Artist" }],
      reason: "test",
    };

    vi.mocked(db.getState).mockResolvedValue(baseState);
    vi.mocked(db.getNeteaseSnapshot).mockResolvedValue(null);
    vi.mocked(db.summarizePlaylists).mockReturnValue("");
    vi.mocked(tasteProfile.getTasteProfile).mockResolvedValue(null);
    vi.mocked(tasteProfile.summarizeTasteProfile).mockResolvedValue("");
    vi.mocked(tasteProfile.summarizeRecommendationCandidates).mockReturnValue("");
    vi.mocked(claude.buildContextPrompt).mockReturnValue("prompt with local library");
    vi.mocked(claude.callLLM).mockResolvedValue(mockClaudeResponse);
    vi.mocked(tts.speak).mockResolvedValue({
      audioBuffer: new ArrayBuffer(0),
      format: "wav",
      cached: false,
      cachePath: "data/audio/local-library.wav",
    });

    const result = await pipeline.runPipeline("random_discover");

    expect(claude.buildContextPrompt).toHaveBeenCalledWith(expect.objectContaining({
      candidateContext: expect.stringContaining("Library Song - Library Artist"),
    }));
    expect(netease.searchSongs).not.toHaveBeenCalled();
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
