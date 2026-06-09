import type { AppState, ChatMessage, RadioProgram, RadioSpeechSlot, Track } from "./db.js";
import { buildDefaultSpeechPlan, estimateProgramMinutes } from "./radio-session.js";

type AuditStatus = "pass" | "warning" | "fail";

export interface ProgramAuditCheck {
  id: string;
  label: string;
  status: AuditStatus;
  detail: string;
}

export interface ProgramExperienceAudit {
  ok: boolean;
  generatedAt: number;
  program?: {
    sessionId?: string;
    title?: string;
    mood?: string;
    source?: RadioProgram["source"];
    generatedAt?: number;
  };
  trackCount: number;
  plannedMinutes: number;
  speechSlotCount: number;
  djLineCount: number;
  checks: ProgramAuditCheck[];
  issues: ProgramAuditCheck[];
}

const WEATHER_RE = /天气|气温|温度|湿度|下雨|下雪|forecast|weather|temperature|rain|snow|cloudy|sunny/i;
const RESTART_GREETING_RE = /大家好|早上好|下午好|晚上好|欢迎回来|欢迎收听|我是\s*Claudio|这里是|good morning|good afternoon|good evening|welcome back|i'?m\s+claudio|this is claudio/i;
const ABSTRACT_DJ_RE = /氛围|情绪|温度|夜色|灯光|空气|房间|故事|梦|灵魂|宇宙|城市|呼吸|atmosphere|vibe|mood|room|light|temperature|story|dream|soul|city|air/i;
const CONCRETE_MUSIC_RE = /上一首|下一首|这首|接|收|放|旋律|节奏|人声|鼓|吉他|钢琴|贝斯|合成器|音色|副歌|track|song|next|previous|tempo|vocal|rhythm|melody|beat|guitar|piano|synth|texture|chorus|bass/i;

function normalizeLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。！？、,.!?;:()[\]{}"'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSpeechPlan(state: AppState): RadioSpeechSlot[] {
  const queueLength = state.radioQueue.length;
  if (state.currentProgram?.speechPlan?.length) {
    return state.currentProgram.speechPlan;
  }
  return buildDefaultSpeechPlan(queueLength);
}

function getDjLines(chatHistory: ChatMessage[], currentProgramGeneratedAt?: number): string[] {
  return chatHistory
    .filter((message) => (
      message.role === "dj"
      && (
        !currentProgramGeneratedAt
        || message.timestamp >= currentProgramGeneratedAt
      )
    ))
    .map((message) => message.text.trim())
    .filter(Boolean);
}

function countDuplicateLines(lines: string[]): number {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const line of lines.map(normalizeLine).filter(Boolean)) {
    if (seen.has(line)) {
      duplicated.add(line);
    }
    seen.add(line);
  }
  return duplicated.size;
}

function countDuplicateTracks(queue: Track[]): number {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const track of queue) {
    const key = `${track.name.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`;
    if (key === "::") {
      continue;
    }
    if (seen.has(key)) {
      duplicated.add(key);
    }
    seen.add(key);
  }
  return duplicated.size;
}

function countAbstractOnlyLines(lines: string[]): number {
  return lines.filter((line) => ABSTRACT_DJ_RE.test(line) && !CONCRETE_MUSIC_RE.test(line)).length;
}

function countLongDjLines(lines: string[]): number {
  return lines.filter((line) => line.length > 95).length;
}

function buildCheck(id: string, label: string, status: AuditStatus, detail: string): ProgramAuditCheck {
  return { id, label, status, detail };
}

