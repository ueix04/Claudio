import * as claude from "./claude.js";

export type ChatTriggerMode = "morning_brief" | "mood_pick" | "random_discover";

export type ChatIntent =
  | "weather_query"
  | "current_track_query"
  | "recommendation_reason"
  | "program_refresh"
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
  preserveCurrentTrack?: boolean;
  reason?: string;
  confidence?: number;
};

type MusicSemanticHint =
  | {
    shouldRoute: true;
    fallbackIntent: "program_refresh" | "style_change";
    preserveCurrentTrack: boolean;
    reason: string;
  }
  | {
    shouldRoute: false;
    reason: string;
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
  "program_refresh",
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

function isProgramRefreshRequest(normalized: string): boolean {
  const compact = normalized
    .replace(/[!！?？。,.，\s]+$/g, "")
    .replace(/\s+/g, " ");

  if (/(下一档|下一段|下个节目|下一个节目|新节目|新的节目|更新节目|刷新节目|重编节目|重排节目|新歌单|新的歌单|更新歌单|刷新歌单|新队列|新的队列|更新队列|刷新队列|fresh program|new program|new playlist|new queue|new set)/.test(compact)) {
    return true;
  }

  if (/(别|不要|不想).{0,10}(循环|重复|旧歌|之前的歌|老歌)|((一直|又).{0,8}(循环|重复).{0,10}(之前|旧))/.test(compact)) {
    return true;
  }

  if (/^(我要新的|要新的|来点新的|换个新的|换新的|新的)$/.test(compact)) {
    return true;
  }

  if (/(这档|这个节目|这节目).{0,8}(听腻|腻|不行|不对|换掉)|听腻了/.test(compact)) {
    return true;
  }

  return /(换|更换|更新|刷新|重编|重排|重新|重新来|切到|来一档|开一档|接一档).{0,10}(节目|歌单|队列|一档|下一档|新界面|program|playlist|queue|set|session)/.test(compact);
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

function getMusicSemanticHint(text: string): MusicSemanticHint {
  const normalized = normalizeMessage(text);
  if (!normalized) {
    return {
      shouldRoute: false,
      reason: "empty_message",
    };
  }

  const compact = normalized
    .replace(/[!！?？。,.，\s]+$/g, "")
    .replace(/\s+/g, " ");

  if (isProgramRefreshRequest(normalized)) {
    return {
      shouldRoute: true,
      fallbackIntent: "program_refresh",
      preserveCurrentTrack: false,
      reason: "program_refresh_signal",
    };
  }

  if (/(不要|别|不想).{0,10}(循环|重复|旧歌|之前的歌|老歌)|((一直|又).{0,8}(循环|重复).{0,10}(之前|旧))/.test(compact)) {
    return {
      shouldRoute: true,
      fallbackIntent: "program_refresh",
      preserveCurrentTrack: false,
      reason: "avoid_loop_signal",
    };
  }

  if (/(换点别的|来点别的|来点不一样|来些不一样|不一样的|换个方向|换个风格|换换口味|这个感觉不对|感觉不对|没那么吵|别太吵|不要太吵|安静一点|安静点|轻一点|轻点|柔一点|柔点|别这么吵|不那么吵)/.test(compact)) {
    return {
      shouldRoute: true,
      fallbackIntent: "style_change",
      preserveCurrentTrack: true,
      reason: "style_change_signal",
    };
  }

  if (/^(change|switch|switch it up|change it up|something else|something different|换歌[啊呀嘛啦呗吧]*)$/.test(compact)) {
    return {
      shouldRoute: true,
      fallbackIntent: "style_change",
      preserveCurrentTrack: true,
      reason: "bare_music_change_signal",
    };
  }

  if (isStyleChangeRequest(normalized)) {
    return {
      shouldRoute: true,
      fallbackIntent: "style_change",
      preserveCurrentTrack: true,
      reason: "style_change_request",
    };
  }

  const hasAdjustmentSignal = /(新的|换|别的|不要|腻|不一样|重新|循环|节目|歌单|队列|风格|感觉|听点|放点|来点|没那么|安静|吵|\bchange\b|\bswitch\b|\bdifferent\b|\bvibe\b|\bmood\b)/.test(normalized);
  const hasRadioContext = /(歌|音乐|节目|歌单|队列|电台|听|放|播|风格|氛围|节奏|vibe|mood|music|songs?|tracks?|playlist|queue|program|radio)/.test(normalized);
  if (hasAdjustmentSignal && hasRadioContext) {
    return {
      shouldRoute: true,
      fallbackIntent: "style_change",
      preserveCurrentTrack: true,
      reason: "weak_music_adjustment_signal",
    };
  }

  return {
    shouldRoute: false,
    reason: "no_music_adjustment_signal",
  };
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

function routeHardChatIntentRule(text: string): ChatRoute {
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
  const route = routeHardChatIntentRule(text);
  return {
    ...route,
    routedBy: "rule",
  };
}

function isFinalHardRoute(route: ChatRoute): boolean {
  if (route.action !== "reply_only") {
    return true;
  }

  return route.intent === "current_track_query" || route.intent === "recommendation_reason";
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
Claudio is a radio context. In Chinese, short listener phrases such as "新的", "我要新的", "别循环", "换个方向", "来点不一样的", or "这档不行" are usually music/program control intents, not ordinary chat.

Listener message:
${JSON.stringify(text)}

Current track: ${currentTrack}
Current program: ${currentProgram}
Recent chat:
${recentChat}

Return JSON only with these fields:
- intent: one of "weather_query", "current_track_query", "recommendation_reason", "program_refresh", "style_change", "music_request", "ordinary_chat", "emotion_expression"
- action: one of "reply_only", "answer_weather", "replan_queue", "trigger_pipeline"
- confidence: number from 0 to 1
- reason: short safe reason, no private data
- mode: optional; only when action is "trigger_pipeline", one of "morning_brief", "mood_pick", "random_discover"
- preserveCurrentTrack: optional boolean; only for action "replan_queue"

Rules:
- Do not return skip_track, resume_queue, deletion, account, payment, or any irreversible action.
- If the user asks to refresh/change the program, session, playlist, queue, next set, next segment, wants "new/fresh", says this program is tired/bad, or says the station is looping old songs, use intent "program_refresh", action "replan_queue", preserveCurrentTrack false.
- If the user asks for a different vibe, genre, mood, less noisy music, quieter music, more night-like music, or a softer style shift, use intent "style_change", action "replan_queue", preserveCurrentTrack true.
- If the user explicitly asks for random discovery, a morning brief, or a mood-pick program, use intent "music_request", action "trigger_pipeline", and a valid mode.
- If the user is just chatting without asking to shape music, use "reply_only".
- If uncertain, use "reply_only" with confidence below 0.65.`;
}

function isValidTriggerMode(value: unknown): value is ChatTriggerMode {
  return value === "morning_brief" || value === "mood_pick" || value === "random_discover";
}

function isValidSemanticIntent(value: unknown): value is ChatIntent {
  return typeof value === "string" && SEMANTIC_ROUTER_INTENTS.has(value as ChatIntent);
}

function normalizeSemanticRoute(response: SemanticRouteResponse | null | undefined): ChatRoute | null {
  if (!response || !SEMANTIC_ROUTER_ACTIONS.has(response.action as ChatActionType)) {
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

  const preserveCurrentTrack = action === "replan_queue"
    ? typeof response.preserveCurrentTrack === "boolean"
      ? response.preserveCurrentTrack
      : intent === "program_refresh"
        ? false
        : true
    : undefined;

  return {
    intent,
    action,
    preserveCurrentTrack,
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
  if (isFinalHardRoute(ruleRoute)) {
    logChatRoute(ruleRoute, text.length);
    return ruleRoute;
  }

  const musicHint = getMusicSemanticHint(text);
  if (!musicHint.shouldRoute) {
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
    intent: musicHint.fallbackIntent,
    action: "replan_queue",
    preserveCurrentTrack: musicHint.preserveCurrentTrack,
    routedBy: "fallback",
    reason: `semantic_music_fallback:${musicHint.reason}`,
  };
  logChatRoute(fallbackRoute, text.length);
  return fallbackRoute;
}
