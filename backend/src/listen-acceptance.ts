import type { ListenCheckRecord } from "./db.js";

export type ListenAcceptanceCriterionId =
  | "program"
  | "dj"
  | "context"
  | "reliability"
  | "exploration"
  | "feedback";

export interface ListenAcceptanceCriterion {
  id: ListenAcceptanceCriterionId;
  label: string;
  planText: string;
  passed: boolean;
  detail: string;
  evidence?: {
    recordId: string;
    recordedAt: number;
    durationMs: number;
    playbackMs: number;
    note?: string;
  };
  recordId?: string;
  recordedAt?: number;
}

export interface ListenAcceptanceSummary {
  ready: boolean;
  status: "waiting" | "needs_review" | "ready";
  targetMinutes: number;
  totalRecords: number;
  latestRecord?: {
    id: string;
    recordedAt: number;
    durationMs: number;
    playbackMs: number;
    missingPlaybackMs: number;
    checkCount: number;
    needsFollowUp: boolean;
    programAuditOk: boolean | null;
    issueCount: number | null;
    programContinuityOk: boolean | null;
    playbackIssueCount: number | null;
    fallbackCount: number | null;
    discoveryCount: number | null;
    feedbackCount: number | null;
    clientSignalSampleCount: number | null;
    clientSilentMs: number | null;
    clientMaxSilentRunMs: number | null;
  };
  criteria: ListenAcceptanceCriterion[];
  generatedAt: number;
}

const TARGET_LISTEN_MS = 20 * 60 * 1000;
const MAX_ALLOWED_CLIENT_SILENT_RUN_MS = 10 * 1000;

const CRITERIA: Array<{
  id: ListenAcceptanceCriterionId;
  label: string;
  planText: string;
  passDetail: string;
}> = [
  {
    id: "program",
    label: "Program feel",
    planText: "连续播放 20 分钟时，整体像一档节目，而不是一串推荐。",
    passDetail: "A clean 20-minute listen confirmed the set works as one program.",
  },
  {
    id: "dj",
    label: "DJ restraint",
    planText: "DJ 话术不重复、不频繁问候、不每次提天气。",
    passDetail: "A clean 20-minute listen confirmed restrained DJ talk.",
  },
  {
    id: "context",
    label: "Context flow",
    planText: "用户能感觉 Claudio 在承接上下文和音乐情绪。",
    passDetail: "A clean 20-minute listen confirmed the context and mood carry through.",
  },
  {
    id: "reliability",
    label: "Playback reliability",
    planText: "20 分钟内没有长时间静音，fallback 和播放错误都有记录。",
    passDetail: "A clean 20-minute listen recorded no unresolved playback issues.",
  },
  {
    id: "exploration",
    label: "Discovery evidence",
    planText: "20 分钟内至少出现一次可解释、可播放的探索。",
    passDetail: "A clean 20-minute listen included verified discovery evidence.",
  },
  {
    id: "feedback",
    label: "Feedback evidence",
    planText: "20 分钟内至少有一次用户反馈或隐性反馈进入后续调整。",
    passDetail: "A clean 20-minute listen included listener feedback evidence.",
  },
];

const getIssueCount = (record: ListenCheckRecord) =>
  typeof record.programAudit?.issueCount === "number" ? record.programAudit.issueCount : null;

const getPlaybackMs = (record: ListenCheckRecord) =>
  typeof record.playbackMs === "number" && Number.isFinite(record.playbackMs)
    ? record.playbackMs
    : record.durationMs;

const getPlaybackSegmentMs = (record: ListenCheckRecord) =>
  Array.isArray(record.playbackSegments)
    ? record.playbackSegments.reduce((total, segment) => (
        total + (Number.isFinite(segment.playedMs) && segment.playedMs > 0 ? segment.playedMs : 0)
      ), 0)
    : 0;

const getPlaybackEvidenceMs = (record: ListenCheckRecord) => {
  const playbackMs = getPlaybackMs(record);
  const segmentMs = getPlaybackSegmentMs(record);
  return segmentMs > 0 ? Math.min(playbackMs, segmentMs) : playbackMs;
};

const hasProgramContinuityEvidence = (record: ListenCheckRecord) =>
  record.programContinuity?.ok === true;

