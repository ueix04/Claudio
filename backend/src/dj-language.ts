import type { DjProfile } from "./db.js";
import "./runtime.js";

export type DjCopyLanguage = "zh" | "en";

export const DJ_SPEECH_GUIDANCE: Record<DjCopyLanguage, string> = {
  zh: "篇幅跟着内容和当下的节目节奏走。值得展开的细节把它说完，说到自然的落点就收尾。",
  en: "Let the amount of speech follow the subject and the pace of the show. Give details room when they matter, and end where the thought naturally lands.",
};

export const TTS_SCRIPT_FIELDS: Record<DjCopyLanguage, string> = {
  zh: `- ttsText: 给 MiMo 朗读的完整台词，和 say 含义一致，保留自然标点和段落。两个字段都只写听众会听到的话，把演绎指令写进 ttsDirection。
- ttsDirection: 可选的导演提示，可以写成多句。根据台词给出情绪底色，需要时混合相容的情绪，说明哪里换语气，或引用台词中的词来标明停顿和重音。保持自然聊天语速和克制的表演。
  示例台词「刚才那段钢琴收得很轻。接下来这首，留意开头的鼓点。」对应的导演提示可以写成「前半段放松，带一点回味。到『接下来这首』时语调微微抬起，在『鼓点』前稍停，轻轻加重这个词，再自然收尾。」请根据本次台词和场景写指导。`,
  en: `- ttsText: the full text for MiMo to read, with the same meaning as say. Keep natural punctuation and paragraph breaks. Both fields contain spoken words only. Put delivery notes in ttsDirection.
- ttsDirection: optional performance direction tailored to the script. It may span several sentences. Set the emotional baseline, blend compatible emotions where helpful, and use words from the script to anchor changes in tone, pauses, or emphasis. Keep the delivery conversational and restrained.
  For a script like “The piano faded gently on that one. On this next track, listen for the opening drums,” the direction could be “Start relaxed, with a hint of reflection. Lift slightly on ‘this next track,’ pause before ‘drums,’ then lean on that word and let the sentence settle.” Write the direction for the actual script and scene.`,
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
