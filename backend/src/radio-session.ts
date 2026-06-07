import type { RadioProgram, RadioSpeechSlot, Track } from "./db.js";

export const MIN_PROGRAM_MINUTES = 20;
export const MAX_PROGRAM_MINUTES = 40;
const DEFAULT_TRACK_SECONDS = 210;

export type RadioSpeechSlotInput = Partial<RadioSpeechSlot> & {
  type?: string;
};

export interface RadioSessionMetadataInput {
  source: RadioProgram["source"];
  title?: string;
  mood?: string;
  summary?: string;
  generatedAt?: number;
  plannedMinutes?: number;
  weatherContext?: string;
  userRequest?: string;
  tracks: Track[];
  speechPlan?: RadioSpeechSlotInput[];
  preparedUntilIndex?: number;
}

function normalizeDurationSeconds(duration?: number): number {
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    return DEFAULT_TRACK_SECONDS;
  }

  return duration > 1000 ? duration / 1000 : duration;
}

export function estimateProgramMinutes(tracks: Array<Pick<Track, "duration">>): number {
  const totalSeconds = tracks.reduce((total, track) => total + normalizeDurationSeconds(track.duration), 0);
  return Math.max(1, Math.round(totalSeconds / 60));
}

function clampProgramMinutes(plannedMinutes: number | undefined, tracks: Track[]): number {
  const estimate = estimateProgramMinutes(tracks);
  const candidate = plannedMinutes && Number.isFinite(plannedMinutes)
    ? plannedMinutes
    : estimate;
  return Math.min(MAX_PROGRAM_MINUTES, Math.max(MIN_PROGRAM_MINUTES, Math.round(candidate)));
}

function normalizeSpeechType(type: string | undefined): RadioSpeechSlot["type"] {
  switch (type) {
    case "intro":
    case "short_say":
    case "bumper":
    case "closing":
      return type;
    default:
      return "short_say";
  }
}

export function buildDefaultSpeechPlan(trackCount: number): RadioSpeechSlot[] {
  if (trackCount <= 0) {
    return [];
  }

  const plan: RadioSpeechSlot[] = [
    { beforeTrackIndex: 0, type: "intro", note: "节目开场，只说一次" },
  ];

  for (let index = 2; index < trackCount; index += 3) {
    plan.push({
      beforeTrackIndex: index,
      type: "short_say",
      note: "短讲一次，承接前后氛围",
    });
  }

  if (trackCount >= 5) {
    plan.push({
      beforeTrackIndex: trackCount - 1,
      type: "bumper",
      note: "轻量 station ID 或收束提示",
    });
  }

  return plan;
}

export function normalizeSpeechPlan(
  speechPlan: RadioSpeechSlotInput[] | undefined,
  trackCount: number,
): RadioSpeechSlot[] {
  if (!speechPlan?.length) {
    return buildDefaultSpeechPlan(trackCount);
  }

  const normalized = speechPlan.flatMap((slot) => {
    const rawIndex = Number(slot.beforeTrackIndex);
    if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= trackCount) {
      return [];
    }

    return [{
      beforeTrackIndex: rawIndex,
      type: normalizeSpeechType(slot.type),
      note: typeof slot.note === "string" ? slot.note : undefined,
    } satisfies RadioSpeechSlot];
  });

  return normalized.length > 0 ? normalized : buildDefaultSpeechPlan(trackCount);
}

export function createRadioSessionId(source: RadioProgram["source"], generatedAt = Date.now()): string {
  return `${source}_${generatedAt.toString(36)}`;
}

export function createRadioProgramMetadata(input: RadioSessionMetadataInput): RadioProgram {
  const generatedAt = input.generatedAt ?? Date.now();
  return {
    source: input.source,
    sessionId: createRadioSessionId(input.source, generatedAt),
    title: input.title,
    mood: input.mood,
    summary: input.summary,
    plannedMinutes: clampProgramMinutes(input.plannedMinutes, input.tracks),
    speechPlan: normalizeSpeechPlan(input.speechPlan, input.tracks.length),
    preparedUntilIndex: input.preparedUntilIndex,
    generatedAt,
    weatherContext: input.weatherContext,
    userRequest: input.userRequest,
  };
}
