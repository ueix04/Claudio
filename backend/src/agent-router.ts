import * as claude from "./claude.js";

export type ChatTriggerMode = "morning_brief" | "mood_pick" | "random_discover";

export type ChatIntent =
  | "weather_query"
  | "current_track_query"
  | "recommendation_reason"
  | "style_change"
  | "playback_control"
  | "music_request"
  | "ordinary_chat"
  | "emotion_expression";

export type ChatActionType =
  | "reply_only"
  | "answer_weather"
  | "replan_queue"
  | "skip_track"
  | "resume_queue"
  | "trigger_pipeline";

export interface ChatRoute {
  intent: ChatIntent;
  action: ChatActionType;
  mode?: ChatTriggerMode;
  preserveCurrentTrack?: boolean;
  routedBy?: "rule" | "llm" | "fallback";
  confidence?: number;
  reason: string;
}

export interface ChatRouteContext {
  currentTrack?: {
    name?: string;
    title?: string;
    artist?: string;
  } | null;
  currentProgram?: {
    source?: string;
    title?: string;
    summary?: string;
  } | null;
  chatHistory?: Array<{
    role: "user" | "dj";
    text: string;
  }>;
}

type SemanticRouteResponse = {
  intent?: ChatIntent;
  action?: ChatActionType;
  mode?: ChatTriggerMode;
  reason?: string;
  confidence?: number;
};

const SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD = 0.65;
const SEMANTIC_ROUTER_ACTIONS = new Set<ChatActionType>([
  "reply_only",
  "answer_weather",
  "replan_queue",
  "trigger_pipeline",
]);
const SEMANTIC_ROUTER_INTENTS = new Set<ChatIntent>([
  "weather_query",
  "current_track_query",
  "recommendation_reason",
  "style_change",
  "music_request",
  "ordinary_chat",
  "emotion_expression",
]);

function normalizeMessage(text: string): string {
  return text.trim().toLowerCase();
}

function isWeatherQuery(normalized: string): boolean {
  if (/天气|气温|温度|湿度|下雨|下雪|会不会雨|会不会下雨|外面.*冷|外面.*热|weather|temperature|forecast|rain|snow/.test(normalized)) {
    return true;
  }

  return /(今天|现在|外面|今晚|明天).*(冷吗|热吗|冷不冷|热不热|要不要带伞|伞)/.test(normalized);
}

function isSkipRequest(normalized: string): boolean {
  return /下一首|下首|切歌|skip|换一首|别放这首|换首歌|切到下一首|next song|next track|skip this|skip track/.test(normalized);
}

function isResumeRequest(normalized: string): boolean {
  return /放点音乐|播放音乐|放歌|播歌|继续播放|继续放|开始播放|play music/.test(normalized);
}

function inferTriggerMode(normalized: string): ChatTriggerMode | null {
  if (/早安|晨间|morning brief|早报|晨报/.test(normalized)) {
    return "morning_brief";
  }

  const asksForMoodPick =
    /(心情|emo|难过|伤心|开心|治愈|情绪)/.test(normalized)
    && /(推荐|来|放).*(歌|歌曲)|歌|歌曲/.test(normalized);
  if (asksForMoodPick) {
    return "mood_pick";
  }

  if (/随机|随便|来一首歌|来首歌|放一首歌|放首歌|推荐一首歌|推荐首歌/.test(normalized)) {
    return "random_discover";
  }

  return null;
}

function isStyleChangeRequest(normalized: string): boolean {
  const compact = normalized
    .replace(/[!！?？。,.，\s]+$/g, "")
    .replace(/\s+/g, " ");
  const isBareSwitchRequest = /^(change|switch|switch it up|change it up|something else|something different|换歌[啊呀嘛啦呗吧]*)$/.test(compact);
  if (isBareSwitchRequest) {
    return true;
  }

  const hasChangeVerb = /(来点|想听|想要听|我要听|要听|听点|听些|换个|换成|换|切到|放点|整点|改成|来些|上点|给我来|给我放|\bchange\b|\bswitch\b|\bplay\b)/.test(normalized);
  const hasMusicOrMoodWord =
    /(歌|音乐|粤语|中文|英文|日语|安静|轻松|舒缓|更燃|燃一点|节奏|摇滚|民谣|emo|开心|治愈|雨天|夜晚|早晨|深夜|电子|爵士|说唱|热闹|温柔|冷一点|暖一点|\bmusic\b|\bsongs?\b|\btracks?\b|\bvibe\b|\bmood\b|\bquiet\b|\bcalm\b|\bsoft\b|\bchill\b|\benergetic\b|\brock\b|\bfolk\b|\bjazz\b|\belectronic\b|\bhip[- ]?hop\b)/.test(normalized);

  return hasChangeVerb && hasMusicOrMoodWord;
}

