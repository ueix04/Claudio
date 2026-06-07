import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DjProfile } from "./db.js";
import "./runtime.js";
import { audioDir, repoRoot } from "./runtime.js";
import { fetchWithProxyFallback } from "./network.js";

export interface TTSResult {
  audioBuffer: ArrayBuffer;
  format: string;
  cached: boolean;
  cachePath?: string;
}

export interface TTSSpeakOptions {
  profile?: Partial<DjProfile>;
  scene?: "program_intro" | "music_recommendation" | "segue" | "chat_reply";
  atmosphere?: string;
}

export const TTS_PRESET_NAMES = ["冰糖", "Dean"] as const;
export type TtsPresetName = typeof TTS_PRESET_NAMES[number];

type MimoTtsModel =
  | "mimo-v2.5-tts"
  | "mimo-v2.5-tts-voicedesign"
  | "mimo-v2.5-tts-voiceclone";

interface ResolvedMimoRequest {
  model: MimoTtsModel;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  audio: {
    format: "wav";
    voice?: string;
  };
  cacheVariant: string;
}

const DEFAULT_MIMO_API_BASE = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL: MimoTtsModel = "mimo-v2.5-tts";
const DEFAULT_MIMO_VOICE: TtsPresetName = "冰糖";
const AUDIO_CACHE_DIR = audioDir;

const TTS_PRESET_CONFIG: Record<TtsPresetName, { voice: string; character: string }> = {
  冰糖: {
    voice: "冰糖",
    character:
      "内置音色“冰糖”。她不是温吞的抒情女声，而是明亮、轻盈、灵动、带一点少女感与真实呼吸感的陪伴型主播。她可以活泼、俏皮、带笑意，但不能幼稚做作，也不能一直悬浮发甜。真正进入深夜、雨夜、钢琴或安静氛围时，她会主动把亮度收住，保留灵气，但不抢戏。",
  },
  Dean: {
    voice: "Dean",
    character:
      "Built-in voice preset \"Dean\". His baseline tone is relaxed, close-mic, slightly lower, with a touch of warmth and magnetism, like a real late-night radio host speaking directly to one listener. He should never sound preachy or artificially deep. Keep the delivery natural, restrained, and breathable. When the mood drops, he can settle lower and darker; when the mood opens up, he should still stay calm, warm, and effortless.",
  },
};

function shouldUseEnglishPrompt(preset: TtsPresetName): boolean {
  return preset === "Dean";
}

function getMimoApiKey(): string {
  return (process.env.MIMO_API_KEY || "").trim();
}

function getMimoApiBase(): string {
  return (process.env.MIMO_API_BASE || DEFAULT_MIMO_API_BASE).trim().replace(/\/+$/, "");
}

export function normalizeTtsPresetName(raw?: string): TtsPresetName {
  const value = (raw || "").trim();
  if (value === "Dean") return "Dean";
  if (value === "冰糖") return "冰糖";
  if ((process.env.MIMO_TTS_VOICE || "").trim() === "Dean") return "Dean";
  return DEFAULT_MIMO_VOICE;
}

function getMimoVoiceSamplePath(): string {
  return (process.env.MIMO_TTS_VOICE_SAMPLE_PATH || "").trim();
}

function parseMimoModel(raw: string | undefined): MimoTtsModel {
  switch ((raw || "").trim().toLowerCase()) {
    case "mimo-v2.5-tts-voicedesign":
      return "mimo-v2.5-tts-voicedesign";
    case "mimo-v2.5-tts-voiceclone":
      return "mimo-v2.5-tts-voiceclone";
    case "mimo-v2.5-tts":
    case "":
      return DEFAULT_MIMO_MODEL;
    default:
      throw new Error(
        `Unsupported MIMO_TTS_MODEL: ${raw}. Expected one of mimo-v2.5-tts, mimo-v2.5-tts-voicedesign, mimo-v2.5-tts-voiceclone`,
      );
  }
}