const countSubjectiveChecks = (record: ListenCheckRecord) =>
  ["program", "dj", "context"].reduce((total, id) => (
    total + (record.checks[id as "program" | "dj" | "context"] ? 1 : 0)
  ), 0);

function hasBaseCleanEvidence(record: ListenCheckRecord): boolean {
  return getPlaybackEvidenceMs(record) >= TARGET_LISTEN_MS
    && record.needsFollowUp !== true
    && record.programAudit?.ok === true
    && getIssueCount(record) === 0
    && hasProgramContinuityEvidence(record);
}

function isCleanEvidenceRecord(record: ListenCheckRecord, criterion: ListenAcceptanceCriterionId): boolean {
  if (!hasBaseCleanEvidence(record)) return false;
  if (criterion === "program" || criterion === "dj" || criterion === "context") {
    return record.checks[criterion] === true;
  }
  if (criterion === "reliability") {
    return (record.listenEvidence?.playbackIssueCount ?? Number.POSITIVE_INFINITY) === 0
      && (record.listenEvidence?.clientSignalSampleCount ?? 0) > 0
      && (record.listenEvidence?.clientMaxSilentRunMs ?? Number.POSITIVE_INFINITY) <= MAX_ALLOWED_CLIENT_SILENT_RUN_MS;
  }
  if (criterion === "exploration") {
    return (record.listenEvidence?.discoveryCount ?? 0) > 0;
  }
  if (criterion === "feedback") {
    return (record.listenEvidence?.feedbackCount ?? 0) > 0;
  }
  return false;
}

const isReviewRecord = (record: ListenCheckRecord) =>
  getPlaybackEvidenceMs(record) >= TARGET_LISTEN_MS
    && (
      record.needsFollowUp === true
      || !record.programAudit
      || record.programAudit.ok !== true
      || getIssueCount(record) !== 0
      || !hasProgramContinuityEvidence(record)
      || !record.listenEvidence
    );

function getLatestReviewRecord(records: ListenCheckRecord[]) {
  return records
    .filter(isReviewRecord)
    .sort((a, b) => b.recordedAt - a.recordedAt)[0];
}

function describeReviewRecord(record: ListenCheckRecord): string {
  if (record.needsFollowUp === true) {
    return "A newer 20-minute listen is marked for follow-up. Save a clean listen after it to pass this criterion.";
  }
  if (!record.programAudit) {
    return "A newer 20-minute listen has no program audit snapshot. Save a clean listen after it to pass this criterion.";
  }
  if (record.programAudit.ok === true && getIssueCount(record) === 0 && !hasProgramContinuityEvidence(record)) {
    return "A newer 20-minute listen has no continuous program evidence. Save a clean listen without changing programs to pass this criterion.";
  }
  if (!record.listenEvidence) {
    return "A newer 20-minute listen has no playback, discovery, or feedback evidence snapshot. Save a new listen check.";
  }
  return `A newer 20-minute listen has ${getIssueCount(record) ?? "unknown"} audit issues. Save a clean listen after it to pass this criterion.`;
}

function describeBlocker(records: ListenCheckRecord[], latestReviewRecord?: ListenCheckRecord): string {
  if (latestReviewRecord) return describeReviewRecord(latestReviewRecord);
  const latest = records[0];
  if (!latest) return "No saved 20-minute listen check yet.";
  if (getPlaybackEvidenceMs(latest) < TARGET_LISTEN_MS) return "Latest listen record has less than 20 minutes of actual playback.";
  if (latest.needsFollowUp === true) return "Latest listen record is marked for follow-up.";
  if (!latest.programAudit) return "Latest listen record has no program audit snapshot.";
  if (latest.programAudit.ok !== true || getIssueCount(latest) !== 0) {
    return `Latest listen record has ${getIssueCount(latest) ?? "unknown"} audit issues.`;
  }
  if (!hasProgramContinuityEvidence(latest)) {
    return "Latest listen record is missing continuous program evidence.";
  }
  if (!latest.listenEvidence) {
    return "Latest listen record is missing playback, discovery, and feedback evidence.";
  }
  return "Latest listen record is missing this subjective confirmation.";
}