function isCurrentTrackQuery(normalized: string): boolean {
  return /现在.*(放|播).*(什么|哪首)|这首歌?叫(什么|啥)|当前(歌曲|音乐)|正在(放|播).*(什么|哪首)|what.*playing|what song/.test(normalized);
}

function isRecommendationReasonQuery(normalized: string): boolean {
  return /为什么推荐|为啥推荐|推荐理由|这首.*为什么|为什么.*这首|why.*(song|pick|recommend)/.test(normalized);
}

function isEmotionExpression(normalized: string): boolean {
  return /难过|伤心|焦虑|烦|累|失眠|睡不着|emo|开心|孤独|压力|sad|lonely|tired|anxious/.test(normalized);
}

function routeChatIntentRule(text: string): ChatRoute {
  const normalized = normalizeMessage(text);

  if (!normalized) {
    return {
      intent: "ordinary_chat",
      action: "reply_only",
      reason: "empty_message",
    };
  }

  if (isWeatherQuery(normalized)) {
    return {
      intent: "weather_query",
      action: "answer_weather",
      reason: "explicit_weather_request",
    };
  }

  if (isSkipRequest(normalized)) {
    return {
      intent: "playback_control",
      action: "skip_track",
      reason: "skip_requested",
    };
  }

  if (isResumeRequest(normalized)) {
    return {
      intent: "playback_control",
      action: "resume_queue",
      reason: "resume_requested",
    };
  }

  const triggerMode = inferTriggerMode(normalized);
  if (triggerMode) {
    return {
      intent: "music_request",
      action: "trigger_pipeline",
      mode: triggerMode,
      reason: `trigger_${triggerMode}`,
    };
  }

  if (isStyleChangeRequest(normalized)) {
    return {
      intent: "style_change",
      action: "replan_queue",
      preserveCurrentTrack: true,
      reason: "style_change_replans_upcoming_queue",
    };
  }

  if (isCurrentTrackQuery(normalized)) {
    return {
      intent: "current_track_query",
      action: "reply_only",
      reason: "current_track_question",
    };
  }

  if (isRecommendationReasonQuery(normalized)) {
    return {
      intent: "recommendation_reason",
      action: "reply_only",
      reason: "recommendation_reason_question",
    };
  }

  if (isEmotionExpression(normalized)) {
    return {
      intent: "emotion_expression",
      action: "reply_only",
      reason: "emotion_expression",
    };
  }

  return {
    intent: "ordinary_chat",
    action: "reply_only",
    reason: "ordinary_chat",
  };
}

export function routeChatIntent(text: string): ChatRoute {
  const route = routeChatIntentRule(text);
  return {
    ...route,
    routedBy: "rule",
  };
}

function shouldAttemptSemanticRouting(text: string, ruleRoute: ChatRoute): boolean {
  if (ruleRoute.intent !== "ordinary_chat" || ruleRoute.action !== "reply_only") {
    return false;
  }

  const normalized = normalizeMessage(text);
  return /(来点|想听|想要听|我要听|要听|听点|听些|换个|换成|切到|放点|整点|改成|来些|上点|给我来|给我放|没那么|不要太|别太|吵|安静|夜晚|深夜|氛围|风格|节奏|歌|音乐|\bchange\b|\bswitch\b|\bplay\b|\bmusic\b|\bsongs?\b|\btracks?\b|\bvibe\b|\bmood\b|\bquiet\b|\bcalm\b|\bsoft\b|\bchill\b|\bnight\b|\bless noisy\b|\bnot so loud\b)/.test(normalized);
}

