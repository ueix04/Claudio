import type { DjProfile } from "./db.js";

export type DjCopyLanguage = "zh" | "en";

function normalizeVoicePreset(raw?: string): "冰糖" | "Dean" {
  const value = (raw || "").trim();
  if (value === "Dean") return "Dean";
  if (value === "冰糖") return "冰糖";
  if ((process.env.MIMO_TTS_VOICE || "").trim() === "Dean") return "Dean";
  return "冰糖";
}

export function resolveDjCopyLanguage(profile?: Partial<DjProfile> | null): DjCopyLanguage {
  return normalizeVoicePreset(profile?.voice) === "Dean" ? "en" : "zh";
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