export function auditProgramExperience(state: AppState): ProgramExperienceAudit {
  const queue = Array.isArray(state.radioQueue) ? state.radioQueue : [];
  const speechPlan = getSpeechPlan({ ...state, radioQueue: queue });
  const plannedMinutes = state.currentProgram?.plannedMinutes ?? estimateProgramMinutes(queue);
  const djLines = getDjLines(state.chatHistory, state.currentProgram?.generatedAt);
  const checks: ProgramAuditCheck[] = [];

  checks.push(buildCheck(
    "duration_target",
    "20 minute program target",
    queue.length > 0 && plannedMinutes >= 20 ? "pass" : "fail",
    queue.length > 0
      ? `Program target is ${plannedMinutes} minutes with ${queue.length} tracks.`
      : "No queue is available for a long-form program audit.",
  ));

  const duplicateTrackCount = countDuplicateTracks(queue);
  checks.push(buildCheck(
    "queue_continuity",
    "Queue continuity",
    queue.length >= 3 && duplicateTrackCount === 0 ? "pass" : "fail",
    `Queue has ${queue.length} tracks and ${duplicateTrackCount} repeated track keys.`,
  ));

  const introSlots = speechPlan.filter((slot) => slot.type === "intro");
  const invalidIntroSlots = introSlots.filter((slot) => slot.beforeTrackIndex !== 0);
  checks.push(buildCheck(
    "single_intro",
    "Single opening",
    introSlots.length <= 1 && invalidIntroSlots.length === 0 ? "pass" : "fail",
    `Found ${introSlots.length} intro slot(s); ${invalidIntroSlots.length} are not before the first track.`,
  ));

  const talkSlots = speechPlan.filter((slot) => slot.type !== "intro");
  const tooEarlyTalk = talkSlots.some((slot) => slot.beforeTrackIndex === 1);
  const talksTooOften = speechPlan.length >= queue.length || talkSlots.length > Math.ceil(queue.length / 2);
  checks.push(buildCheck(
    "speech_cadence",
    "Speech cadence",
    !tooEarlyTalk && !talksTooOften ? "pass" : "fail",
    `Speech plan has ${speechPlan.length} slot(s) for ${queue.length} track(s); non-intro slots: ${talkSlots.length}.`,
  ));

  const weatherMentions = djLines.filter((line) => WEATHER_RE.test(line)).length;
  checks.push(buildCheck(
    "weather_restraint",
    "Weather restraint",
    weatherMentions <= 1 ? "pass" : "fail",
    `Recent DJ history contains ${weatherMentions} weather-related line(s).`,
  ));

  const restartGreetings = djLines.filter((line) => RESTART_GREETING_RE.test(line)).length;
  checks.push(buildCheck(
    "restart_greetings",
    "No repeated show restart",
    restartGreetings <= 1 ? "pass" : "fail",
    `Recent DJ history contains ${restartGreetings} restart-style greeting line(s).`,
  ));

  const duplicateLineCount = countDuplicateLines(djLines);
  checks.push(buildCheck(
    "line_repetition",
    "Line repetition",
    duplicateLineCount === 0 ? "pass" : "fail",
    `Recent DJ history contains ${duplicateLineCount} exact repeated DJ line(s).`,
  ));

  const abstractOnlyLineCount = countAbstractOnlyLines(djLines);
  const longLineCount = countLongDjLines(djLines);
  checks.push(buildCheck(
    "dj_specificity",
    "DJ specificity",
    abstractOnlyLineCount <= 1 && longLineCount === 0 ? "pass" : "fail",
    `Recent DJ history has ${abstractOnlyLineCount} abstract-only line(s) and ${longLineCount} long monologue line(s).`,
  ));

  checks.push(buildCheck(
    "program_context",
    "Program context",
    state.currentProgram?.title || state.currentProgram?.mood || state.currentProgram?.summary || state.currentProgram?.userRequest
      ? "pass"
      : "warning",
    state.currentProgram
      ? "Program metadata contains contextual fields for handoff prompts."
      : "No current program metadata is available.",
  ));

  const issues = checks.filter((check) => check.status !== "pass");
  return {
    ok: checks.every((check) => check.status === "pass"),
    generatedAt: Date.now(),
    program: state.currentProgram
      ? {
          sessionId: state.currentProgram.sessionId,
          title: state.currentProgram.title,
          mood: state.currentProgram.mood,
          source: state.currentProgram.source,
          generatedAt: state.currentProgram.generatedAt,
        }
      : undefined,
    trackCount: queue.length,
    plannedMinutes,
    speechSlotCount: speechPlan.length,
    djLineCount: djLines.length,
    checks,
    issues,
  };
}
