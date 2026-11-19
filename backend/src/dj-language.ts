import type { DjProfile } from "./db.js";
import "./runtime.js";

export type DjCopyLanguage = "zh" | "en";

export const DJ_SPEECH_GUIDANCE: Record<DjCopyLanguage, string> = {
  zh: "篇幅跟着内容和当下的节目节奏走。值得展开的细节把它说完，说到自然的落点就收尾。",
  en: "Let the amount of speech follow the subject and the pace of the show. Give details room when they matter, and end where the thought naturally lands.",
};

export const TTS_DIRECTION_FIELD: Record<DjCopyLanguage, string> = {
  zh: "- ttsDirection: 可选的导演提示，只写怎么读。根据台词给出情绪底色，有需要时混合相容的情绪、指明段落间的语气变化，或点出具体停顿和重音。保持自然聊天语速和克制的表演。",
  en: "- ttsDirection: optional performance direction tailored to the script. Set the emotional baseline and, where it helps, blend compatible emotions, describe transitions in tone, or indicate exact pauses and words to stress. Keep the delivery conversational and restrained.",
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
