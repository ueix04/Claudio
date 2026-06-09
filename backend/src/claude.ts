import { normalizeTtsPresetName } from "./tts.js";

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";
const LLM_PROVIDER_ENV_PREFIX = "LLM_";

type LlmProvider = {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
};

function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function getLlmApiKey(): string {
  const apiKey = (process.env.LLM_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("LLM_API_KEY is missing");
  }
  return apiKey;
}

function getLlmBaseUrl(): string {
  return (process.env.BASE_URL || DEFAULT_LLM_BASE_URL).trim().replace(/\/+$/, "");
}

function getLlmModel(): string {
  return (process.env.MODEL || DEFAULT_LLM_MODEL).trim();
}

function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function normalizeProviderEnvName(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function getLlmProviderOrder(): string[] {
  return (process.env.LLM_PROVIDER_ORDER || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function getLegacyLlmProvider(): LlmProvider {
  return {
    name: "default",
    apiKey: getLlmApiKey(),
    baseUrl: getLlmBaseUrl(),
    model: getLlmModel(),
  };
}

function getConfiguredLlmProviders(): LlmProvider[] {
  const providerOrder = getLlmProviderOrder();
  if (providerOrder.length === 0) {
    return [getLegacyLlmProvider()];
  }

  return providerOrder.map((name) => {
    const envName = normalizeProviderEnvName(name);
    const apiKey = (process.env[`${LLM_PROVIDER_ENV_PREFIX}${envName}_API_KEY`] || "").trim();
    if (!apiKey) {
      throw new Error(`LLM provider ${name} is missing ${LLM_PROVIDER_ENV_PREFIX}${envName}_API_KEY`);
    }

    return {
      name,
      apiKey,
      baseUrl: (process.env[`${LLM_PROVIDER_ENV_PREFIX}${envName}_BASE_URL`] || DEFAULT_LLM_BASE_URL).trim().replace(/\/+$/, ""),
      model: (process.env[`${LLM_PROVIDER_ENV_PREFIX}${envName}_MODEL`] || DEFAULT_LLM_MODEL).trim(),
      timeoutMs: parsePositiveInt(
        process.env[`${LLM_PROVIDER_ENV_PREFIX}${envName}_TIMEOUT_MS`],
        `${LLM_PROVIDER_ENV_PREFIX}${envName}_TIMEOUT_MS`,
      ),
    };
  });
}

function getSafeErrorMessage(error: unknown, secrets: string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return secrets
    .filter((secret) => secret.length >= 4)
    .reduce(
      (result, secret) => result.split(secret).join("[redacted]"),
      message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"),
    );
}

function getElapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function getAttemptTimeoutMs(provider: LlmProvider, totalTimeout: number, startedAt: number, hasFallback: boolean): number {
  if (!hasFallback) {
    return totalTimeout;
  }

  const remaining = totalTimeout - getElapsedMs(startedAt);
  if (remaining <= 0) {
    throw new Error("LLM request timed out before trying the next provider");
  }

  return Math.max(1, Math.min(provider.timeoutMs ?? remaining, remaining));
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json|text|markdown)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

type OpenAICompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: string | ContentPart[];
    };
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
};

type ContentPart = {
  type?: string;
  text?: string;
};

function extractTextContent(content: string | ContentPart[] | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n");
  }

  return "";
}

function parseOpenAICompatiblePayload(text: string, responseOk: boolean): OpenAICompatibleResponse {
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as OpenAICompatibleResponse;
  } catch {
    if (!responseOk) {
      return {};
    }

    throw new Error("LLM returned invalid JSON response");
  }
}

async function callOpenAICompatibleProvider(
  provider: LlmProvider,
  prompt: string,
  timeout: number,
  wantsJson: boolean,
): Promise<string> {
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        {
          role: "system",
          content: wantsJson
            ? "You are Claudio, an AI radio DJ. Return valid JSON only."
            : "You are Claudio, an AI radio DJ. Answer naturally and concisely.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: wantsJson ? 0.4 : 0.7,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeout),
  });

  const text = await response.text();
  const payload = parseOpenAICompatiblePayload(text, response.ok);

  if (!response.ok) {
    const message = payload.error?.message || `LLM request failed: ${response.status}`;
    throw new Error(message);
  }

  const content = extractTextContent(payload.choices?.[0]?.message?.content);
  if (!content.trim()) {
    throw new Error("LLM returned no text");
  }

  return stripMarkdownFence(content);
}

async function callWithLlmFallback<T>(
  timeout: number,
  operation: (provider: LlmProvider, timeoutMs: number) => Promise<T>,
): Promise<T> {
  const providers = getConfiguredLlmProviders();
  const hasFallback = providers.length > 1;

  if (!hasFallback) {
    return operation(providers[0], timeout);
  }

  const startedAt = Date.now();
  const failures: string[] = [];
  const secrets = providers.map((provider) => provider.apiKey);

  for (const provider of providers) {
    try {
      const attemptTimeout = getAttemptTimeoutMs(provider, timeout, startedAt, hasFallback);
      return await operation(provider, attemptTimeout);
    } catch (error) {
      const message = getSafeErrorMessage(error, secrets);
      failures.push(`${provider.name}: ${message}`);
      console.warn(`[llm] provider ${provider.name} failed, trying next provider: ${message}`);
    }
  }

  throw new Error(`LLM request failed across providers: ${failures.join("; ")}`);
}

export interface LLMResponse {
  say: string;
  ttsText?: string;
  play: Array<{ id?: number; title: string; artist?: string; mood?: string; reason?: string }>;
  reason: string;
  segue?: string;
}

