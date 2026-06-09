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
import { formatStationTimeOfDay } from "./time.js";

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
  { title: "The Scientist", artist: "Coldplay" },
  { title: "夜空中最亮的星", artist: "逃跑计划" },
];

const DISCOVERY_FALLBACK_DIRECTIONS = [
  {
    query: "Coldplay alternative pop deep cut",
    reason: "Keeps close to a familiar melodic center while opening a less obvious lane.",
    risk: "adjacent" as const,
  },
  {
    query: "周杰伦 相近 华语 慢歌",
    reason: "Uses a known Chinese-pop anchor while moving away from the most repeated songs.",
    risk: "adjacent" as const,
  },
  {
    query: "indie pop night drive underrated",
    reason: "A controlled small step into a wider late-night indie lane.",
    risk: "small_adventure" as const,
  },
];

const MANUAL_PROGRAM_FALLBACK_TRACKS: Record<"morning_brief" | "mood_pick", Array<{ title: string; artist: string }>> = {
  morning_brief: [
    { title: "Best Day Of My Life", artist: "American Authors" },
    { title: "Sunflower", artist: "Post Malone, Swae Lee" },
    { title: "Yellow", artist: "Coldplay" },
    { title: "晴天", artist: "周杰伦" },
    { title: "Viva La Vida", artist: "Coldplay" },
    { title: "夜空中最亮的星", artist: "逃跑计划" },
  ],
  mood_pick: [
    { title: "The Scientist", artist: "Coldplay" },
    { title: "Yellow", artist: "Coldplay" },
    { title: "Let Her Go", artist: "Passenger" },
    { title: "Sunflower", artist: "Post Malone, Swae Lee" },
    { title: "Fix You", artist: "Coldplay" },
    { title: "夜空中最亮的星", artist: "逃跑计划" },
  ],
};

const CHAT_SWITCH_FALLBACK_TRACK_GROUPS = {
  electronic: [
    { title: "Strobe", artist: "deadmau5" },
    { title: "Shelter", artist: "Porter Robinson, Madeon" },
    { title: "Midnight City", artist: "M83" },
    { title: "Faded", artist: "Alan Walker" },
    { title: "After Midnight", artist: "KLYMVX, Emily Zeck" },
  ],
  calm: [
    { title: "The Scientist", artist: "Coldplay" },
    { title: "Yellow", artist: "Coldplay" },
    { title: "Fix You", artist: "Coldplay" },
    { title: "Let Her Go", artist: "Passenger" },
    { title: "夜空中最亮的星", artist: "逃跑计划" },
  ],
  rock: [
    { title: "Numb", artist: "Linkin Park" },
    { title: "Viva La Vida", artist: "Coldplay" },
    { title: "Believer", artist: "Imagine Dragons" },
    { title: "Radioactive", artist: "Imagine Dragons" },
    { title: "夜空中最亮的星", artist: "逃跑计划" },
  ],
  jazz: [
    { title: "Fly Me To The Moon", artist: "Frank Sinatra" },
    { title: "What A Wonderful World", artist: "Louis Armstrong" },
    { title: "Autumn Leaves", artist: "Bill Evans" },
    { title: "Feeling Good", artist: "Nina Simone" },
    { title: "Dream A Little Dream Of Me", artist: "Ella Fitzgerald" },
  ],
  hipHop: [
    { title: "Lose Yourself", artist: "Eminem" },
    { title: "See You Again", artist: "Wiz Khalifa, Charlie Puth" },
    { title: "Sunflower", artist: "Post Malone, Swae Lee" },
    { title: "God's Plan", artist: "Drake" },
    { title: "Mockingbird", artist: "Eminem" },
  ],
  fresh: [
    { title: "After Midnight", artist: "KLYMVX, Emily Zeck" },
    { title: "Midnight City", artist: "M83" },
    { title: "Sweet Disposition", artist: "The Temper Trap" },
    { title: "Electric Feel", artist: "MGMT" },
    { title: "Dog Days Are Over", artist: "Florence + The Machine" },
  ],
} satisfies Record<string, Array<{ title: string; artist: string }>>;

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

interface DiscoveryScoutDirection {
  query?: string;
  direction?: string;
  reason?: string;
  risk?: db.DiscoveryRisk;
}

interface DiscoveryScoutResponse {
  say?: string;
  ttsText?: string;
  directions?: DiscoveryScoutDirection[];
  reason?: string;
}

interface DiscoveredPlayableTrack {
  track: PlayableTrack;
  query: string;
  direction: string;
  reason: string;
  risk: db.DiscoveryRisk;
}

interface MusicContext {
  state: Awaited<ReturnType<typeof db.getState>>;
  timeOfDay: string;
  recentHistory: string;
  feedbackContext: string;
  mergedPlaylistContext: string;
  candidateContext: string;
  recommendationCandidates: tasteProfile.RecommendationCandidate[];
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
  const feedbackSummary = db.summarizeUserFeedback(20);
  const runtimeTasteContext = tasteProfile.summarizeRuntimeTasteProfile(
    Array.isArray(state.userFeedback) ? state.userFeedback : [],
  );
  const feedbackContext = [feedbackSummary, runtimeTasteContext].filter(Boolean).join("\n\n");

  const timeOfDay = formatStationTimeOfDay();

  const playlistContext = db.summarizePlaylists();
  const [ncmPlaylistContext, snapshot, profile, localLibraryContext, weatherContext] = await Promise.all([
    buildNcmPlaylistContext(),
    db.getNeteaseSnapshot(),
    tasteProfile.getTasteProfile(),
    musicSources.summarizeLocalLibraryForPrompt(options?.candidateLimit ?? 20),
    options?.weatherMode
      ? buildWeatherContext(options.weatherMode)
      : options?.includeOptionalWeather
        ? buildOptionalWeatherContext()
        : undefined,
  ]);

