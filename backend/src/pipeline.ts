import fs from "node:fs/promises";
import path from "node:path";
import * as db from "./db.js";
import * as claude from "./claude.js";
import * as djLanguage from "./dj-language.js";
import * as musicSources from "./music-sources/index.js";
import * as radioStyle from "./radio-style.js";
import * as radioSession from "./radio-session.js";
import * as tasteProfile from "./taste-profile.js";
import * as tts from "./tts.js";
import * as weather from "./weather.js";
import type { PlayableTrack } from "./music-sources/index.js";
import { audioDir, dataDir } from "./runtime.js";

const FALLBACK_TRACKS: Record<"morning_brief" | "mood_pick" | "random_discover", Array<{ title: string; artist: string }>> = {
  morning_brief: [
    { title: "Best Day Of My Life", artist: "American Authors" },
    { title: "Sunflower", artist: "Post Malone, Swae Lee" },
  ],
  mood_pick: [
    { title: "Sunflower", artist: "Post Malone, Swae Lee" },
    { title: "Best Day Of My Life", artist: "American Authors" },
  ],
  random_discover: [
    { title: "Best Day Of My Life", artist: "American Authors" },
    { title: "Sunflower", artist: "Post Malone, Swae Lee" },
  ],
};

const STARTUP_FALLBACK_TRACKS = [
  { title: "Best Day Of My Life", artist: "American Authors" },
  { title: "Sunflower", artist: "Post Malone, Swae Lee" },
  { title: "Yellow", artist: "Coldplay" },
  { title: "晴天", artist: "周杰伦" },
];

async function buildNcmPlaylistContext(): Promise<string> {
  const indexedSummary = await tasteProfile.summarizeTasteProfile();
  if (indexedSummary) {
    return indexedSummary;
  }

  return db.summarizeNeteaseSnapshot();
}

export interface PipelineResult {
  status: "success" | "error";
  djMessage: string;
  tracks: PlayableTrack[];
  reason: string;
  segue?: string;
  ttsAudioPath?: string;
  programTitle?: string;
  shouldStartTrack?: boolean;
  currentTrackPreserved?: boolean;
}

type RequestedTrack = {
  id?: number;
  title: string;
  artist?: string;
};

type TrackIdentity = {
  title?: string;
  name?: string;
  artist?: string;
};

type ProgramRequestedTrack = RequestedTrack & {
  mood?: string;
  reason?: string;
};

interface StationProgramResponse {
  title?: string;
  mood?: string;
  plannedMinutes?: number;
  speechPlan?: radioSession.RadioSpeechSlotInput[];
  say: string;
  ttsText?: string;
  lineup: ProgramRequestedTrack[];
  reason: string;
}

interface MusicContext {
  state: Awaited<ReturnType<typeof db.getState>>;
  timeOfDay: string;
  recentHistory: string;
  mergedPlaylistContext: string;
  candidateContext: string;
  localCandidateMap: Map<number, tasteProfile.RecommendationCandidate>;
  weatherContext?: string;
}

async function buildWeatherContext(
  mode: "morning_brief" | "mood_pick" | "random_discover",
): Promise<string | undefined> {
  if (mode !== "morning_brief") {
    return undefined;
  }

  try {
    return await weather.getDefaultWeatherPromptContext();
  } catch (error) {
    console.warn("Weather fetch skipped:", error);
    return undefined;
  }
}

async function buildOptionalWeatherContext(): Promise<string | undefined> {
  try {
    return await weather.getDefaultWeatherPromptContext();
  } catch (error) {
    console.warn("Weather fetch skipped:", error);
    return undefined;
  }
}

