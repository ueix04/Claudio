import { describe, expect, it } from "vitest";
import {
  createRadioProgramMetadata,
  estimateProgramMinutes,
  normalizeSpeechPlan,
} from "./radio-session.js";

describe("radio session metadata", () => {
  it("estimates program duration from track durations", () => {
    expect(estimateProgramMinutes([
      { duration: 180000 },
      { duration: 240000 },
      { duration: 210 },
    ])).toBe(11);
  });

  it("builds default speech spots without talking before every song", () => {
    const plan = normalizeSpeechPlan(undefined, 7);

    expect(plan[0]).toMatchObject({ beforeTrackIndex: 0, type: "intro" });
    expect(plan.some((slot) => slot.beforeTrackIndex === 1)).toBe(false);
    expect(plan.length).toBeLessThan(7);
  });

  it("creates session metadata with clamped 20-40 minute target", () => {
    const program = createRadioProgramMetadata({
      source: "startup",
      title: "Night Flow",
      mood: "quiet",
      summary: "gentle night show",
      plannedMinutes: 55,
      generatedAt: 123,
      tracks: [
        { id: "1", name: "Song A", artist: "Artist A", url: "a", duration: 180000 },
        { id: "2", name: "Song B", artist: "Artist B", url: "b", duration: 180000 },
      ],
    });

    expect(program.sessionId).toBe("startup_3f");
    expect(program.plannedMinutes).toBe(40);
    expect(program.mood).toBe("quiet");
    expect(program.speechPlan?.[0]).toMatchObject({ beforeTrackIndex: 0, type: "intro" });
  });
});
