import type { ListenCheckRecord } from "./db.js";

export type ListenAcceptanceCriterionId = "program" | "dj" | "context";

export interface ListenAcceptanceCriterion {
  id: ListenAcceptanceCriterionId;
  label: string;
  passed: boolean;
  detail: string;
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
    needsFollowUp: boolean;
    issueCount: number | null;
  };
  criteria: ListenAcceptanceCriterion[];
  generatedAt: number;
}

const TARGET_LISTEN_MS = 20 * 60 * 1000;

const CRITERIA: Array<{ id: ListenAcceptanceCriterionId; label: string; passDetail: string }> = [
  {
    id: "program",
    label: "Program feel",
    passDetail: "A clean 20-minute listen confirmed the set works as one program.",
  },
  {
    id: "dj",
    label: "DJ restraint",
    passDetail: "A clean 20-minute listen confirmed restrained DJ talk.",
  },
  {
    id: "context",
    label: "Context flow",
    passDetail: "A clean 20-minute listen confirmed the context and mood carry through.",
  },
];

const getIssueCount = (record: ListenCheckRecord) =>
  typeof record.programAudit?.issueCount === "number" ? record.programAudit.issueCount : null;

const isCleanEvidenceRecord = (record: ListenCheckRecord, criterion: ListenAcceptanceCriterionId) =>
  record.durationMs >= TARGET_LISTEN_MS
    && record.checks[criterion] === true
    && record.needsFollowUp !== true
    && record.programAudit?.ok === true
    && getIssueCount(record) === 0;

function describeBlocker(records: ListenCheckRecord[]): string {
  const latest = records[0];
  if (!latest) return "No saved 20-minute listen check yet.";
  if (latest.durationMs < TARGET_LISTEN_MS) return "Latest listen record is shorter than 20 minutes.";
  if (latest.needsFollowUp === true) return "Latest listen record is marked for follow-up.";
  if (!latest.programAudit) return "Latest listen record has no program audit snapshot.";
  if (latest.programAudit.ok !== true || getIssueCount(latest) !== 0) {
    return `Latest listen record has ${getIssueCount(latest) ?? "unknown"} audit issues.`;
  }
  return "Latest listen record is missing this subjective confirmation.";
}

export function summarizeListenAcceptance(
  records: ListenCheckRecord[],
  generatedAt = Date.now(),
): ListenAcceptanceSummary {
  const criteria = CRITERIA.map((criterion) => {
    const record = records.find((candidate) => isCleanEvidenceRecord(candidate, criterion.id));
    return {
      id: criterion.id,
      label: criterion.label,
      passed: Boolean(record),
      detail: record ? criterion.passDetail : describeBlocker(records),
      recordId: record?.id,
      recordedAt: record?.recordedAt,
    };
  });
  const ready = criteria.every((criterion) => criterion.passed);
  const latest = records[0];

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
          needsFollowUp: latest.needsFollowUp === true,
          issueCount: getIssueCount(latest),
        }
      : undefined,
    criteria,
    generatedAt,
  };
}