async function gatherMusicContext(
  options?: {
    weatherMode?: "morning_brief" | "mood_pick" | "random_discover";
    includeOptionalWeather?: boolean;
    candidateLimit?: number;
  },
): Promise<MusicContext> {
  const state = await db.getState();
  const recentHistory = state.chatHistory
    .slice(-10)
    .map((msg) => `${msg.role}: ${msg.text}`)
    .join("\n");

  const timeOfDay = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const playlistContext = db.summarizePlaylists();
  const [ncmPlaylistContext, snapshot, profile, weatherContext] = await Promise.all([
    buildNcmPlaylistContext(),
    db.getNeteaseSnapshot(),
    tasteProfile.getTasteProfile(),
    options?.weatherMode
      ? buildWeatherContext(options.weatherMode)
      : options?.includeOptionalWeather
        ? buildOptionalWeatherContext()
        : undefined,
  ]);

  const candidatePool = snapshot && profile
    ? tasteProfile.buildRecommendationCandidates(snapshot, profile, state.playHistory, options?.candidateLimit ?? 20)
    : [];
  const candidateContext = tasteProfile.summarizeRecommendationCandidates(candidatePool);
  const localCandidateMap = new Map(candidatePool.map((candidate) => [candidate.id, candidate]));
  const mergedPlaylistContext = [playlistContext, ncmPlaylistContext]
    .filter(Boolean)
    .join("\n\n");

  return {
    state,
    timeOfDay,
    recentHistory,
    mergedPlaylistContext,
    candidateContext,
    localCandidateMap,
    weatherContext,
  };
}

async function resolvePlayableTracks(
  mode: "morning_brief" | "mood_pick" | "random_discover",
  playList: RequestedTrack[],
  localCandidateMap: Map<number, tasteProfile.RecommendationCandidate> = new Map(),
  avoidTracks: TrackIdentity[] = [],
): Promise<PlayableTrack[]> {
  return resolvePlayableTracksFromRequests(playList, FALLBACK_TRACKS[mode], localCandidateMap, avoidTracks);
}

async function resolvePlayableTracksFromRequests(
  playList: RequestedTrack[],
  fallbackTracks: Array<{ title: string; artist: string }>,
  localCandidateMap: Map<number, tasteProfile.RecommendationCandidate> = new Map(),
  avoidTracks: TrackIdentity[] = [],
): Promise<PlayableTrack[]> {
  const attempts = [...playList];
  if (attempts.length === 0) {
    attempts.push(...fallbackTracks);
  }

  const resolved = await Promise.allSettled(
    attempts.map(async (trackInfo) => {
      if (typeof trackInfo.id === "number" && localCandidateMap.has(trackInfo.id)) {
        const candidate = localCandidateMap.get(trackInfo.id)!;
        if (musicSources.isLocalLibraryEnabled()) {
          try {
            const localTrack = await musicSources.resolveTrack(
              candidate.title,
              candidate.artist,
              musicSources.LOCAL_LIBRARY_SOURCE_ID,
            );
            if (localTrack) {
              return localTrack;
            }
          } catch {
            // fall through to Netease identity resolution
          }
        }

        try {
          return await musicSources.resolveKnownTrack({
            source: musicSources.NETEASE_LEGACY_SOURCE_ID,
            sourceTrackId: String(trackInfo.id),
            title: candidate.title,
            artist: candidate.artist,
            album: candidate.album,
            duration: 0,
          });
        } catch {
          // fall through to search-based resolution
        }
      }

      const track = await musicSources.resolveTrack(trackInfo.title, trackInfo.artist);
      return track;
    }),
  );

  const playableTracks = resolved
    .flatMap((result) => {
      if (result.status !== "fulfilled" || !result.value) return [];
      return [result.value];
    });

  const preferredTracks = filterProgramTrackRepeats(playableTracks, avoidTracks);
  if (preferredTracks.length > 0) {
    return preferredTracks;
  }

  for (const fallback of fallbackTracks) {
    try {
      const track = await musicSources.resolveTrack(fallback.title, fallback.artist);
      if (track && filterProgramTrackRepeats([track], avoidTracks).length > 0) {
        return [track];
      }
    } catch (error) {
      console.error(`Fallback track failed ${fallback.title}:`, error);
    }
  }

  return playableTracks.slice(0, 1);
}

function normalizeTrackKey(title: string | undefined, artist: string | undefined): string {
  const normalizedTitle = (title ?? "").trim().toLowerCase();
  const normalizedArtist = (artist ?? "").trim().toLowerCase();
  return `${normalizedTitle}::${normalizedArtist}`;
}

