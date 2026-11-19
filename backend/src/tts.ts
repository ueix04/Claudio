import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DjProfile } from "./db.js";
import { audioDir, repoRoot } from "./runtime.js";
import { getTtsPresetName, normalizeTtsPresetName, resolveDjCopyLanguage } from "./dj-language.js";
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
  direction?: string;
  onPcmChunk?: (base64: string) => void;
}

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
    optimize_text_preview?: false;
  };
  cacheVariant: string;
}

const DEFAULT_MIMO_API_BASE = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL: MimoTtsModel = "mimo-v2.5-tts";
const DEFAULT_MIMO_TIMEOUT_MS = 10_000;
const MAX_MIMO_SAMPLE_BASE64_BYTES = 10_000_000;
const PCM_SAMPLE_RATE = 24_000;
const PCM_BYTES_PER_SAMPLE = 2;
const AUDIO_CACHE_DIR = audioDir;

const DELIVERY = {
  zh: {
    base: "像电台 DJ 对一位听众说话。用清楚放松的声音和正常聊天语速，按标点短暂停连，句尾自然收住。中文和外文歌名都按各自语言自然读。",
    design: "二十多岁的普通话女电台主播。声线偏中音，明亮温和，吐字清楚，发声松弛。",
    scene: {
      program_intro: "开场有一点欢迎的笑意，第一句轻轻带起，接着顺势介绍节目。",
      music_recommendation: "像给朋友递一首歌，轻轻点出推荐的重点。",
      segue: "像在给听众接歌，按台词的意思自然停连，把情绪顺到下一首。",
      chat_reply: "像听完对方的话马上回应，语气亲切，根据内容自然展开和收尾。",
    },
    name: "主播名",
    style: "节目风格",
    atmosphere: "节目氛围",
    voiceNote: "声音气质",
    direction: "本段导演提示",
  },
  en: {
    base: "Speak like a radio DJ talking to one listener. Use a clear, relaxed voice at conversational speed. Pause briefly at punctuation and let the ends of sentences settle naturally. Pronounce song titles naturally in their own language.",
    design: "A male radio host in his thirties with a warm mid-range, clear diction, and a relaxed delivery.",
    scene: {
      program_intro: "Open with a small welcoming smile, then ease into the show.",
      music_recommendation: "Offer the song as you would to a friend, with a little emphasis on what to listen for.",
      segue: "Let the delivery flow naturally from the previous song into the next, with pauses that follow the thought.",
      chat_reply: "Answer as if you just heard the listener speak. Sound warm and spontaneous.",
    },
    name: "Host name",
    style: "Show style",
    atmosphere: "Atmosphere",
    voiceNote: "Voice note",
    direction: "Direction for this script",
  },
};

function getMimoApiKey(): string {
  return (process.env.MIMO_API_KEY || "").trim();
}

function getMimoApiBase(): string {
  return (process.env.MIMO_API_BASE || DEFAULT_MIMO_API_BASE).trim().replace(/\/+$/, "");
}

function getMimoTimeoutMs(): number {
  const timeout = Number(process.env.MIMO_TTS_TIMEOUT_MS);
  return Number.isInteger(timeout) && timeout > 0 && timeout <= 2_147_483_647
    ? timeout
    : DEFAULT_MIMO_TIMEOUT_MS;
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

function composeStylePrompt(model: MimoTtsModel, options?: TTSSpeakOptions): string {
  const profile = options?.profile;
  const delivery = DELIVERY[resolveDjCopyLanguage(profile)];
  const design = model === "mimo-v2.5-tts-voicedesign"
    ? process.env.MIMO_TTS_VOICE_PROMPT?.trim() || delivery.design
    : undefined;
  const voiceNote = model === DEFAULT_MIMO_MODEL && typeof profile?.voice === "string" && !getTtsPresetName(profile.voice)
    ? profile.voice.trim()
    : undefined;
  const direction = typeof options?.direction === "string"
    ? options.direction.trim()
    : "";

  return [
    design,
    delivery.base,
    profile?.name && (delivery.name + " — " + profile.name),
    profile?.style && (delivery.style + " — " + profile.style),
    voiceNote && (delivery.voiceNote + " — " + voiceNote),
    options?.scene && delivery.scene[options.scene],
    options?.atmosphere && (delivery.atmosphere + " — " + options.atmosphere),
    direction && (delivery.direction + " — " + direction),
  ].filter(Boolean).join("\n");
}

async function resolveVoiceCloneSample(): Promise<{ dataUri: string; fingerprint: string }> {
  const samplePath = process.env.MIMO_TTS_VOICE_SAMPLE_PATH?.trim();
  if (!samplePath) {
    throw new Error("MIMO_TTS_VOICE_SAMPLE_PATH is required when MIMO_TTS_MODEL=mimo-v2.5-tts-voiceclone");
  }

  const absolutePath = path.isAbsolute(samplePath)
    ? samplePath
    : path.join(repoRoot, samplePath);
  const mimeType = getMimeTypeForSample(absolutePath);
  const sampleBuffer = await fs.readFile(absolutePath);
  const base64Size = Math.ceil(sampleBuffer.length / 3) * 4;
  if (base64Size === 0 || base64Size > MAX_MIMO_SAMPLE_BASE64_BYTES) {
    throw new Error("MiMo VoiceClone sample must be non-empty and at most 10 MB after Base64 encoding");
  }
  const base64Audio = sampleBuffer.toString("base64");

  return {
    dataUri: `data:${mimeType};base64,${base64Audio}`,
    fingerprint: hashText(base64Audio),
  };
}

async function resolveMimoRequest(
  text: string,
  options?: TTSSpeakOptions,
): Promise<ResolvedMimoRequest> {
  const model = parseMimoModel(process.env.MIMO_TTS_MODEL);
  const stylePrompt = composeStylePrompt(model, options);
  const audio: ResolvedMimoRequest["audio"] = { format: "wav" };
  let voiceKey: string | undefined;

  if (model === DEFAULT_MIMO_MODEL) {
    audio.voice = normalizeTtsPresetName(options?.profile?.voice);
    voiceKey = audio.voice;
  } else if (model === "mimo-v2.5-tts-voiceclone") {
    const sample = await resolveVoiceCloneSample();
    audio.voice = sample.dataUri;
    voiceKey = sample.fingerprint;
  } else {
    audio.optimize_text_preview = false;
  }

  return {
    model,
    messages: [
      { role: "user", content: stylePrompt },
      { role: "assistant", content: text },
    ],
    audio,
    cacheVariant: JSON.stringify({ model, voiceKey, stylePrompt }),
  };
}

async function readCachedAudio(cachePath: string): Promise<TTSResult> {
  const absolutePath = path.join(AUDIO_CACHE_DIR, path.posix.basename(cachePath));
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
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  await fs.mkdir(AUDIO_CACHE_DIR, { recursive: true });
  try {
    await fs.writeFile(temporaryPath, Buffer.from(audioBuffer));
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }

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
  return synthesizeWithResolvedRequest(apiKey, request, AbortSignal.timeout(getMimoTimeoutMs()));
}

async function requestMimoSpeech(
  apiKey: string,
  request: ResolvedMimoRequest,
  signal: AbortSignal,
  stream = false,
): Promise<Response> {
  const response = await fetchWithProxyFallback(
    `${getMimoApiBase()}/chat/completions`,
    {
      method: "POST",
      signal,
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        audio: stream ? { ...request.audio, format: "pcm16" } : request.audio,
        ...(stream ? { stream: true } : {}),
      }),
    },
    "MiMo TTS",
  );

  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error("MiMo API error: HTTP " + response.status);
  }
  return response;
}

