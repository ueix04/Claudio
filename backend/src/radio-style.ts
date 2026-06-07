export type DayPart = "late_night" | "morning" | "afternoon" | "evening";
export type WeatherTone = "sunny" | "rainy" | "cloudy" | "humid" | "cold" | "unknown";
export type SegueKind = "smooth_handoff" | "lift" | "settle" | "night_companion" | "landing";
export type PromptLanguage = "zh" | "en";

function parseHour(timeOfDay: string): number {
  const match = timeOfDay.match(/^(\d{1,2})/);
  if (!match) {
    return new Date().getHours();
  }

  const hour = Number(match[1]);
  return Number.isFinite(hour) ? hour : new Date().getHours();
}

export function getDayPart(timeOfDay: string): DayPart {
  const hour = parseHour(timeOfDay);
  if (hour < 5) return "late_night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

export function inferWeatherTone(weatherContext?: string): WeatherTone {
  const text = weatherContext?.toLowerCase() ?? "";
  if (!text) return "unknown";

  if (/雨|雷|storm|rain|drizzle|shower/.test(text)) return "rainy";
  if (/晴|sun|clear/.test(text)) return "sunny";
  if (/云|阴|cloud|overcast/.test(text)) return "cloudy";
  if (/热|humid|闷/.test(text)) return "humid";
  if (/冷|风大|cold|snow|霜/.test(text)) return "cold";
  return "unknown";
}

export function buildHostStyleGuide(
  timeOfDay: string,
  weatherContext?: string,
  language: PromptLanguage = "zh",
): string {
  const dayPart = getDayPart(timeOfDay);
  const weatherTone = inferWeatherTone(weatherContext);
  const useEnglish = language === "en";

  if (dayPart === "late_night") {
    return useEnglish
      ? "Host style: late-night companion. Close-mic, restrained, soft, never hyped, and never oversized in wording."
      : "主持风格：深夜陪伴型。贴耳、克制、轻声，不要兴奋，不要用大开大合的词。";
  }

  if (dayPart === "morning" && weatherTone === "sunny") {
    return useEnglish
      ? "Host style: clear morning radio. A touch brighter, still gentle, never hyper and never like a news anchor."
      : "主持风格：清透晨间型。明亮一点，但依然温柔，不要像打鸡血，也不要像新闻播报。";
  }

  if (dayPart === "morning" && weatherTone === "rainy") {
    return useEnglish
      ? "Host style: rainy-morning companion. Lighter, warmer, like helping someone wake up slowly. Never pushy or too chirpy."
      : "主持风格：雨晨陪伴型。轻一点、暖一点，像陪人慢慢醒来，不要催促，不要过分活泼。";
  }

  if (dayPart === "afternoon" && (weatherTone === "cloudy" || weatherTone === "humid")) {
    return useEnglish
      ? "Host style: loose afternoon ease. Relaxed, lightly warm, like gently lowering the listener's pace. Do not overcrowd the tone."
      : "主持风格：午后松弛型。语气放松、微暖，像在替人把节奏降下来，不要太满。";
  }

  if (dayPart === "evening" && weatherTone === "rainy") {
    return useEnglish
      ? "Host style: rainy-night radio. Shorter lines, softer mood, strong sense of company, and no repeated greetings."
      : "主持风格：夜雨电台型。句子更短，情绪更柔软，强调陪伴感，不要频繁使用问候语。";
  }

  if (dayPart === "evening") {
    return useEnglish
      ? "Host style: city-at-night. Gentle, steady, slightly nocturnal, but never artificially deep."
      : "主持风格：夜间城市型。温柔、稳一点，有夜色感，但不要故作深沉。";
  }

  return useEnglish
    ? "Host style: natural companion. Gentle, restrained, like a real DJ speaking with the room instead of performing at it."
    : "主持风格：自然陪伴型。温柔、克制、像真人 DJ 在顺着气氛说话。";
}

export function inferSegueKind(params: {
  timeOfDay: string;
  weatherContext?: string;
  queueLength: number;
  nextIndex: number;
}): SegueKind {
  const dayPart = getDayPart(params.timeOfDay);
  const weatherTone = inferWeatherTone(params.weatherContext);

  if (dayPart === "late_night") {
    return "night_companion";
  }

  if (params.queueLength > 0 && params.nextIndex >= params.queueLength - 1) {
    return "landing";
  }

  if (weatherTone === "rainy" || weatherTone === "cloudy") {
    return "settle";
  }

  if (params.nextIndex <= 1) {
    return "lift";
  }

  return "smooth_handoff";
}

export function buildSegueDirective(kind: SegueKind, language: PromptLanguage = "zh"): string {
  const useEnglish = language === "en";
  switch (kind) {
    case "lift":
      return useEnglish
        ? "Segue type: lift. Gently raise the energy, but only by half a step. Never sound like hype."
        : "串场类型：提气。把气氛轻轻往上推一点，但只推半步，不要喊麦。";
    case "settle":
      return useEnglish
        ? "Segue type: settle. Smooth the temperature down from the previous track and help the listener land."
        : "串场类型：降温。像顺着上一首把听感放平，帮人沉下来。";
    case "night_companion":
      return useEnglish
        ? "Segue type: late-night companion. Speak as if you are easing the next track in by the listener's ear. Short lines, contained emotion."
        : "串场类型：深夜陪伴。像在耳边轻声接歌，句子短，情绪收着。";
    case "landing":
      return useEnglish
        ? "Segue type: landing. Give the set a gentle point of arrival, like settling this section into place."
        : "串场类型：收束。要有一点落点感，像把这段节目慢慢放稳。";
    default:
      return useEnglish
        ? "Segue type: handoff. Connect the two tracks so naturally that the next song feels inevitable."
        : "串场类型：接歌。自然衔接前后两首，让人觉得这首就是该这样接上来。";
  }
}