function describeCriterionBlocker(
  criterion: ListenAcceptanceCriterionId,
  records: ListenCheckRecord[],
  latestReviewRecord?: ListenCheckRecord,
): string {
  const base = describeBlocker(records, latestReviewRecord);
  const latest = records[0];
  if (!latest || latestReviewRecord || !hasBaseCleanEvidence(latest)) return base;
  if (criterion === "reliability" && (latest.listenEvidence?.playbackIssueCount ?? 0) > 0) {
    return `Latest listen recorded ${latest.listenEvidence?.playbackIssueCount ?? 0} playback issue(s).`;
  }
  if (criterion === "reliability" && (latest.listenEvidence?.clientSignalSampleCount ?? 0) <= 0) {
    return "Latest clean listen has no browser audio signal evidence.";
  }
  if (
    criterion === "reliability"
    && (latest.listenEvidence?.clientMaxSilentRunMs ?? 0) > MAX_ALLOWED_CLIENT_SILENT_RUN_MS
  ) {
    const seconds = Math.round((latest.listenEvidence?.clientMaxSilentRunMs ?? 0) / 1000);
    return `Latest listen recorded a probable ${seconds}s silent run while playback was advancing.`;
  }
  if (criterion === "exploration") {
    return "Latest clean listen has no verified discovery track evidence.";
  }
  if (criterion === "feedback") {
    return "Latest clean listen has no listener feedback evidence during the 20-minute window.";
  }
  return base;
}

export function summarizeListenAcceptance(
  records: ListenCheckRecord[],
  generatedAt = Date.now(),
): ListenAcceptanceSummary {
  const latestReviewRecord = getLatestReviewRecord(records);
  const reviewCutoff = latestReviewRecord?.recordedAt ?? 0;
  const criteria = CRITERIA.map((criterion) => {
    const record = records.find((candidate) => (
      candidate.recordedAt > reviewCutoff
      && isCleanEvidenceRecord(candidate, criterion.id)
    ));
    return {
      id: criterion.id,
      label: criterion.label,
      planText: criterion.planText,
      passed: Boolean(record),
      detail: record ? criterion.passDetail : describeCriterionBlocker(criterion.id, records, latestReviewRecord),
      evidence: record
        ? {
            recordId: record.id,
            recordedAt: record.recordedAt,
            durationMs: record.durationMs,
            playbackMs: getPlaybackEvidenceMs(record),
            note: record.note,
          }
        : undefined,
      recordId: record?.id,
      recordedAt: record?.recordedAt,
    };
  });
  const ready = criteria.every((criterion) => criterion.passed);
  const latest = records[0];
  const latestPlaybackMs = latest ? getPlaybackEvidenceMs(latest) : 0;

  return {
    ready,
    status: ready ? "ready" : records.length > 0 ? "needs_review" : "waiting",
    targetMinutes: TARGET_LISTEN_MS / 60_000,
    totalRecords: records.length,
    latestRecord: latest
      ? {
          id: latest.id,
          recordedAt: latest.recordedAt,
          durationMs: latest.durationMs,
          playbackMs: latestPlaybackMs,
          missingPlaybackMs: Math.max(0, TARGET_LISTEN_MS - latestPlaybackMs),
          checkCount: countSubjectiveChecks(latest),
          needsFollowUp: latest.needsFollowUp === true,
          programAuditOk: latest.programAudit?.ok ?? null,
          issueCount: getIssueCount(latest),
          programContinuityOk: latest.programContinuity?.ok ?? null,
          playbackIssueCount: latest.listenEvidence?.playbackIssueCount ?? null,
          fallbackCount: latest.listenEvidence?.fallbackCount ?? null,
          discoveryCount: latest.listenEvidence?.discoveryCount ?? null,
          feedbackCount: latest.listenEvidence?.feedbackCount ?? null,
          clientSignalSampleCount: latest.listenEvidence?.clientSignalSampleCount ?? null,
          clientSilentMs: latest.listenEvidence?.clientSilentMs ?? null,
          clientMaxSilentRunMs: latest.listenEvidence?.clientMaxSilentRunMs ?? null,
        }
      : undefined,
    criteria,
    generatedAt,
  };
}