async function synthesizeWithResolvedRequest(
  apiKey: string,
  request: ResolvedMimoRequest,
  signal: AbortSignal,
): Promise<TTSResult> {
  const response = await requestMimoSpeech(apiKey, request, signal);
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

async function consumeMimoPcmStream(
  response: Response,
  onChunk: (base64: string) => void,
): Promise<TTSResult> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("MiMo response did not include a PCM stream");
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const chunks: Buffer[] = [];
  let pending = "";
  let complete = false;
  try {
    while (!complete) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      let boundary = /\r?\n\r?\n/.exec(pending);
      while (boundary) {
        const data = pending.slice(0, boundary.index).split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim();
        pending = pending.slice(boundary.index + boundary[0].length);
        if (data === "[DONE]") {
          complete = true;
          break;
        }
        if (data) {
          let payload: { choices?: Array<{ delta?: { audio?: { data?: unknown } } }>; error?: unknown };
          try {
            payload = JSON.parse(data);
          } catch {
            throw new Error("MiMo PCM stream returned an invalid event");
          }
          if (payload.error) throw new Error("MiMo PCM stream returned an error");
          const base64 = payload.choices?.[0]?.delta?.audio?.data;
          if (typeof base64 === "string" && base64) {
            const chunk = Buffer.from(base64, "base64");
            if (!chunk.length || chunk.length % PCM_BYTES_PER_SAMPLE !== 0) {
              throw new Error("MiMo PCM stream contained invalid samples");
            }
            chunks.push(chunk);
            onChunk(base64);
          }
        }
        boundary = /\r?\n\r?\n/.exec(pending);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!complete || chunks.length === 0) throw new Error("MiMo PCM stream ended without complete audio");
  return { audioBuffer: pcmToWav(chunks), format: "wav", cached: false };
}

function pcmToWav(chunks: Buffer[]): ArrayBuffer {
  const pcm = Buffer.concat(chunks);
  const wav = new ArrayBuffer(44 + pcm.length);
  const header = Buffer.from(wav);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(PCM_BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(PCM_BYTES_PER_SAMPLE * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  pcm.copy(header, 44);
  return wav;
}

async function synthesizeForPlayback(
  apiKey: string,
  request: ResolvedMimoRequest,
  onChunk?: (base64: string) => void,
): Promise<TTSResult> {
  const timeoutMs = getMimoTimeoutMs();
  if (!onChunk || request.model !== DEFAULT_MIMO_MODEL) {
    return synthesizeWithResolvedRequest(apiKey, request, AbortSignal.timeout(timeoutMs));
  }

  const controller = new AbortController();
  const signal = controller.signal;
  const idleTimer = setTimeout(() => {
    controller.abort(new DOMException("MiMo stopped sending audio", "TimeoutError"));
  }, timeoutMs).unref();
  let started = false;
  try {
    const response = await requestMimoSpeech(apiKey, request, signal, true);
    return await consumeMimoPcmStream(response, (base64) => {
      started = true;
      idleTimer.refresh();
      onChunk(base64);
    });
  } catch (error) {
    if (started || signal.aborted) throw error;
    return await synthesizeWithResolvedRequest(apiKey, request, signal);
  } finally {
    clearTimeout(idleTimer);
  }
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

  const result = await synthesizeForPlayback(apiKey, request, options?.onPcmChunk);
  const cachePath = await cacheAudio(text, result.audioBuffer, request.cacheVariant);

  return {
    ...result,
    cached: false,
    cachePath,
  };
}