function hashText(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function getCacheFileName(text: string, variant: string): string {
  return `mimo-${hashText(variant)}-${hashText(text)}.wav`;
}

function getMimeTypeForSample(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    default:
      throw new Error("MIMO_TTS_VOICE_SAMPLE_PATH must point to a .wav or .mp3 file");
  }
}

function composeGeneralStylePrompt(profile?: Partial<DjProfile>): string {
  return composeGeneralStylePromptWithContext("", { profile });
}

function composeVoiceDesignPrompt(profile?: Partial<DjProfile>): string {
  const preset = normalizeTtsPresetName(profile?.voice);
  const presetConfig = TTS_PRESET_CONFIG[preset];
  const useEnglish = shouldUseEnglishPrompt(preset);
  const parts = [
    useEnglish ? `Reference preset voice: ${presetConfig.voice}` : `参考预设音色：${presetConfig.voice}`,
    useEnglish ? `Character brief: ${presetConfig.character}` : `角色设定：${presetConfig.character}`,
    profile?.style
      ? useEnglish ? `Performance style: ${profile.style}` : `表达风格：${profile.style}`
      : "",
    profile?.name
      ? useEnglish ? `Persona name: ${profile.name}` : `角色名：${profile.name}`
      : "",
  ];

  const prompt = parts
    .filter(Boolean)
    .join(useEnglish ? "; " : "；")
    .trim();

  if (!prompt) {
    throw new Error("MiMo VoiceDesign requires preset or djProfile style/name to describe the target voice");
  }

  return prompt;
}

function buildSceneInstruction(
  scene?: TTSSpeakOptions["scene"],
  atmosphere?: string,
  preset?: TtsPresetName,
): string {
  const useEnglish = preset ? shouldUseEnglishPrompt(preset) : false;
  const atmosphereLine = atmosphere
    ? useEnglish ? `Atmosphere note: ${atmosphere}` : `当前氛围补充：${atmosphere}`
    : "";

  if (useEnglish) {
    switch (scene) {
      case "program_intro":
        return [
          "The show is just opening. Use the first lines to bring the listener into the mood of this moment.",
          "Sound like a real DJ opening the mic, not a machine announcement and not a formal news anchor.",
          atmosphereLine,
        ].filter(Boolean).join("\n");
      case "music_recommendation":
        return [
          "You are easing a song into the set. Recommend it like a DJ in a natural flow, not like reading a playlist.",
          "Gently move the listener toward the next song so it feels inevitable and right for this moment.",
          atmosphereLine,
        ].filter(Boolean).join("\n");
      case "segue":
        return [
          "The previous song has just ended and you are handling a brief between-song segue.",
          "This is a transition, not a fresh opening and not a long monologue. Keep it short and smooth.",
          atmosphereLine,
        ].filter(Boolean).join("\n");
      case "chat_reply":
        return [
          "You are replying to one listener in real time, like a live DJ speaking close to the mic.",
          "Keep it conversational and immediate, not performative or overly formal.",
          atmosphereLine,
        ].filter(Boolean).join("\n");
      default:
        return [
          "Deliver a natural spoken line that sounds human, not mechanical.",
          atmosphereLine,
        ].filter(Boolean).join("\n");
    }
  }

  switch (scene) {
    case "program_intro":
      return [
        "刚刚开麦进入节目，正在用第一段声音把听众带进今晚/此刻的氛围。",
        "要像真人 DJ 自然开场，而不是机器播报，也不要像新闻主持人念稿。",
        atmosphereLine,
      ].filter(Boolean).join("\n");
    case "music_recommendation":
      return [
        "正在把一首歌顺进节目里，要像 DJ 在自然推荐，不要像列表播报。",
        "重点是把听感轻轻推向下一首歌，让听众觉得这首歌就是此刻该出现。",
        atmosphereLine,
      ].filter(Boolean).join("\n");
    case "segue":
      return [
        "上一首刚结束，正在进行歌曲之间的串场衔接。",
        "这是接歌，不是重新开场，也不是长篇独白，句子要更短更顺。",
        atmosphereLine,
      ].filter(Boolean).join("\n");
    case "chat_reply":
      return [
        "正在和听众一对一聊天，要有即时反应感，像真人 DJ 贴着麦克风在回话。",
        "不是朗诵，也不是正式演讲，要保留口语气和互动感。",
        atmosphereLine,
      ].filter(Boolean).join("\n");
    default:
      return [
        "正在进行一段自然播报，要像真人说话，不要机械。",
        atmosphereLine,
      ].filter(Boolean).join("\n");
  }
}