function buildAvoidTracks(context: MusicContext): TrackIdentity[] {
  const playHistory = Array.isArray(context.state.playHistory)
    ? context.state.playHistory
    : [];
  const recentHistory = playHistory
    .slice(0, 25)
    .map((record) => ({
      title: record.title,
      artist: record.artist,
    }));
  return [
    ...(context.state.currentTrack ? [context.state.currentTrack] : []),
    ...recentHistory,
  ];
}

function filterProgramTrackRepeats(
  tracks: PlayableTrack[],
  avoidTracks: TrackIdentity[],
): PlayableTrack[] {
  const avoided = new Set(
    avoidTracks
      .map((track) => normalizeTrackKey(track.title ?? track.name, track.artist))
      .filter((key) => key !== "::"),
  );
  const seen = new Set<string>();
  const filtered = tracks.filter((track) => {
    const key = normalizeTrackKey(track.name, track.artist);
    if (seen.has(key) || avoided.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  if (filtered.length > 0 || tracks.length === 0) {
    return filtered;
  }

  const batchSeen = new Set<string>();
  return tracks.filter((track) => {
    const key = normalizeTrackKey(track.name, track.artist);
    if (batchSeen.has(key)) {
      return false;
    }
    batchSeen.add(key);
    return true;
  }).slice(0, 1);
}

export async function ensureDataDirs(): Promise<void> {
  const dirs = [dataDir, audioDir];
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // 目录可能已存在或权限不足，忽略
    }
  }
}

function buildStartupProgramPrompt(context: MusicContext): string {
  const { timeOfDay, weatherContext, recentHistory, mergedPlaylistContext, candidateContext, state } = context;
  const language = djLanguage.resolveDjCopyLanguage(state.djProfile);
  const useEnglish = language === "en";
  const hostStyleGuide = radioStyle.buildHostStyleGuide(timeOfDay, weatherContext, language);

  if (useEnglish) {
    return `You are Claudio, an AI emotional radio DJ.
Current time: ${timeOfDay}
${weatherContext ? `Current weather: ${weatherContext}` : "Current weather: unknown"}
${hostStyleGuide}
Recent chat and playback clues:
${recentHistory || "none"}

User playlists / snapshots / taste profile:
${mergedPlaylistContext || "No playlist context yet"}
${candidateContext ? `\n\nLocal candidate library:\n${candidateContext}` : ""}

Please program a 20-40 minute radio session for “the station right after the service starts”. Requirements:
- Organize the mood using time, weather, and the listener's playlist taste
- The opening should sound like a real DJ opening the mic: warm, companionable, never like a system notice
- The intro should happen only once, like the real start of a show, not like every song is a fresh opening
- Order the songs naturally so each handoff feels deliberate
- Prefer the local candidate library. If you use it, return id, title, and artist exactly as provided
- Output 6 to 10 songs, enough for roughly 20-40 minutes
- Include a speechPlan: intro before the first song, then only short talk or bumper spots every 2-3 songs

Return JSON only. Required fields:
- title: optional show title
- mood: the overall mood of this session
- plannedMinutes: target duration, an integer from 20 to 40
- say: the opening line for the UI, natural English, 20-65 words
- ttsText: same meaning as say, but you may add light inline performance tags
- lineup: an array of songs. Each item includes title (required), artist (optional), id (required when matched from the local candidate library), mood (optional), reason (optional)
- speechPlan: optional array. Each item includes beforeTrackIndex (0-based), type ("intro", "short_say", "bumper", or "closing"), note (optional)
- reason: why this set is arranged this way, natural English, 14-30 words
`;
  }

  return `你是 Claudio，一位 AI 情感电台 DJ。
当前时间：${timeOfDay}
${weatherContext ? `当前天气：${weatherContext}` : "当前天气：未知"}
${hostStyleGuide}
最近聊天和播放线索：
${recentHistory || "无"}

用户歌单 / 快照 / 画像：
${mergedPlaylistContext || "暂无歌单信息"}
${candidateContext ? `\n\n本地候选曲库：\n${candidateContext}` : ""}

请为“服务刚启动时的电台节目”编排一段 20 到 40 分钟的 Radio Session，要求：
- 结合时间、天气、用户歌单口味来组织节目气氛
- 节目开场要像真实 DJ 开麦，温柔、有陪伴感，不要太像公告
- 开场对白只能像节目真正开始时说一次，不要像每首歌前都在重新开场
- 歌单按顺序编排，前后过渡自然
- 优先使用本地候选曲库；如果用了候选曲库，必须原样返回 id、title、artist
- 输出 6 到 10 首歌，整体约 20 到 40 分钟
- 增加 speechPlan：第一首前是 intro，之后每 2 到 3 首歌才安排一次 short_say 或 bumper

只输出 JSON，对象字段必须是：
- title: 节目标题，可选
- mood: 这段节目的整体氛围
- plannedMinutes: 目标时长，20 到 40 之间的整数
- say: 开场对白，给前端显示，中文 40-120 字
- ttsText: 给 TTS 的版本，语义与 say 一致，可加入适度行内标签
- lineup: 歌曲数组，每项包含 title（必填）、artist（选填）、id（候选曲库命中时必填）、mood（选填）、reason（选填）
- speechPlan: 可选数组，每项包含 beforeTrackIndex（从 0 开始）、type（"intro"、"short_say"、"bumper" 或 "closing"）、note（可选）
- reason: 说明这档节目为什么这么编排，中文 30-80 字
`;
}

function buildChatSwitchProgramPrompt(
  userText: string,
  context: MusicContext,
): string {
  const { timeOfDay, weatherContext, recentHistory, mergedPlaylistContext, candidateContext, state } = context;
  const language = djLanguage.resolveDjCopyLanguage(state.djProfile);
  const useEnglish = language === "en";
  const currentTrack = state.currentTrack
    ? `${state.currentTrack.name} - ${state.currentTrack.artist}`
    : useEnglish ? "Nothing is currently playing" : "当前没有正在播放的歌曲";
  const hostStyleGuide = radioStyle.buildHostStyleGuide(timeOfDay, weatherContext, language);

  if (useEnglish) {
    return `You are Claudio, an AI emotional radio DJ.
The listener just said: ${JSON.stringify(userText)}
Current time: ${timeOfDay}
${weatherContext ? `Current weather: ${weatherContext}` : "Weather is not part of this request."}
${hostStyleGuide}
Current track: ${currentTrack}
Recent chat and playback clues:
${recentHistory || "none"}

User playlists / snapshots / taste profile:
${mergedPlaylistContext || "No playlist context yet"}
${candidateContext ? `\n\nLocal candidate library:\n${candidateContext}` : ""}

The listener wants to reshape the current set through chat. Build a tighter mini-program around that request. Requirements:
- Start by replying like a DJ to the listener and briefly explain why this new set fits
- The reply must continue the current show. Do not reintroduce yourself and do not sound like a rebooted program
- Prefer adjusting within the listener's taste instead of drifting away from their library
- Prefer the local candidate library. If you use it, return id, title, and artist exactly as provided
- Output 3 to 5 songs
- The first song must feel ready to cut to immediately

Return JSON only. Required fields:
- title: optional show title
- say: the DJ's reply to the listener, natural English, 16-44 words
- ttsText: same meaning as say, but you may add light inline performance tags
- lineup: an array of songs. Each item includes title (required), artist (optional), id (required when matched from the local candidate library), mood (optional), reason (optional)
- reason: why this switch works, natural English, 12-28 words
`;
  }

  return `你是 Claudio，一位 AI 情感电台 DJ。
用户刚刚说：${JSON.stringify(userText)}
当前时间：${timeOfDay}
${weatherContext ? `当前天气：${weatherContext}` : "天气不是这次调整的依据。"}
${hostStyleGuide}
当前歌曲：${currentTrack}
最近聊天和播放线索：
${recentHistory || "无"}

用户歌单 / 快照 / 画像：
${mergedPlaylistContext || "暂无歌单信息"}
${candidateContext ? `\n\n本地候选曲库：\n${candidateContext}` : ""}

用户想通过聊天调整现在的节目。请重新给出一个更贴合他这句需求的小节目单，要求：
- 开头先像 DJ 回应用户，说明为什么换这组歌
- 回应必须承接当前节目，不要重新自我介绍，不要像节目重新开播
- 优先用用户歌单口味做调整，不要完全脱离他的库
- 优先使用本地候选曲库；如果用了候选曲库，必须原样返回 id、title、artist
- 输出 3 到 5 首歌
- 歌单第一首应当适合立刻切过去播放

只输出 JSON，对象字段必须是：
- title: 节目标题，可选
- say: DJ 对用户的回应，中文 35-100 字
- ttsText: 给 TTS 的版本，语义与 say 一致，可加入适度行内标签
- lineup: 歌曲数组，每项包含 title（必填）、artist（选填）、id（候选曲库命中时必填）、mood（选填）、reason（选填）
- reason: 说明这次为什么这么换歌，中文 30-80 字
`;
}

async function speakDjText(
  text: string,
  profile: db.DjProfile,
  scene: tts.TTSSpeakOptions["scene"],
  atmosphere?: string,
): Promise<string | undefined> {
  try {
    const ttsResult = await tts.speak(text, {
      profile,
      scene,
      atmosphere,
    });
    return ttsResult.cachePath;
  } catch (error) {
    console.error("TTS failed:", error);
    return undefined;
  }
}

function toStoredTrack(track: PlayableTrack): db.Track {
  return {
    id: String(track.id),
    name: track.name,
    artist: track.artist,
    url: track.url,
    source: track.source,
    sourceTrackId: track.sourceTrackId,
    urlSource: track.urlSource,
    album: track.album,
    duration: track.duration,
    picUrl: track.picUrl,
    urlExpiresAt: track.urlExpiresAt,
    urlRefreshedAt: track.urlRefreshedAt,
  };
}

async function applyProgramQueue(
  source: db.RadioProgram["source"],
  response: StationProgramResponse,
  playableTracks: PlayableTrack[],
  context: MusicContext,
  userRequest?: string,
  options?: {
    preserveCurrentTrack?: boolean;
  },
): Promise<void> {
  const upcomingQueue = playableTracks.map(toStoredTrack);
  const preserveCurrentTrack = Boolean(options?.preserveCurrentTrack && context.state.currentTrack);
  const queue = preserveCurrentTrack && context.state.currentTrack
    ? [
      context.state.currentTrack,
      ...upcomingQueue.filter((track) => track.id !== context.state.currentTrack?.id),
    ]
    : upcomingQueue;
  const generatedAt = Date.now();
  await db.setRadioQueue(queue, {
    currentIndex: 0,
    program: radioSession.createRadioProgramMetadata({
      source,
      title: response.title,
      mood: response.mood,
      summary: response.reason,
      plannedMinutes: response.plannedMinutes,
      speechPlan: response.speechPlan,
      generatedAt,
      weatherContext: context.weatherContext,
      userRequest,
      tracks: queue,
    }),
  });
  await db.addChatMessage({
    role: "dj",
    text: response.say,
  });
  if (!preserveCurrentTrack && playableTracks[0]) {
    await db.recordPlay(playableTracks[0].name, playableTracks[0].artist);
  }
}

export async function runStartupRadioProgram(
  options?: {
    background?: boolean;
  },
): Promise<PipelineResult> {
  const background = options?.background ?? false;

  try {
    await ensureDataDirs();
    if (!background) {
      await db.setStatus("thinking");
    }

    const context = await gatherMusicContext({
      includeOptionalWeather: true,
      candidateLimit: 28,
    });
    const prompt = buildStartupProgramPrompt(context);
    const response = await claude.callJsonLLM<StationProgramResponse>(prompt, 35_000);

    if (!background) {
      await db.setStatus("speaking");
    }
    const [ttsAudioPath, playableTracks] = await Promise.all([
      speakDjText(
        response.ttsText?.trim() || response.say,
        context.state.djProfile,
        "program_intro",
        [context.weatherContext, response.reason].filter(Boolean).join("；"),
      ),
      resolvePlayableTracksFromRequests(
        response.lineup ?? [],
        STARTUP_FALLBACK_TRACKS,
        context.localCandidateMap,
        buildAvoidTracks(context),
      ),
    ]);

    await applyProgramQueue("startup", response, playableTracks, context);
    await db.setStatus("playing");

    return {
      status: "success",
      djMessage: response.say,
      tracks: playableTracks,
      reason: response.reason,
      ttsAudioPath,
      programTitle: response.title,
    };
  } catch (error) {
    await db.setStatus(background ? "idle" : "error");
    throw error;
  }
}

export async function runChatSwitchProgram(
  userText: string,
  options?: {
    preserveCurrentTrack?: boolean;
  },
): Promise<PipelineResult> {
  try {
    await ensureDataDirs();
    await db.setStatus("thinking");

    const context = await gatherMusicContext({
      candidateLimit: 24,
    });
    const prompt = buildChatSwitchProgramPrompt(userText, context);
    const response = await claude.callJsonLLM<StationProgramResponse>(prompt, 30_000);

    await db.setStatus("speaking");
    const [ttsAudioPath, playableTracks] = await Promise.all([
      speakDjText(
        response.ttsText?.trim() || response.say,
        context.state.djProfile,
        "music_recommendation",
        [userText, response.reason].filter(Boolean).join("；"),
      ),
      resolvePlayableTracksFromRequests(
        response.lineup ?? [],
        STARTUP_FALLBACK_TRACKS,
        context.localCandidateMap,
        buildAvoidTracks(context),
      ),
    ]);

    const currentTrackPreserved = Boolean(options?.preserveCurrentTrack && context.state.currentTrack);
    await applyProgramQueue("chat_switch", response, playableTracks, context, userText, {
      preserveCurrentTrack: options?.preserveCurrentTrack,
    });
    await db.setStatus("playing");

    return {
      status: "success",
      djMessage: response.say,
      tracks: playableTracks,
      reason: response.reason,
      ttsAudioPath,
      programTitle: response.title,
      shouldStartTrack: !currentTrackPreserved,
      currentTrackPreserved,
    };
  } catch (error) {
    await db.setStatus("error");
    throw error;
  }
}

export async function runPipeline(
  mode: "morning_brief" | "mood_pick" | "random_discover"
): Promise<PipelineResult> {
  try {
    await ensureDataDirs();
    await db.setStatus("thinking");

    const context = await gatherMusicContext({
      weatherMode: mode,
      candidateLimit: mode === "random_discover" ? 20 : 12,
    });

    let claudeResponse: claude.LLMResponse;
    try {
      const prompt = claude.buildContextPrompt({
        mode,
        timeOfDay: context.timeOfDay,
        recentHistory: context.recentHistory,
        playlistContext: context.mergedPlaylistContext,
        candidateContext: context.candidateContext,
        weatherContext: context.weatherContext,
        djVoice: context.state.djProfile.voice,
      });
      claudeResponse = await claude.callLLM(prompt);
    } catch (error) {
      await db.setStatus("idle");
      throw error;
    }

    await db.setStatus("speaking");

    const ttsTask = (async () => {
      try {
        const ttsResult = await tts.speak(claudeResponse.ttsText?.trim() || claudeResponse.say, {
          profile: context.state.djProfile,
          scene: "music_recommendation",
          atmosphere: [context.weatherContext, claudeResponse.reason].filter(Boolean).join("；"),
        });
        return ttsResult.cachePath;
      } catch (error) {
        console.error("TTS failed:", error);
        return undefined;
      }
    })();

    const trackTask = resolvePlayableTracks(
      mode,
      claudeResponse.play,
      context.localCandidateMap,
      buildAvoidTracks(context),
    );
    const [ttsAudioPath, playableTracks] = await Promise.all([ttsTask, trackTask]);

    if (playableTracks.length > 0) {
      const firstTrack = playableTracks[0];
      const queue = playableTracks.map(toStoredTrack);
      const generatedAt = Date.now();
      await db.setRadioQueue(queue, {
        currentIndex: 0,
        program: radioSession.createRadioProgramMetadata({
          source: "manual",
          summary: claudeResponse.reason,
          generatedAt,
          weatherContext: context.weatherContext,
          tracks: queue,
        }),
      });
      await db.recordPlay(firstTrack.name, firstTrack.artist);
    }

    await db.addChatMessage({
      role: "dj",
      text: claudeResponse.say,
    });

    await db.setStatus("playing");

    return {
      status: "success",
      djMessage: claudeResponse.say,
      tracks: playableTracks,
      reason: claudeResponse.reason,
      segue: claudeResponse.segue,
      ttsAudioPath,
    };
  } catch (error) {
    await db.setStatus("error");
    throw error;
  }
}
