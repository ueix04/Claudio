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
    expect(summary.criteria.map((criterion) => criterion.planText)).toEqual([
      "连续播放 20 分钟时，整体像一档节目，而不是一串推荐。",
      "DJ 话术不重复、不频繁问候、不每次提天气。",
      "用户能感觉 Claudio 在承接上下文和音乐情绪。",
    ]);
    expect(summary.criteria.map((criterion) => criterion.recordId)).toEqual([
      "listen_ok",
      "listen_ok",
      "listen_ok",
    ]);
    expect(summary.criteria[0].evidence).toMatchObject({
      recordId: "listen_ok",
      durationMs: 1_200_000,
      note: "Felt cohesive.",
    });
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

  it("requires new clean evidence after a newer review record", () => {
    const olderClean = makeRecord({
      id: "listen_old_clean",
      recordedAt: 1_200_002,
    });
    const newerProblem = makeRecord({
      id: "listen_new_problem",
      needsFollowUp: true,
      recordedAt: 1_300_002,
    });

    const blocked = summarizeListenAcceptance([newerProblem, olderClean]);

    expect(blocked.ready).toBe(false);
    expect(blocked.criteria.every((criterion) => !criterion.passed)).toBe(true);

    const newestClean = makeRecord({
      id: "listen_new_clean",
      recordedAt: 1_400_002,
    });
    const ready = summarizeListenAcceptance([newestClean, newerProblem, olderClean]);

    expect(ready.ready).toBe(true);
    expect(ready.criteria.map((criterion) => criterion.recordId)).toEqual([
      "listen_new_clean",
      "listen_new_clean",
      "listen_new_clean",
    ]);
  });
});