  const candidatePool = snapshot && profile
    ? tasteProfile.buildRecommendationCandidates(
        snapshot,
        profile,
        Array.isArray(state.playHistory) ? state.playHistory : [],
        options?.candidateLimit ?? 20,
        Array.isArray(state.userFeedback) ? state.userFeedback : [],
      )
    : [];
  const candidateContext = [
    tasteProfile.summarizeRecommendationCandidates(candidatePool),
    localLibraryContext,
  ].filter(Boolean).join("\n\n");
  const localCandidateMap = new Map(candidatePool.map((candidate) => [candidate.id, candidate]));
  const mergedPlaylistContext = [playlistContext, ncmPlaylistContext]
    .filter(Boolean)
    .join("\n\n");

  return {
    state,
    timeOfDay,
    recentHistory,
    feedbackContext,
    mergedPlaylistContext,
    candidateContext,
    recommendationCandidates: candidatePool,
    localCandidateMap,
    weatherContext,
  };
}

function hasRecentNegativeFeedback(context: MusicContext): boolean {
  const feedback = Array.isArray(context.state.userFeedback) ? context.state.userFeedback : [];
  return feedback.slice(0, 5).some((item) =>
    item.type === "less_like_this"
    || item.type === "dislike_track"
    || item.type === "skip_track"
  );
}

function hasRecentPositiveFeedback(context: MusicContext): boolean {
  const feedback = Array.isArray(context.state.userFeedback) ? context.state.userFeedback : [];
  return feedback.slice(0, 5).some((item) =>
    item.type === "more_like_this"
    || item.type === "favorite_track"
    || item.type === "complete_track"
    || item.type === "ask_about_track"
    || item.type === "replay_dj"
  );
}

function normalizeDiscoveryRisk(
  value: unknown,
  context: MusicContext,
): db.DiscoveryRisk {
  if (value === "small_adventure" && !hasRecentNegativeFeedback(context)) {
    return "small_adventure";
  }
  return "adjacent";
}

function buildDiscoveryScoutPrompt(
  context: MusicContext,
  purpose: "random_discover" | "program",
): string {
  const { timeOfDay, recentHistory, feedbackContext, mergedPlaylistContext, candidateContext, state } = context;
  const language = djLanguage.resolveDjCopyLanguage(state.djProfile);
  const useEnglish = language === "en";
  const recentNegative = hasRecentNegativeFeedback(context);
  const verifiedContext = db.summarizeDiscoveryCandidates(8);

  if (useEnglish) {
    return `You are Claudio's Discovery Scout.
Current time: ${timeOfDay}
Purpose: ${purpose === "random_discover" ? "the listener pressed Discover" : "add limited exploration to a stable radio program"}
Recent chat and playback clues:
${recentHistory || "none"}
Explicit listener feedback:
${feedbackContext || "none"}
Verified previous discoveries:
${verifiedContext || "none"}
User taste / playlists:
${mergedPlaylistContext || "No playlist context yet"}
${candidateContext ? `\n\nOnline candidate pool:\n${candidateContext}` : ""}

Return exploration directions only. Do not decide the final playable songs. The backend will search online sources and verify playable audio.
Rules:
- Produce 4 to 7 search directions that are close to the listener's taste, not random
- At least 70% should be stable or adjacent to the current taste
- Use small_adventure only when it is still explainable from the taste context
- ${recentNegative ? "Recent negative feedback exists, so do not use small_adventure." : "At most one direction may be small_adventure."}
- Each query should be searchable as plain text on a music source
- Avoid exact repeats from recent playback and explicit dislikes

Return JSON only:
- say: one short DJ line, natural English, 10-26 words, explaining that you will test a nearby direction
- ttsText: same meaning, normal conversational pace, no slow/deep/whisper/theatrical tags
- directions: array of objects with query, direction, reason, risk ("adjacent" or "small_adventure")
- reason: short explanation of the exploration strategy`;
  }

  return `你是 Claudio 的 Discovery Scout。
当前时间：${timeOfDay}
目的：${purpose === "random_discover" ? "用户点击了 Discover" : "给稳定节目加入有限探索"}
最近聊天和播放线索：
${recentHistory || "无"}
用户显性音乐反馈：
${feedbackContext || "无"}
最近已验证探索候选：
${verifiedContext || "无"}
用户口味 / 歌单：
${mergedPlaylistContext || "暂无歌单信息"}
${candidateContext ? `\n\n在线候选池：\n${candidateContext}` : ""}

只返回探索方向，不要直接决定最终播放歌曲。后端会用这些方向去在线搜索真实歌曲，并验证音频可播放。
规则：
- 输出 4 到 7 个搜索方向，必须贴近用户口味，不要随机乱跳
- 至少 70% 是稳定口味或相邻探索
- small_adventure 必须能从口味上下文解释出来
- ${recentNegative ? "最近有负反馈，所以不要使用 small_adventure。" : "最多一个方向可以是 small_adventure。"}
- query 必须是可以直接拿去音乐源搜索的普通文本
- 避免最近播放和明确不喜欢的歌曲

只输出 JSON：
- say: 一句很短的 DJ 说明，中文 20-60 字，说明会试一个相邻方向
- ttsText: 语义相同，正常聊天语速，不要加入低声、语速放慢、故作深沉或表演化标签
- directions: 数组，每项包含 query、direction、reason、risk（"adjacent" 或 "small_adventure"）
- reason: 简短说明这次探索策略`;
}

