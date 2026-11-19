import type { DjProfile } from "./db.js";
import "./runtime.js";

export type DjCopyLanguage = "zh" | "en";

export const TTS_DIRECTION_FIELD: Record<DjCopyLanguage, string> = {
  zh: "- ttsDirection: 可选的一句导演提示，只写怎么读。根据台词给出情绪底色，有需要时混合相容的情绪、指明前后句的语气变化，或点出一句里的具体停顿和重音。以自然聊天语速和电台的克制表演为准。",
  en: "- ttsDirection: optional one-sentence performance direction tailored to this line. Set the emotional baseline and, where it helps, blend compatible emotions, describe a shift between sentences, or identify an exact pause or word to stress. Keep the delivery conversational and restrained.",
};

const PRESET_LANGUAGES = {
  冰糖: "zh",
  茉莉: "zh",
  苏打: "zh",
  白桦: "zh",
  Mia: "en",
  Chloe: "en",
  Milo: "en",
  Dean: "en",
} as const satisfies Record<string, DjCopyLanguage>;

export type TtsPresetName = keyof typeof PRESET_LANGUAGES;

export function getTtsPresetName(raw?: string): TtsPresetName | undefined {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value && Object.hasOwn(PRESET_LANGUAGES, value) ? value as TtsPresetName : undefined;
}

export function normalizeTtsPresetName(raw?: string): TtsPresetName {
  return getTtsPresetName(raw) ?? getTtsPresetName(process.env.MIMO_TTS_VOICE) ?? "冰糖";
}

export function resolveDjCopyLanguage(profile?: Partial<DjProfile> | null): DjCopyLanguage {
  return PRESET_LANGUAGES[normalizeTtsPresetName(profile?.voice)];
}

export function usesEnglishDjCopy(profile?: Partial<DjProfile> | null): boolean {
  return resolveDjCopyLanguage(profile) === "en";
}

export function pickDjCopy<T>(
  profile: Partial<DjProfile> | null | undefined,
  chineseValue: T,
  englishValue: T,
): T {
  return usesEnglishDjCopy(profile) ? englishValue : chineseValue;
}