export interface TaggedReplyResponse {
  say: string;
  ttsText?: string;
}

export interface ContextPromptParams {
  mode: "morning_brief" | "mood_pick" | "random_discover";
  timeOfDay: string;
  recentHistory: string;
  userFeedbackContext?: string;
  playlistContext: string;
  candidateContext?: string;
  weatherContext?: string;
  djVoice?: string;
}

function extractObjectJson<T extends object>(raw: string): T {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");

  if (first === -1 || last === -1 || first > last) {
    throw new Error("未找到有效 JSON");
  }

  const candidate = raw.slice(first, last + 1);

  let result: unknown;
  try {
    result = JSON.parse(candidate);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error("JSON 解析失败: " + message);
  }

  if (result === null || typeof result !== "object") {
    throw new Error("JSON 解析失败: result is not an object");
  }

  return result as T;
}

export function extractJson(raw: string): LLMResponse {
  return extractObjectJson<LLMResponse>(raw);
}

export async function callLLM(
  prompt: string,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<LLMResponse> {
  return callJsonLLM<LLMResponse>(prompt, timeout);
}

export async function callJsonLLM<T extends object>(
  prompt: string,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<T> {
  return callWithLlmFallback(timeout, async (provider, attemptTimeout) => {
    const text = await callOpenAICompatibleProvider(provider, prompt, attemptTimeout, true);
    return extractObjectJson<T>(text);
  });
}

export async function callTextLLM(
  prompt: string,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<string> {
  return callWithLlmFallback(timeout, (provider, attemptTimeout) =>
    callOpenAICompatibleProvider(provider, prompt, attemptTimeout, false),
  );
}

export function buildContextPrompt(params: ContextPromptParams): string {
  const { mode, timeOfDay, recentHistory, userFeedbackContext, playlistContext, candidateContext, weatherContext, djVoice } = params;
  const useEnglish = normalizeTtsPresetName(djVoice) === "Dean";

  const modeDescriptions = useEnglish
    ? {
      morning_brief: "a light, companionable morning brief",
      mood_pick: "a song pick based on the listener's mood",
      random_discover: "a random discovery of a lesser-known good song",
    } satisfies Record<ContextPromptParams["mode"], string>
    : {
      morning_brief: "轻松活泼的晨间简报",
      mood_pick: "基于用户心情推荐一首歌",
      random_discover: "随机发现一首冷门好歌",
    } satisfies Record<ContextPromptParams["mode"], string>;

  const modeDesc = modeDescriptions[mode];

  if (useEnglish) {
    return `You are Claudio, an AI emotional radio DJ.
Current time: ${timeOfDay}
Current mode: ${modeDesc}
${weatherContext ? `Live weather: ${weatherContext}\n` : ""}Recent play history: ${recentHistory || "none"}
Explicit listener feedback:
${userFeedbackContext || "none"}
Imported playlist context:
${playlistContext || "The listener has not imported a playlist yet. Recommend freely based on the mode and music sense."}
${candidateContext ? `\n\n${candidateContext}` : ""}

Reply in JSON. Field requirements:
- say: the line shown in the UI, natural English, 12-32 words, warm and conversational, without inline audio tags
- ttsText: same meaning as say. Keep normal conversational pace; do not add slow, deep, whisper, or theatrical stage directions
- play: the song list you recommend. Each item includes title (required), artist (optional), id (required if it comes from the online candidate pool), mood (optional), reason (optional)
  - If the listener has imported playlists, prefer music close to those artists, styles, or eras
  - If an online candidate pool is provided, prefer choosing from it and preserve id, title, and artist exactly as given
- If live weather is provided, weave it naturally into say / ttsText, but do not invent extra weather details
- reason: why this recommendation fits, natural English, 10-24 words
- segue: optional transition line, natural English, 8-18 words

Return JSON only. Do not include any extra text.`;
  }

  return `你是一个 AI 情感电台 DJ，名字叫 Claudio。
当前时间: ${timeOfDay}
当前模式: ${modeDesc}
${weatherContext ? `实时天气: ${weatherContext}\n` : ""}最近播放历史: ${recentHistory || "无"}
用户显性音乐反馈:
${userFeedbackContext || "无"}
用户导入的歌单信息:
${playlistContext || "用户尚未导入歌单，请根据模式和音乐常识自由推荐"}
${candidateContext ? `\n\n${candidateContext}` : ""}

请以 JSON 格式回复，字段说明：
- say: 前端显示给用户的话（中文，30-80 字，温柔治愈的风格，不要包含任何音频标签）
- ttsText: 给 TTS 朗读的文本，内容应与 say 语义一致。保持正常聊天语速，不要加入低声、语速放慢、故作深沉或表演化标签
- play: 你推荐的歌曲列表，每首包含 title（必填）、artist（选填）、id（若来自在线候选池则必填）、mood（选填）、reason（选填）
  - 如果用户有导入歌单，优先推荐与歌单中歌手/风格/年代相近的音乐
  - 如果提供了“在线候选池”，优先从候选池里选；此时必须原样返回候选曲目的 id、title、artist，不要改写
- 如果提供了实时天气，可以自然地融入 say / ttsText，但不要编造未提供的天气细节
- reason: 你推荐这首歌的理由（中文，20-50 字，说明与用户口味的关联）
- segue: 衔接语（选填，用于在歌曲之间过渡的话，中文，20-50 字）

只输出 JSON，不要包含任何其他文字。`;
}

export { callLLM as callClaude };
export type { LLMResponse as ClaudeResponse };