function buildFallbackDiscoveryScoutResponse(context: MusicContext): DiscoveryScoutResponse {
  const fromCandidates = context.recommendationCandidates.slice(0, 4).map((candidate) => ({
    query: `${candidate.artist} ${candidate.title}`,
    direction: `${candidate.artist} adjacent pick`,
    reason: `Uses a known taste signal from ${candidate.sourcePlaylists.slice(0, 2).join(" / ") || "the online candidate pool"}.`,
    risk: "adjacent" as const,
  }));
  const directions = [...fromCandidates, ...DISCOVERY_FALLBACK_DIRECTIONS].slice(0, 6);

  return {
    say: "我先沿着你的熟悉口味往旁边试一小步，能播再放进队列。",
    ttsText: "我先沿着你的熟悉口味往旁边试一小步，能播再放进队列。",
    directions,
    reason: "Fallback discovery keeps exploration bounded when the scout model is temporarily unavailable.",
  };
}

async function runDiscoveryScout(
  context: MusicContext,
  purpose: "random_discover" | "program",
): Promise<DiscoveryScoutResponse> {
  try {
    const response = await claude.callJsonLLM<DiscoveryScoutResponse>(
      buildDiscoveryScoutPrompt(context, purpose),
      claude.getLlmTaskTimeoutMs("discovery"),
    );
    if (Array.isArray(response.directions) && response.directions.length > 0) {
      return response;
    }
  } catch (error) {
    console.warn(`[radio] discovery scout failed, using fallback directions: ${error instanceof Error ? error.message : String(error)}`);
  }

  return buildFallbackDiscoveryScoutResponse(context);
}

function normalizeDiscoveryDirections(
  response: DiscoveryScoutResponse,
  context: MusicContext,
): Array<{ query: string; direction: string; reason: string; risk: db.DiscoveryRisk }> {
  const normalized: Array<{ query: string; direction: string; reason: string; risk: db.DiscoveryRisk }> = [];
  let usedSmallAdventure = false;

  for (const item of response.directions ?? []) {
    const query = (item.query ?? item.direction ?? "").trim().slice(0, 180);
    if (!query) continue;

    const direction = (item.direction ?? item.query ?? query).trim().slice(0, 180);
    const reason = (item.reason ?? response.reason ?? "Exploration direction from Discovery Scout.").trim().slice(0, 240);
    let risk = normalizeDiscoveryRisk(item.risk, context);
    if (risk === "small_adventure") {
      if (usedSmallAdventure) {
        risk = "adjacent";
      } else {
        usedSmallAdventure = true;
      }
    }

    normalized.push({ query, direction, reason, risk });
    if (normalized.length >= 7) break;
  }

  return normalized;
}

