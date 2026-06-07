import { describe, expect, it } from "vitest";
import type { ListenCheckRecord } from "./db.js";
import { summarizeListenAcceptance } from "./listen-acceptance.js";

const makeRecord = (patch: Partial<ListenCheckRecord> = {}): ListenCheckRecord => ({
  id: "listen_ok",
  startedAt: 1,
  completedAt: 1_200_001,
  durationMs: 1_200_000,
  checks: { program: true, dj: true, context: true },
  note: "Felt cohesive.",
  needsFollowUp: false,
  programAudit: {
    ok: true,
    plannedMinutes: 24,
    trackCount: 6,
    speechSlotCount: 3,
    issueCount: 0,
  },
  recordedAt: 1_200_002,
  ...patch,
});

describe("listen acceptance summary", () => {
  it("marks acceptance ready when a clean 20-minute listen proves all criteria", () => {
    const summary = summarizeListenAcceptance([makeRecord()], 2_000_000);

    expect(summary.ready).toBe(true);
    expect(summary.status).toBe("ready");
    expect(summary.targetMinutes).toBe(20);
    expect(summary.criteria).toHaveLength(3);
    expect(summary.criteria.every((criterion) => criterion.passed)).toBe(true);
    expect(summary.criteria.map((criterion) => criterion.recordId)).toEqual([
      "listen_ok",
      "listen_ok",
      "listen_ok",
    ]);
  });

  it("keeps acceptance in review when the latest listen needs follow-up", () => {
    const summary = summarizeListenAcceptance([
      makeRecord({ needsFollowUp: true, note: "DJ repeated a greeting." }),
    ]);

    expect(summary.ready).toBe(false);
    expect(summary.status).toBe("needs_review");
    expect(summary.latestRecord?.needsFollowUp).toBe(true);
    expect(summary.criteria.every((criterion) => !criterion.passed)).toBe(true);
    expect(summary.criteria[0].detail).toContain("follow-up");
  });
});
