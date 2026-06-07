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
  reason: string;
}

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
  return /下一首|下首|切歌|skip|换一首|别放这首|换首歌|切到下一首/.test(normalized);
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
  const hasChangeVerb = /(来点|想听|换个|换成|换|切到|放点|整点|改成|来些|上点)/.test(normalized);
  const hasMusicOrMoodWord =
    /(歌|音乐|粤语|中文|英文|日语|安静|轻松|舒缓|更燃|燃一点|节奏|摇滚|民谣|emo|开心|治愈|雨天|夜晚|早晨|深夜|电子|爵士|说唱|热闹|温柔|冷一点|暖一点)/.test(normalized);

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

export function routeChatIntent(text: string): ChatRoute {
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