async function resolveDiscoveryDirections(
  response: DiscoveryScoutResponse,
  context: MusicContext,
  maxTracks: number,
): Promise<DiscoveredPlayableTrack[]> {
  const directions = normalizeDiscoveryDirections(response, context);
  const avoidKeys = new Set(
    buildAvoidTracks(context)
      .map((track) => normalizeTrackKey(track.title ?? track.name, track.artist))
      .filter((key) => key !== "::"),
  );
  const seen = new Set<string>();
  const discoveries: DiscoveredPlayableTrack[] = [];

  for (const direction of directions) {
    if (discoveries.length >= maxTracks) break;
    try {
      const track = await musicSources.resolveTrack(
        direction.query,
        undefined,
        musicSources.NETEASE_LEGACY_SOURCE_ID,
      );
      if (!track) continue;
      const key = normalizeTrackKey(track.name, track.artist);
      if (key === "::" || seen.has(key) || avoidKeys.has(key)) {
        continue;
      }
      seen.add(key);
      discoveries.push({
        track,
        ...direction,
      });
    } catch (error) {
      console.warn(`[radio] discovery direction failed "${direction.query}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (discoveries.length > 0) {
    await db.addDiscoveryCandidates(discoveries.map((discovery) => ({
      query: discovery.query,
      direction: discovery.direction,
      title: discovery.track.name,
      artist: discovery.track.artist,
      reason: discovery.reason,
      risk: discovery.risk,
      source: discovery.track.source,
      sourceTrackId: discovery.track.sourceTrackId,
      urlSource: discovery.track.urlSource,
      health: "ready",
    })));
  }

  return discoveries;
}

function buildStableSeedRequests(context: MusicContext, limit: number): RequestedTrack[] {
  const fromCandidates = context.recommendationCandidates.slice(0, limit).map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    artist: candidate.artist,
  }));
  return fromCandidates.length > 0
    ? fromCandidates
    : STARTUP_FALLBACK_TRACKS.slice(0, limit);
}

function mergeExplorationTracks(
  stableTracks: PlayableTrack[],
  discoveries: DiscoveredPlayableTrack[],
  options?: {
    maxExploration?: number;
    firstInsertAfter?: number;
  },
): PlayableTrack[] {
  if (discoveries.length === 0) {
    return stableTracks;
  }
  if (stableTracks.length === 0) {
    return dedupePlayableTracks(discoveries.map((discovery) => discovery.track));
  }

  const maxExploration = Math.min(
    discoveries.length,
    Math.max(0, options?.maxExploration ?? Math.max(1, Math.floor(stableTracks.length / 4))),
  );
  if (maxExploration === 0) {
    return stableTracks;
  }

  const firstInsertAfter = Math.max(1, options?.firstInsertAfter ?? 3);
  const merged: PlayableTrack[] = [];
  let inserted = 0;
  stableTracks.forEach((track, index) => {
    merged.push(track);
    const stableCount = index + 1;
    const shouldInsert =
      inserted < maxExploration
      && stableCount >= firstInsertAfter
      && (stableCount - firstInsertAfter) % 4 === 0;
    if (shouldInsert) {
      merged.push(discoveries[inserted].track);
      inserted += 1;
    }
  });

  if (inserted < maxExploration && stableTracks.length <= firstInsertAfter) {
    merged.push(...discoveries.slice(inserted, maxExploration).map((discovery) => discovery.track));
  }

  return dedupePlayableTracks(merged);
}

async function addControlledDiscoveriesToProgram(
  stableTracks: PlayableTrack[],
  context: MusicContext,
): Promise<PlayableTrack[]> {
  if (stableTracks.length < 4 || context.recommendationCandidates.length === 0) {
    return stableTracks;
  }

  const scoutResponse = await runDiscoveryScout(context, "program");
  const discoveries = await resolveDiscoveryDirections(scoutResponse, context, 3);
  const baseExploration = Math.max(1, Math.floor(stableTracks.length / 4));
  const maxExploration = Math.min(
    3,
    baseExploration + (hasRecentPositiveFeedback(context) ? 1 : 0),
  );
  return mergeExplorationTracks(stableTracks, discoveries, {
    maxExploration,
    firstInsertAfter: 3,
  });
}

function getPlayableTrackKey(track: PlayableTrack): string {
  return normalizeTrackKey(track.name, track.artist);
}

function dedupePlayableTracks(tracks: PlayableTrack[]): PlayableTrack[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = getPlayableTrackKey(track);
    if (key === "::" || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function resolvePlayableTracksFromRequests(
  playList: RequestedTrack[],
  fallbackTracks: Array<{ title: string; artist: string }>,
  localCandidateMap: Map<number, tasteProfile.RecommendationCandidate> = new Map(),
  avoidTracks: TrackIdentity[] = [],
  options?: {
    minTracks?: number;
    maxTracks?: number;
  },
): Promise<PlayableTrack[]> {
  const minTracks = Math.max(1, options?.minTracks ?? 1);
  const maxTracks = Math.max(minTracks, options?.maxTracks ?? Number.POSITIVE_INFINITY);
  const limitTracks = (tracks: PlayableTrack[]) =>
    Number.isFinite(maxTracks) ? tracks.slice(0, maxTracks) : tracks;
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
  if (preferredTracks.length >= minTracks || (preferredTracks.length > 0 && minTracks <= 1)) {
    return limitTracks(preferredTracks);
  }

  const attemptedKeys = new Set(
    attempts.map((track) => normalizeTrackKey(track.title, track.artist)),
  );
  const fallbackPlayableTracks: PlayableTrack[] = [];
  for (const fallback of fallbackTracks) {
    if (attemptedKeys.has(normalizeTrackKey(fallback.title, fallback.artist))) {
      continue;
    }
    try {
      const track = await musicSources.resolveTrack(fallback.title, fallback.artist);
      if (track) {
        fallbackPlayableTracks.push(track);
      }
    } catch (error) {
      console.error(`Fallback track failed ${fallback.title}:`, error);
    }
  }

  const combinedTracks = dedupePlayableTracks([...playableTracks, ...fallbackPlayableTracks]);
  const freshCombinedTracks = filterProgramTrackRepeats(combinedTracks, avoidTracks);
  if (freshCombinedTracks.length >= minTracks || combinedTracks.length < minTracks) {
    return limitTracks(freshCombinedTracks.length > 0 ? freshCombinedTracks : combinedTracks);
  }

  return limitTracks(combinedTracks);
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
  const { timeOfDay, weatherContext, recentHistory, feedbackContext, mergedPlaylistContext, candidateContext, state } = context;
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
Explicit listener feedback:
${feedbackContext || "none"}

User playlists / snapshots / taste profile:
${mergedPlaylistContext || "No playlist context yet"}
${candidateContext ? `\n\nOnline candidate pool:\n${candidateContext}` : ""}

Please program a 20-40 minute radio session for “the station right after the service starts”. Requirements:
- Organize the mood using time, weather, and the listener's playlist taste
- The opening should sound like a real DJ opening the mic: warm, companionable, never like a system notice
- The intro should happen only once, like the real start of a show, not like every song is a fresh opening
- Order the songs naturally so each handoff feels deliberate
- Prefer the online candidate pool. For numeric Netease candidates, return id/title/artist exactly
- Output 6 to 10 songs, enough for roughly 20-40 minutes
- Include a speechPlan: intro before the first song, then only short talk or bumper spots every 2-3 songs

Return JSON only. Required fields:
- title: optional show title
- mood: the overall mood of this session
- plannedMinutes: target duration, an integer from 20 to 40
- say: the opening line for the UI, natural English, 20-65 words
- ttsText: same meaning as say, normal conversational pace, no slow/deep/whisper/theatrical performance tags
- lineup: an array of songs. Each item includes title (required), artist (optional), id (required for numeric Netease candidates), mood (optional), reason (optional)
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
用户显性音乐反馈：
${feedbackContext || "无"}

用户歌单 / 快照 / 画像：
${mergedPlaylistContext || "暂无歌单信息"}
${candidateContext ? `\n\n在线候选池：\n${candidateContext}` : ""}

请为“服务刚启动时的电台节目”编排一段 20 到 40 分钟的 Radio Session，要求：
- 结合时间、天气、用户歌单口味来组织节目气氛
- 节目开场要像真实 DJ 开麦，温柔、有陪伴感，不要太像公告
- 开场对白只能像节目真正开始时说一次，不要像每首歌前都在重新开场
- 歌单按顺序编排，前后过渡自然
- 优先使用在线候选池；命中网易云数字 id 候选时原样返回 id、title、artist
- 输出 6 到 10 首歌，整体约 20 到 40 分钟
- 增加 speechPlan：第一首前是 intro，之后每 2 到 3 首歌才安排一次 short_say 或 bumper

只输出 JSON，对象字段必须是：
- title: 节目标题，可选
- mood: 这段节目的整体氛围
- plannedMinutes: 目标时长，20 到 40 之间的整数
- say: 开场对白，给前端显示，中文 40-120 字
- ttsText: 给 TTS 的版本，语义与 say 一致，保持正常聊天语速，不要加入低声、语速放慢、故作深沉或表演化标签
- lineup: 歌曲数组，每项包含 title（必填）、artist（选填）、id（命中网易云数字 id 候选时必填）、mood（选填）、reason（选填）
- speechPlan: 可选数组，每项包含 beforeTrackIndex（从 0 开始）、type（"intro"、"short_say"、"bumper" 或 "closing"）、note（可选）
- reason: 说明这档节目为什么这么编排，中文 30-80 字
`;
}

function buildManualProgramPrompt(
  mode: "morning_brief" | "mood_pick",
  context: MusicContext,
): string {
  const { timeOfDay, weatherContext, recentHistory, feedbackContext, mergedPlaylistContext, candidateContext, state } = context;
  const language = djLanguage.resolveDjCopyLanguage(state.djProfile);
  const useEnglish = language === "en";
  const hostStyleGuide = radioStyle.buildHostStyleGuide(timeOfDay, weatherContext, language);
  const modeLabel = mode === "morning_brief"
    ? useEnglish ? "a fresh morning radio program" : "晨间电台节目"
    : useEnglish ? "a mood-based radio program" : "基于当下心情的电台节目";

  if (useEnglish) {
    return `You are Claudio, an AI emotional radio DJ.
Current time: ${timeOfDay}
Current request: ${modeLabel}
${weatherContext ? `Current weather: ${weatherContext}` : "Weather is not part of this request."}
${hostStyleGuide}
Recent chat and playback clues:
${recentHistory || "none"}
Explicit listener feedback:
${feedbackContext || "none"}

User playlists / snapshots / taste profile:
${mergedPlaylistContext || "No playlist context yet"}
${candidateContext ? `\n\nOnline candidate pool:\n${candidateContext}` : ""}

Please refresh the station with a complete 20-40 minute radio program, not a single song. Requirements:
- Keep music continuity first; the new set should be ready to play without blocking on future model calls
- Prefer the online candidate pool. For numeric Netease candidates, return id/title/artist exactly
- Output 6 to 10 songs
- Make the first song reliable and familiar enough, then sequence the rest naturally
- The DJ line should be specific and concise, 16-40 words
- Include a sparse speechPlan: intro before the first song, then only short talk or bumper spots every 2-3 songs

Return JSON only. Required fields:
- title: optional show title
- mood: the overall mood of this session
- plannedMinutes: target duration, an integer from 20 to 40
- say: the line shown in the UI, natural English, 16-40 words
- ttsText: same meaning as say, normal conversational pace, no slow/deep/whisper/theatrical performance tags
- lineup: an array of songs. Each item includes title (required), artist (optional), id (required for numeric Netease candidates), mood (optional), reason (optional)
- speechPlan: optional array. Each item includes beforeTrackIndex (0-based), type ("intro", "short_say", "bumper", or "closing"), note (optional)
- reason: why this set is arranged this way, natural English, 14-30 words
`;
  }

  return `你是 Claudio，一位 AI 情感电台 DJ。
当前时间：${timeOfDay}
当前请求：${modeLabel}
${weatherContext ? `当前天气：${weatherContext}` : "天气不是这次调整的依据。"}
${hostStyleGuide}
最近聊天和播放线索：
${recentHistory || "无"}
用户显性音乐反馈：
${feedbackContext || "无"}

用户歌单 / 快照 / 画像：
${mergedPlaylistContext || "暂无歌单信息"}
${candidateContext ? `\n\n在线候选池：\n${candidateContext}` : ""}

请刷新成一段完整的 20 到 40 分钟电台节目，不要只推荐单首歌。要求：
- 音乐连续播放优先；新节目单要一次性准备好，不能依赖后续模型调用才能继续
- 优先使用在线候选池；命中网易云数字 id 候选时原样返回 id、title、artist
- 输出 6 到 10 首歌
- 第一首要稳，后续顺序要自然、有承接
- DJ 文案要具体、短，中文 35-90 字
- 增加稀疏 speechPlan：第一首前是 intro，之后每 2 到 3 首歌才安排一次 short_say 或 bumper

只输出 JSON，对象字段必须是：
- title: 节目标题，可选
- mood: 这段节目的整体氛围
- plannedMinutes: 目标时长，20 到 40 之间的整数
- say: 前端显示文案，中文 35-90 字
- ttsText: 给 TTS 的版本，语义与 say 一致，保持正常聊天语速，不要加入低声、语速放慢、故作深沉或表演化标签
- lineup: 歌曲数组，每项包含 title（必填）、artist（选填）、id（命中网易云数字 id 候选时必填）、mood（选填）、reason（选填）
- speechPlan: 可选数组，每项包含 beforeTrackIndex（从 0 开始）、type（"intro"、"short_say"、"bumper" 或 "closing"）、note（可选）
- reason: 说明这档节目为什么这么编排，中文 30-80 字
`;
}

function buildChatSwitchProgramPrompt(
  userText: string,
  context: MusicContext,
): string {
  const { timeOfDay, weatherContext, recentHistory, feedbackContext, mergedPlaylistContext, candidateContext, state } = context;
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
Explicit listener feedback:
${feedbackContext || "none"}

User playlists / snapshots / taste profile:
${mergedPlaylistContext || "No playlist context yet"}
${candidateContext ? `\n\nOnline candidate pool:\n${candidateContext}` : ""}

The listener wants to reshape the current set through chat. Build a tighter mini-program around that request. Requirements:
- Start by replying like a DJ to the listener and briefly explain why this new set fits
- The reply must continue the current show. Do not reintroduce yourself and do not sound like a rebooted program
- Prefer adjusting within the listener's taste instead of drifting away from their library
- Prefer the online candidate pool. For numeric Netease candidates, return id/title/artist exactly
- Output 3 to 5 songs
- The first song must feel ready to cut to immediately

Return JSON only. Required fields:
- title: optional show title
- say: the DJ's reply to the listener, natural English, 16-44 words
- ttsText: same meaning as say, normal conversational pace, no slow/deep/whisper/theatrical performance tags
- lineup: an array of songs. Each item includes title (required), artist (optional), id (required for numeric Netease candidates), mood (optional), reason (optional)
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
用户显性音乐反馈：
${feedbackContext || "无"}

用户歌单 / 快照 / 画像：
${mergedPlaylistContext || "暂无歌单信息"}
${candidateContext ? `\n\n在线候选池：\n${candidateContext}` : ""}

用户想通过聊天调整现在的节目。请重新给出一个更贴合他这句需求的小节目单，要求：
- 开头先像 DJ 回应用户，说明为什么换这组歌
- 回应必须承接当前节目，不要重新自我介绍，不要像节目重新开播
- 优先用用户歌单口味做调整，不要完全脱离他的库
- 优先使用在线候选池；命中网易云数字 id 候选时原样返回 id、title、artist
- 输出 3 到 5 首歌
- 歌单第一首应当适合立刻切过去播放

只输出 JSON，对象字段必须是：
- title: 节目标题，可选
- say: DJ 对用户的回应，中文 35-100 字
- ttsText: 给 TTS 的版本，语义与 say 一致，保持正常聊天语速，不要加入低声、语速放慢、故作深沉或表演化标签
- lineup: 歌曲数组，每项包含 title（必填）、artist（选填）、id（命中网易云数字 id 候选时必填）、mood（选填）、reason（选填）
- reason: 说明这次为什么这么换歌，中文 30-80 字
`;
}

function buildFallbackStartupProgramResponse(context: MusicContext): StationProgramResponse {
  const language = djLanguage.resolveDjCopyLanguage(context.state.djProfile);
  const useEnglish = language === "en";

  return {
    title: useEnglish ? "Continuity Set" : "Claudio 续播电台",
    mood: useEnglish ? "steady, warm continuity" : "稳定、温和、自然续播",
    plannedMinutes: 24,
    speechPlan: radioSession.buildDefaultSpeechPlan(STARTUP_FALLBACK_TRACKS.length),
    say: useEnglish
      ? "I'll keep the station moving with a steady set first. Let the first few songs open the room, then I'll step in only when the handoff needs a light touch."
      : "我先把节目接稳，让前几首歌自然展开。中间只在需要承接的时候短短说一句，先保证音乐不断、气氛不断。",
    ttsText: useEnglish
      ? "I'll keep the station moving with a steady set first. Let the first few songs open the room, then I'll step in only when the handoff needs a light touch."
      : "我先把节目接稳，让前几首歌自然展开。中间只在需要承接的时候短短说一句，先保证音乐不断、气氛不断。",
    lineup: STARTUP_FALLBACK_TRACKS,
    reason: useEnglish
      ? "Fallback programming keeps a complete long-form set available when the model is temporarily unavailable."
      : "模型暂时不可用时，先用稳定候选曲保持一档完整节目可播放。",
  };
}

function clampDjLine(text: string | undefined, fallback: string, maxLength = 92): string {
  const normalized = (text?.trim() || fallback).replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const head = normalized.slice(0, maxLength);
  const breakpoints = ["。", "！", "？", ".", "!", "?", "；", ";"];
  const boundary = Math.max(...breakpoints.map((mark) => head.lastIndexOf(mark)));
  if (boundary >= 35) {
    return head.slice(0, boundary + 1);
  }

  return `${head.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function buildManualFallbackLineup(
  mode: "morning_brief" | "mood_pick",
  context: MusicContext,
): Array<ProgramRequestedTrack & { artist: string }> {
  const candidateLineup = context.recommendationCandidates.slice(0, 6).map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    artist: candidate.artist,
  }));
  if (candidateLineup.length >= 4) {
    return candidateLineup;
  }

  return MANUAL_PROGRAM_FALLBACK_TRACKS[mode];
}

function buildFallbackManualProgramResponse(
  mode: "morning_brief" | "mood_pick",
  context: MusicContext,
): StationProgramResponse {
  const language = djLanguage.resolveDjCopyLanguage(context.state.djProfile);
  const useEnglish = language === "en";
  const lineup = buildManualFallbackLineup(mode, context);

  if (mode === "morning_brief") {
    return {
      title: useEnglish ? "Morning Continuity" : "Claudio 晨间续播",
      mood: useEnglish ? "fresh, steady, bright" : "清醒、稳定、轻快",
      plannedMinutes: 24,
      speechPlan: radioSession.buildDefaultSpeechPlan(lineup.length),
      say: useEnglish
        ? "I'll refresh the morning set with a steady run of songs, keeping the first handoff clean and the music moving."
        : "我把晨间节目重新接成一组完整队列，第一首先稳稳进入，后面按清爽一点的节奏自然往前走。",
      ttsText: useEnglish
        ? "I'll refresh the morning set with a steady run of songs, keeping the first handoff clean and the music moving."
        : "我把晨间节目重新接成一组完整队列，第一首先稳稳进入，后面按清爽一点的节奏自然往前走。",
      lineup,
      reason: useEnglish
        ? "Fallback programming keeps the morning trigger useful when the model is temporarily unavailable."
        : "模型暂时不可用时，先用稳定候选曲保证晨间节目能连续播放。",
    };
  }

  return {
    title: useEnglish ? "Mood Continuity" : "Claudio 心情续播",
    mood: useEnglish ? "warm, steady, listener-shaped" : "温和、稳定、贴近口味",
    plannedMinutes: 24,
    speechPlan: radioSession.buildDefaultSpeechPlan(lineup.length),
    say: useEnglish
      ? "I'll refresh the next stretch around a warmer mood and keep enough songs ready so the station can keep flowing."
      : "我把后面的节目换成一组更贴近当下心情的队列，先保证音乐不断，再慢慢把气氛接顺。",
    ttsText: useEnglish
      ? "I'll refresh the next stretch around a warmer mood and keep enough songs ready so the station can keep flowing."
      : "我把后面的节目换成一组更贴近当下心情的队列，先保证音乐不断，再慢慢把气氛接顺。",
    lineup,
    reason: useEnglish
      ? "Fallback programming keeps a complete mood-based set ready when the model is temporarily unavailable."
      : "模型暂时不可用时，先用稳定候选曲保持一段完整心情节目可播放。",
  };
}

function selectChatSwitchFallbackLineup(userText: string, context: MusicContext): ProgramRequestedTrack[] {
  const normalized = userText.trim().toLowerCase();
  if (/电子|电音|edm|electronic|synth|techno|house/.test(normalized)) {
    return CHAT_SWITCH_FALLBACK_TRACK_GROUPS.electronic;
  }
  if (/安静|轻松|舒缓|温柔|治愈|calm|quiet|soft|chill/.test(normalized)) {
    return CHAT_SWITCH_FALLBACK_TRACK_GROUPS.calm;
  }
  if (/摇滚|更燃|燃一点|rock|energetic/.test(normalized)) {
    return CHAT_SWITCH_FALLBACK_TRACK_GROUPS.rock;
  }
  if (/爵士|jazz/.test(normalized)) {
    return CHAT_SWITCH_FALLBACK_TRACK_GROUPS.jazz;
  }
  if (/说唱|嘻哈|hip[- ]?hop|rap/.test(normalized)) {
    return CHAT_SWITCH_FALLBACK_TRACK_GROUPS.hipHop;
  }

  const candidateLineup = context.recommendationCandidates.slice(0, 5).map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    artist: candidate.artist,
  }));
  if (candidateLineup.length >= 3) {
    return candidateLineup;
  }

  return CHAT_SWITCH_FALLBACK_TRACK_GROUPS.fresh;
}