function buildDirectionInstruction(
  scene?: TTSSpeakOptions["scene"],
  preset?: TtsPresetName,
  textLength?: number,
): string {
  const useEnglish = preset ? shouldUseEnglishPrompt(preset) : false;

  if (useEnglish) {
    const baseLength = textLength && textLength > 80
      ? "If the copy is longer, shape it with natural breathing and phrasing instead of pushing through in one pass."
      : "If the copy is short, make it feel spontaneous and spoken, not stretched for effect.";
    const presetDirection = "Place the voice slightly farther back, stay relaxed, and avoid overly bright tail endings.";

    switch (scene) {
      case "program_intro":
        return [
          "Use the first two lines to establish the atmosphere before you let the emotion reach the listener.",
          "Keep the pace natural with light pauses. Do not rush and do not sound rehearsed.",
          presetDirection,
          baseLength,
        ].join("\n");
      case "music_recommendation":
        return [
          "Recommend the song like you are handing a friend something that fits this exact moment.",
          "A slight smile or lift is fine, but never push it into hype or performance mode.",
          presetDirection,
          baseLength,
        ].join("\n");
      case "segue":
        return [
          "A segue should be short, smooth, and intimate. Its job is to connect the last song to the next one.",
          "Do not reintroduce yourself, do not restart the show, and do not drift into a long reflective speech.",
          presetDirection,
          baseLength,
        ].join("\n");
      case "chat_reply":
        return [
          "Reply like a real radio DJ answering a listener immediately after hearing them.",
          "Let there be a little breath, thought, or a small smile if needed, but keep the tone controlled.",
          presetDirection,
          baseLength,
        ].join("\n");
      default:
        return [
          presetDirection,
          baseLength,
          "Preserve the feeling of real speech instead of a formal announcer delivery.",
        ].join("\n");
    }
  }

  const baseLength = textLength && textLength > 80
    ? "文本偏长时要有自然停连和呼吸，不要一口气念完。"
    : "文本偏短时像真人即兴说出来，不要故意拖长。";

  const presetDirection = preset === "Dean"
    ? "声音位置可以略靠后一点，语气更松弛，尾音少收得太亮。"
    : "允许有一点明亮笑意和轻巧起伏，但不要一直飘着发甜。";

  switch (scene) {
    case "program_intro":
      return [
        "开场的前两句要把氛围先立住，再把情绪慢慢送到听众面前。",
        "语速自然，允许轻微停顿，不要过快，不要像背稿。",
        presetDirection,
        baseLength,
      ].join("\n");
    case "music_recommendation":
      return [
        "像给朋友推荐一首此刻刚好合适的歌，语气自然，有一点点带入感，但不要夸张。",
        "推荐语可以有轻微笑意或小幅情绪抬升，但不要喊麦。",
        presetDirection,
        baseLength,
      ].join("\n");
    case "segue":
      return [
        "串场要短、顺、贴耳，重点是把上一首和下一首轻轻接上。",
        "不要重新自我介绍，不要像节目重新开始，也不要大段抒情。",
        presetDirection,
        baseLength,
      ].join("\n");
    case "chat_reply":
      return [
        "像真人电台 DJ 在听完对方一句话后立刻回应，句子口语化，停顿自然。",
        "可以带轻微呼吸感、轻笑感或思考感，但不要腔调太满。",
        presetDirection,
        baseLength,
      ].join("\n");
    default:
      return [
        presetDirection,
        baseLength,
        "保持真实说话感，不要机械。",
      ].join("\n");
  }
}