function truncateForPrompt(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function buildSemanticRouterPrompt(text: string, context?: ChatRouteContext): string {
  const currentTrack = context?.currentTrack
    ? `${context.currentTrack.name ?? context.currentTrack.title ?? "Unknown"} - ${context.currentTrack.artist ?? "Unknown Artist"}`
    : "none";
  const currentProgram = [
    context?.currentProgram?.source ? `source=${context.currentProgram.source}` : "",
    context?.currentProgram?.title ? `title=${context.currentProgram.title}` : "",
    context?.currentProgram?.summary ? `summary=${truncateForPrompt(context.currentProgram.summary, 120)}` : "",
  ].filter(Boolean).join("; ") || "none";
  const recentChat = (context?.chatHistory ?? [])
    .slice(-4)
    .map((message) => `${message.role}: ${truncateForPrompt(message.text, 120)}`)
    .join("\n") || "none";

  return `You are Claudio's lightweight chat intent router.
Classify the listener message for a local AI emotional radio app.

Listener message:
${JSON.stringify(text)}

Current track: ${currentTrack}
Current program: ${currentProgram}
Recent chat:
${recentChat}

Return JSON only with these fields:
- intent: one of "weather_query", "current_track_query", "recommendation_reason", "style_change", "music_request", "ordinary_chat", "emotion_expression"
- action: one of "reply_only", "answer_weather", "replan_queue", "trigger_pipeline"
- confidence: number from 0 to 1
- reason: short safe reason, no private data
- mode: optional; only when action is "trigger_pipeline", one of "morning_brief", "mood_pick", "random_discover"

Rules:
- Do not return skip_track, resume_queue, deletion, account, payment, or any irreversible action.
- If the user asks for a different vibe, genre, mood, less noisy music, more night-like music, or something to listen to, use action "replan_queue".
- If the user is just chatting without asking to shape music, use "reply_only".
- If uncertain, use "reply_only" with confidence below 0.65.`;
}

function isValidTriggerMode(value: unknown): value is ChatTriggerMode {
  return value === "morning_brief" || value === "mood_pick" || value === "random_discover";
}

function isValidSemanticIntent(value: unknown): value is ChatIntent {
  return typeof value === "string" && SEMANTIC_ROUTER_INTENTS.has(value as ChatIntent);
}

function normalizeSemanticRoute(response: SemanticRouteResponse): ChatRoute | null {
  if (!SEMANTIC_ROUTER_ACTIONS.has(response.action as ChatActionType)) {
    return null;
  }

  const confidence = typeof response.confidence === "number" && Number.isFinite(response.confidence)
    ? Math.max(0, Math.min(1, response.confidence))
    : 0;
  if (confidence < SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD) {
    return null;
  }

  const action = response.action as ChatActionType;
  const intent = isValidSemanticIntent(response.intent)
    ? response.intent
    : action === "replan_queue"
      ? "style_change"
      : action === "trigger_pipeline"
        ? "music_request"
        : "ordinary_chat";
  const reason = typeof response.reason === "string" && response.reason.trim()
    ? truncateForPrompt(response.reason, 120)
    : "semantic_router";

  if (action === "trigger_pipeline") {
    if (!isValidTriggerMode(response.mode)) {
      return null;
    }
    return {
      intent,
      action,
      mode: response.mode,
      reason,
      confidence,
      routedBy: "llm",
    };
  }

  return {
    intent,
    action,
    preserveCurrentTrack: action === "replan_queue" ? true : undefined,
    reason,
    confidence,
    routedBy: "llm",
  };
}

function logChatRoute(route: ChatRoute, textLength: number): void {
  console.log(
    `[chat-router] len=${textLength} action=${route.action} routedBy=${route.routedBy ?? "rule"}`
    + ` confidence=${typeof route.confidence === "number" ? route.confidence.toFixed(2) : "n/a"}`
    + ` reason=${truncateForPrompt(route.reason, 80)}`,
  );
}

export async function routeChatIntentWithSemanticFallback(
  text: string,
  context?: ChatRouteContext,
): Promise<ChatRoute> {
  const ruleRoute = routeChatIntent(text);
  if (!shouldAttemptSemanticRouting(text, ruleRoute)) {
    logChatRoute(ruleRoute, text.length);
    return ruleRoute;
  }

  try {
    const response = await claude.callJsonLLM<SemanticRouteResponse>(
      buildSemanticRouterPrompt(text, context),
      claude.getLlmTaskTimeoutMs("semantic_router"),
    );
    const semanticRoute = normalizeSemanticRoute(response);
    if (semanticRoute) {
      logChatRoute(semanticRoute, text.length);
      return semanticRoute;
    }
  } catch (error) {
    console.warn(
      `[chat-router] semantic route failed, using fallback: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const fallbackRoute: ChatRoute = {
    ...ruleRoute,
    routedBy: "fallback",
    reason: `semantic_router_fallback:${ruleRoute.reason}`,
  };
  logChatRoute(fallbackRoute, text.length);
  return fallbackRoute;
}