function buildFallbackChatSwitchProgramResponse(userText: string, context: MusicContext): StationProgramResponse {
  const language = djLanguage.resolveDjCopyLanguage(context.state.djProfile);
  const useEnglish = language === "en";
  const fallbackLineup = selectChatSwitchFallbackLineup(userText, context);

  return {
    title: useEnglish ? "Fresh Turn" : "Claudio 换歌续播",
    mood: useEnglish ? "steady, refreshed continuity" : "稳定、换向、继续播放",
    plannedMinutes: 18,
    speechPlan: radioSession.buildDefaultSpeechPlan(fallbackLineup.length),
    say: useEnglish
      ? "Got it. I'll reshape the next stretch with a steadier fallback set and keep the handoff moving."
      : "收到，我先把后面的节目单换成一组更稳的候选，当前音乐不断，下一段会按你的方向接过去。",
    ttsText: useEnglish
      ? "Got it. I'll reshape the next stretch with a steadier fallback set and keep the handoff moving."
      : "收到，我先把后面的节目单换成一组更稳的候选，当前音乐不断，下一段会按你的方向接过去。",
    lineup: fallbackLineup,
    reason: useEnglish
      ? `The model could not finish the custom switch, so Claudio used a keyword-based fallback set for: ${userText}`
      : `模型暂时没能完成定制换歌，先用关键词候选承接这次请求：${userText}`,
  };
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
    let response: StationProgramResponse;
    try {
      response = await claude.callJsonLLM<StationProgramResponse>(
        prompt,
        claude.getLlmTaskTimeoutMs("startup"),
      );
    } catch (error) {
      console.warn("[radio] startup LLM failed, using deterministic fallback program:", error);
      response = buildFallbackStartupProgramResponse(context);
    }

    const say = clampDjLine(response.say, "我先把节目接稳，让前几首歌自然展开，中间只在需要承接的时候短短说一句。");
    const ttsText = clampDjLine(response.ttsText, say, 140);

    if (!background) {
      await db.setStatus("speaking");
    }
    const [ttsAudioPath, stableTracks] = await Promise.all([
      speakDjText(
        ttsText,
        context.state.djProfile,
        "program_intro",
        [context.weatherContext, response.reason].filter(Boolean).join("；"),
      ),
      resolvePlayableTracksFromRequests(
        response.lineup ?? [],
        STARTUP_FALLBACK_TRACKS,
        context.localCandidateMap,
        buildAvoidTracks(context),
        { minTracks: STARTUP_FALLBACK_TRACKS.length, maxTracks: 10 },
      ),
    ]);
    const playableTracks = await addControlledDiscoveriesToProgram(stableTracks, context);

    const programResponse: StationProgramResponse = {
      ...response,
      say,
      ttsText,
      speechPlan: radioSession.buildDefaultSpeechPlan(playableTracks.length),
    };
    await applyProgramQueue("startup", programResponse, playableTracks, context);
    await db.setStatus("playing");

    return {
      status: "success",
      djMessage: say,
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
    let response: StationProgramResponse;
    let usedFallbackProgram = false;
    try {
      response = await claude.callJsonLLM<StationProgramResponse>(
        prompt,
        claude.getLlmTaskTimeoutMs("chat_switch"),
      );
    } catch (error) {
      console.warn("[radio] chat switch LLM failed, using deterministic fallback program:", error);
      response = buildFallbackChatSwitchProgramResponse(userText, context);
      usedFallbackProgram = true;
    }

    const say = clampDjLine(response.say, "收到，我把后面的节目换成一组更稳的候选，当前音乐不断，下一段会按你的方向接过去。");
    const ttsText = clampDjLine(response.ttsText, say, 140);

    await db.setStatus("speaking");
    const [ttsAudioPath, stableTracks] = await Promise.all([
      speakDjText(
        ttsText,
        context.state.djProfile,
        "music_recommendation",
        [userText, response.reason].filter(Boolean).join("；"),
      ),
      resolvePlayableTracksFromRequests(
        response.lineup ?? [],
        STARTUP_FALLBACK_TRACKS,
        context.localCandidateMap,
        buildAvoidTracks(context),
        { minTracks: 3, maxTracks: 5 },
      ),
    ]);
    const playableTracks = usedFallbackProgram
      ? stableTracks
      : await addControlledDiscoveriesToProgram(stableTracks, context);

    const currentTrackPreserved = Boolean(options?.preserveCurrentTrack && context.state.currentTrack);
    const programResponse: StationProgramResponse = {
      ...response,
      say,
      ttsText,
      speechPlan: radioSession.buildDefaultSpeechPlan(playableTracks.length),
    };
    await applyProgramQueue("chat_switch", programResponse, playableTracks, context, userText, {
      preserveCurrentTrack: options?.preserveCurrentTrack,
    });
    await db.setStatus("playing");

    return {
      status: "success",
      djMessage: say,
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

async function runManualRadioProgram(
  mode: "morning_brief" | "mood_pick",
): Promise<PipelineResult> {
  try {
    await ensureDataDirs();
    await db.setStatus("thinking");

    const context = await gatherMusicContext({
      weatherMode: mode,
      candidateLimit: 24,
    });
    let response: StationProgramResponse;
    try {
      response = await claude.callJsonLLM<StationProgramResponse>(
        buildManualProgramPrompt(mode, context),
        claude.getLlmTaskTimeoutMs("startup"),
      );
    } catch (error) {
      console.warn(`[radio] manual ${mode} LLM failed, using deterministic fallback program:`, error);
      response = buildFallbackManualProgramResponse(mode, context);
    }

    const fallbackLineup = buildManualFallbackLineup(mode, context);
    const say = clampDjLine(
      response.say,
      mode === "morning_brief"
        ? "我把晨间节目重新接成一组完整队列，先保证音乐不断，后面按清爽一点的节奏自然往前走。"
        : "我把后面的节目换成一组更贴近当下心情的队列，先保证音乐不断，再慢慢把气氛接顺。",
    );
    const ttsText = response.ttsText?.trim() || say;

    await db.setStatus("speaking");
    const [ttsAudioPath, stableTracks] = await Promise.all([
      speakDjText(
        ttsText,
        context.state.djProfile,
        "music_recommendation",
        [context.weatherContext, response.reason].filter(Boolean).join("；"),
      ),
      resolvePlayableTracksFromRequests(
        response.lineup ?? [],
        fallbackLineup,
        context.localCandidateMap,
        buildAvoidTracks(context),
        { minTracks: 6, maxTracks: 10 },
      ),
    ]);
    const playableTracks = await addControlledDiscoveriesToProgram(stableTracks, context);
    const programResponse: StationProgramResponse = {
      ...response,
      say,
      ttsText,
      plannedMinutes: response.plannedMinutes ?? 24,
      speechPlan: radioSession.buildDefaultSpeechPlan(playableTracks.length),
      lineup: response.lineup ?? fallbackLineup,
      reason: response.reason || "Manual trigger refreshed a complete radio queue.",
    };

    await applyProgramQueue("manual", programResponse, playableTracks, context, mode);
    await db.setStatus("playing");

    return {
      status: "success",
      djMessage: say,
      tracks: playableTracks,
      reason: programResponse.reason,
      ttsAudioPath,
      programTitle: response.title,
    };
  } catch (error) {
    await db.setStatus("error");
    throw error;
  }
}

export async function runPipeline(
  mode: "morning_brief" | "mood_pick" | "random_discover"
): Promise<PipelineResult> {
  if (mode === "morning_brief" || mode === "mood_pick") {
    return runManualRadioProgram(mode);
  }

  try {
    await ensureDataDirs();
    await db.setStatus("thinking");

    const context = await gatherMusicContext({
      weatherMode: mode,
      candidateLimit: mode === "random_discover" ? 20 : 12,
    });

    if (mode === "random_discover") {
      const scoutResponse = await runDiscoveryScout(context, "random_discover");
      await db.setStatus("speaking");

      const say = clampDjLine(
        scoutResponse.say,
        "我先从你的稳定口味旁边试一个新方向，同时保留几首稳的歌，让节目能继续播下去。",
      );
      const reason = scoutResponse.reason?.trim()
        || "Discovery Scout selected nearby directions and the backend verified playable audio.";
      const stableSeedCount = hasRecentPositiveFeedback(context) ? 4 : 3;
      const [ttsAudioPath, stableTracks, discoveries] = await Promise.all([
        speakDjText(
          scoutResponse.ttsText?.trim() || say,
          context.state.djProfile,
          "music_recommendation",
          reason,
        ),
        resolvePlayableTracksFromRequests(
          buildStableSeedRequests(context, stableSeedCount),
          STARTUP_FALLBACK_TRACKS,
          context.localCandidateMap,
          buildAvoidTracks(context),
          { minTracks: stableSeedCount, maxTracks: stableSeedCount },
        ),
        resolveDiscoveryDirections(
          scoutResponse,
          context,
          hasRecentPositiveFeedback(context) ? 2 : 1,
        ),
      ]);
      const playableTracks = mergeExplorationTracks(stableTracks, discoveries, {
        maxExploration: hasRecentPositiveFeedback(context) ? 2 : 1,
        firstInsertAfter: 1,
      });

      await applyProgramQueue("manual", {
        title: "Claudio Discovery",
        mood: "bounded discovery",
        plannedMinutes: 20,
        speechPlan: radioSession.buildDefaultSpeechPlan(playableTracks.length),
        say,
        ttsText: scoutResponse.ttsText?.trim() || say,
        lineup: [],
        reason,
      }, playableTracks, context, "random_discover");

      await db.setStatus("playing");

      return {
        status: "success",
        djMessage: say,
        tracks: playableTracks,
        reason,
        ttsAudioPath,
      };
    }

    throw new Error(`Unsupported pipeline mode: ${mode}`);
  } catch (error) {
    await db.setStatus("error");
    throw error;
  }
}