function composeGeneralStylePromptWithContext(
  text: string,
  options?: TTSSpeakOptions,
): string {
  const profile = options?.profile;
  const preset = normalizeTtsPresetName(profile?.voice);
  const presetConfig = TTS_PRESET_CONFIG[preset];
  const useEnglish = shouldUseEnglishPrompt(preset);
  const extraVoiceNote = profile?.voice && !TTS_PRESET_NAMES.includes(profile.voice as TtsPresetName)
    ? useEnglish ? `Additional voice note: ${profile.voice}.` : `补充声音气质：${profile.voice}。`
    : "";
  const roleLine = profile?.name
    ? useEnglish ? `Persona name: ${profile.name}` : `角色名：${profile.name}`
    : useEnglish ? "Persona name: Claudio" : "角色名：Claudio";
  const styleLine = profile?.style
    ? useEnglish ? `Show style: ${profile.style}` : `节目风格：${profile.style}`
    : useEnglish ? "Show style: emotional radio" : "节目风格：情感电台";
  const characterBlock = [
    "CHARACTER",
    roleLine,
    useEnglish ? `Use preset voice: ${presetConfig.voice}` : `使用正确音色：${presetConfig.voice}`,
    presetConfig.character,
    extraVoiceNote,
    styleLine,
  ].filter(Boolean).join("\n");
  const sceneBlock = [
    "SCENE",
    buildSceneInstruction(options?.scene, options?.atmosphere, preset),
  ].join("\n");
  const directionBlock = [
    "DIRECTION",
    buildDirectionInstruction(options?.scene, preset, text.length),
    useEnglish
      ? "Avoid a formal announcer tone. Keep subtle motion, breath, and the texture of real spoken language."
      : "少用播音腔，保留一点真实口语里的轻微起伏和呼吸感。",
  ].join("\n");

  return [characterBlock, sceneBlock, directionBlock].join("\n\n");
}

async function resolveVoiceCloneSample(): Promise<{ dataUri: string; fingerprint: string }> {
  const samplePath = getMimoVoiceSamplePath();
  if (!samplePath) {
    throw new Error("MIMO_TTS_VOICE_SAMPLE_PATH is required when MIMO_TTS_MODEL=mimo-v2.5-tts-voiceclone");
  }

  const absolutePath = path.isAbsolute(samplePath)
    ? samplePath
    : path.join(repoRoot, samplePath);
  const sampleBuffer = await fs.readFile(absolutePath);
  const mimeType = getMimeTypeForSample(absolutePath);
  const base64Audio = sampleBuffer.toString("base64");

  return {
    dataUri: `data:${mimeType};base64,${base64Audio}`,
    fingerprint: hashText(sampleBuffer.toString("base64")),
  };
}

