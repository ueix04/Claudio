import { describe, expect, it } from "vitest";
import type { AppState, Track } from "./db.js";
import { auditProgramExperience } from "./program-audit.js";

function makeTrack(index: number, duration = 240000): Track {
  return {
    id: `track-${index}`,
    name: `Song ${index}`,
    artist: `Artist ${index}`,
    url: `/audio/${index}.mp3`,
    duration,
  };
}

function makeState(patch: Partial<AppState> = {}): AppState {
  return {
    status: "playing",
    currentTrack: null,
    radioQueue: [],
    currentQueueIndex: 0,
    currentProgram: null,
    chatHistory: [],
    playHistory: [],
    djProfile: { voice: "冰糖", style: "情感电台", name: "Claudio" },
    playlists: [],
    neteaseSnapshot: null,
    favorites: [],
    lastInteraction: 1,
    ...patch,
  };
}

describe("program experience audit", () => {
  it("passes a long-form show with restrained speech and varied DJ lines", () => {
    const queue = Array.from({ length: 6 }, (_, index) => makeTrack(index + 1));
    const audit = auditProgramExperience(makeState({
      currentTrack: queue[0],
      radioQueue: queue,
      currentProgram: {
        source: "startup",
        title: "Night Flow",
        mood: "quiet continuity",
        summary: "A 24 minute night program with spaced handoffs.",
        plannedMinutes: 24,
        speechPlan: [
          { beforeTrackIndex: 0, type: "intro", note: "开场" },
          { beforeTrackIndex: 2, type: "short_say", note: "承接前后氛围" },
          { beforeTrackIndex: 5, type: "bumper", note: "轻量 station ID" },
        ],
        generatedAt: 1,
      },
      chatHistory: [
        { role: "dj", text: "今晚先把灯光放低一点，慢慢进入这组歌。", timestamp: 1 },
        { role: "dj", text: "这段旋律往后收一点，下一首会更安静。", timestamp: 2 },
        { role: "user", text: "可以", timestamp: 3 },
      ],
    }));

    expect(audit.ok).toBe(true);
    expect(audit.issues).toHaveLength(0);
    expect(audit.trackCount).toBe(6);
    expect(audit.plannedMinutes).toBe(24);
  });

  it("flags short queues, repeated openings, weather overuse, and repeated lines", () => {
    const duplicateTrack = makeTrack(1, 120000);
    const audit = auditProgramExperience(makeState({
      radioQueue: [duplicateTrack, { ...duplicateTrack, id: "track-duplicate" }],
      currentProgram: {
        source: "startup",
        plannedMinutes: 8,
        speechPlan: [
          { beforeTrackIndex: 0, type: "intro", note: "开场" },
          { beforeTrackIndex: 1, type: "intro", note: "重复开场" },
          { beforeTrackIndex: 1, type: "short_say", note: "过密发言" },
        ],
        generatedAt: 1,
      },
      chatHistory: [
        { role: "dj", text: "晚上好，欢迎回来，我是 Claudio。", timestamp: 1 },
        { role: "dj", text: "晚上好，欢迎回来，我是 Claudio。", timestamp: 2 },
        { role: "dj", text: "今天的天气很适合慢慢听。", timestamp: 3 },
        { role: "dj", text: "气温也会影响这一段的氛围。", timestamp: 4 },
        { role: "dj", text: "这段夜色和房间里的灯光会把空气里的故事慢慢拉长，像一场梦一样推着我们继续往前走。", timestamp: 5 },
      ],
    }));

    expect(audit.ok).toBe(false);
    expect(audit.issues.map((issue) => issue.id)).toEqual(expect.arrayContaining([
      "duration_target",
      "queue_continuity",
      "single_intro",
      "speech_cadence",
      "weather_restraint",
      "restart_greetings",
      "line_repetition",
      "dj_specificity",
    ]));
  });

  it("ignores DJ history from before the current program", () => {
    const queue = Array.from({ length: 6 }, (_, index) => makeTrack(index + 1));
    const audit = auditProgramExperience(makeState({
      currentTrack: queue[0],
      radioQueue: queue,
      currentProgram: {
        source: "startup",
        title: "Fresh Program",
        mood: "fresh start",
        summary: "A new long-form session.",
        plannedMinutes: 24,
        speechPlan: [
          { beforeTrackIndex: 0, type: "intro", note: "开场" },
          { beforeTrackIndex: 2, type: "short_say", note: "承接" },
          { beforeTrackIndex: 5, type: "bumper", note: "station ID" },
        ],
        generatedAt: 10_000,
      },
      chatHistory: [
        { role: "dj", text: "晚上好，欢迎回来，我是 Claudio，今天的天气很适合慢慢听。", timestamp: 1 },
        { role: "dj", text: "晚上好，欢迎回来，我是 Claudio，今天的天气很适合慢慢听。", timestamp: 2 },
        { role: "dj", text: "我们把这段节目接稳，先让前几首歌自己展开。", timestamp: 10_001 },
      ],
    }));

    expect(audit.ok).toBe(true);
    expect(audit.djLineCount).toBe(1);
  });
});