async function resolveMimoRequest(
  text: string,
  options?: TTSSpeakOptions,
): Promise<ResolvedMimoRequest> {
  const model = parseMimoModel(process.env.MIMO_TTS_MODEL);
  const profile = options?.profile;

  if (model === "mimo-v2.5-tts") {
    const preset = normalizeTtsPresetName(profile?.voice);
    const voice = TTS_PRESET_CONFIG[preset].voice;
    const stylePrompt = composeGeneralStylePromptWithContext(text, options);

    return {
      model,
      messages: [
        { role: "user", content: stylePrompt },
        { role: "assistant", content: text },
      ],
      audio: {
        format: "wav",
        voice,
      },
      cacheVariant: JSON.stringify({
        provider: "mimo",
        model,
        preset,
        voice,
        stylePrompt,
      }),
    };
  }

  if (model === "mimo-v2.5-tts-voicedesign") {
    const stylePrompt = composeVoiceDesignPrompt(profile);

    return {
      model,
      messages: [
        { role: "user", content: stylePrompt },
        { role: "assistant", content: text },
      ],
      audio: {
        format: "wav",
      },
      cacheVariant: JSON.stringify({
        provider: "mimo",
        model,
        stylePrompt,
      }),
    };
  }

  const voiceClone = await resolveVoiceCloneSample();
  const stylePrompt = composeGeneralStylePrompt(profile);

  return {
    model,
    messages: [
      { role: "user", content: stylePrompt },
      { role: "assistant", content: text },
    ],
    audio: {
      format: "wav",
      voice: voiceClone.dataUri,
    },
    cacheVariant: JSON.stringify({
      provider: "mimo",
      model,
      stylePrompt,
      voiceFingerprint: voiceClone.fingerprint,
    }),
  };
}

async function readCachedAudio(cachePath: string): Promise<TTSResult> {
  const absolutePath = path.join(repoRoot, cachePath);
  const buffer = await fs.readFile(absolutePath);
  return {
    audioBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    format: "wav",
    cached: true,
    cachePath,
  };
}

export async function cacheAudio(
  text: string,
  audioBuffer: ArrayBuffer,
  variant: string = "mimo",
): Promise<string> {
  const fileName = getCacheFileName(text, variant);
  const filePath = path.join(AUDIO_CACHE_DIR, fileName);

  await fs.mkdir(AUDIO_CACHE_DIR, { recursive: true });
  await fs.writeFile(filePath, Buffer.from(audioBuffer));

  return path.posix.join("data", "audio", fileName);
}

export async function getCachedAudio(
  text: string,
  variant: string = "mimo",
): Promise<string | null> {
  const fileName = getCacheFileName(text, variant);

  try {
    await fs.access(path.join(AUDIO_CACHE_DIR, fileName));
    return path.posix.join("data", "audio", fileName);
  } catch {
    return null;
  }
}

export async function synthesize(
  text: string,
  options?: TTSSpeakOptions,
): Promise<TTSResult> {
  const apiKey = getMimoApiKey();
  if (!apiKey) {
    throw new Error("MIMO_API_KEY is missing");
  }

  const request = await resolveMimoRequest(text, options);
  return synthesizeWithResolvedRequest(apiKey, request);
}

async function synthesizeWithResolvedRequest(
  apiKey: string,
  request: ResolvedMimoRequest,
): Promise<TTSResult> {
  const response = await fetchWithProxyFallback(
    `${getMimoApiBase()}/chat/completions`,
    {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        audio: request.audio,
      }),
    },
    "MiMo TTS",
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MiMo API error: ${response.status} ${errorText}`);
  }

  const payload = await response.json() as {
    choices?: Array<{
      message?: {
        audio?: {
          data?: string;
        };
      };
    }>;
  };
  const base64Audio = payload.choices?.[0]?.message?.audio?.data;
  if (!base64Audio) {
    throw new Error("MiMo response did not include audio data");
  }

  const audioBuffer = Buffer.from(base64Audio, "base64");
  return {
    audioBuffer: audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength),
    format: "wav",
    cached: false,
  };
}

export async function speak(
  text: string,
  options?: TTSSpeakOptions,
): Promise<TTSResult> {
  const apiKey = getMimoApiKey();
  if (!apiKey) {
    throw new Error("MIMO_API_KEY is missing");
  }

  const request = await resolveMimoRequest(text, options);
  const cachedPath = await getCachedAudio(text, request.cacheVariant);
  if (cachedPath) {
    return readCachedAudio(cachedPath);
  }

  const result = await synthesizeWithResolvedRequest(apiKey, request);
  const cachePath = await cacheAudio(text, result.audioBuffer, request.cacheVariant);

  return {
    ...result,
    cached: false,
    cachePath,
  };
}
