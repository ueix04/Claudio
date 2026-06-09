import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./runtime.js";
import type { NeteaseSnapshot, NeteaseSnapshotPlaylist } from "./db.js";
import type { PlayRecord } from "./db.js";
import type { UserFeedbackRecord } from "./db.js";

export interface TasteProfileArtist {
  name: string;
  count: number;
  playlistCount: number;
  sampleTracks: string[];
}

export interface TasteProfileAlbum {
  name: string;
  artist: string;
  count: number;
}

export interface TasteProfileTrack {
  id: number;
  name: string;
  artist: string;
  album?: string;
  occurrences: number;
  playlistCount: number;
}

export interface TasteProfileKeyword {
  term: string;
  count: number;
}

export interface TasteProfilePlaylistFingerprint {
  id: number;
  name: string;
  trackCount: number;
  storedTrackCount: number;
  topArtists: string[];
  sampleTracks: string[];
}

export interface TasteProfileLanguageMix {
  chinese: number;
  latin: number;
  mixed: number;
  other: number;
}

export interface RuntimeTasteSignal {
  key: string;
  label: string;
  score: number;
  positiveCount: number;
  negativeCount: number;
  sampleTracks: string[];
}

export interface RuntimeTasteProfile {
  generatedAt: number;
  feedbackCount: number;
  effectiveFeedbackCount: number;
  likedArtists: RuntimeTasteSignal[];
  avoidedArtists: RuntimeTasteSignal[];
  languageSignals: RuntimeTasteSignal[];
  likedEnergy: RuntimeTasteSignal[];
  avoidedEnergy: RuntimeTasteSignal[];
  likedMoods: RuntimeTasteSignal[];
  avoidedMoods: RuntimeTasteSignal[];
  summary: string;
}

export interface TasteProfile {
  generatedAt: number;
  sourceSyncedAt: number;
  playlistCount: number;
  totalTrackCount: number;
  uniqueTrackCount: number;
  uniqueArtistCount: number;
  uniqueAlbumCount: number;
  languageMix: TasteProfileLanguageMix;
  topArtists: TasteProfileArtist[];
  topAlbums: TasteProfileAlbum[];
  topTracks: TasteProfileTrack[];
  titleKeywords: TasteProfileKeyword[];
  artistKeywords: TasteProfileKeyword[];
  playlistFingerprints: TasteProfilePlaylistFingerprint[];
  runtimeTaste?: RuntimeTasteProfile;
  summary: string;
}

export interface RecommendationCandidate {
  id: number;
  title: string;
  artist: string;
  album?: string;
  sourcePlaylists: string[];
  playlistCount: number;
  occurrences: number;
  score: number;
  reasons: string[];
}

const tasteProfilePath = path.join(dataDir, "taste-profile.json");
const STOPWORDS = new Set([
  "feat", "featuring", "with", "the", "and", "from", "for", "version",
  "edit", "demo", "live", "remix", "ost", "ep", "lp", "deluxe", "album",
]);

const LANGUAGE_LABELS: Record<keyof TasteProfileLanguageMix, string> = {
  chinese: "中文",
  latin: "英文/拉丁",
  mixed: "中英混合",
  other: "其他语种",
};

const ENERGY_DIRECTIONS = [
  {
    key: "low_energy",
    label: "低能量 / 安静",
    pattern: /安静|轻|慢|柔|睡|低能量|舒缓|民谣|钢琴|原声|quiet|soft|calm|slow|low\s*energy|ambient|acoustic|piano|lo-?fi/i,
  },
  {
    key: "mid_groove",
    label: "中速 / 律动",
    pattern: /律动|顺滑|中速|r&b|city\s*pop|soul|funk|groove|smooth|mid[-\s]?tempo/i,
  },
  {
    key: "high_energy",
    label: "高能量 / 提速",
    pattern: /燃|炸|快|冲|提速|高能量|摇滚|电子|舞曲|鼓|贝斯|节拍|high\s*energy|dance|edm|rock|punk|upbeat|beat|drum|bass/i,
  },
] as const;

const MOOD_DIRECTIONS = [
  {
    key: "warm",
    label: "温暖 / 治愈",
    pattern: /温暖|治愈|陪伴|舒服|松弛|warm|healing|cozy|comfort/i,
  },
  {
    key: "nostalgic",
    label: "怀旧 / 复古",
    pattern: /怀旧|复古|旧|经典|粤语老歌|nostalg|retro|classic|oldies|80s|90s/i,
  },
  {
    key: "melancholy",
    label: "伤感 / 低落",
    pattern: /伤感|难过|低落|失恋|孤独|emo|sad|blue|lonely|melanchol/i,
  },
  {
    key: "dreamy",
    label: "梦幻 / 氛围",
    pattern: /梦|迷幻|氛围|漂浮|shoegaze|dream|dreamy|ethereal|ambient|psychedelic/i,
  },
  {
    key: "bright",
    label: "明亮 / 轻快",
    pattern: /明亮|开心|轻快|清爽|夏天|happy|bright|sunny|summer|fresh/i,
  },
  {
    key: "dark",
    label: "冷感 / 暗色",
    pattern: /冷|暗|夜|黑|压抑|dark|cold|noir|night/i,
  },
] as const;

type RuntimeDirection = typeof ENERGY_DIRECTIONS[number] | typeof MOOD_DIRECTIONS[number];

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

function toDisplayPercent(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function classifyLanguage(text: string): keyof TasteProfileLanguageMix {
  const hasHan = /[\p{Script=Han}]/u.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  if (hasHan && hasLatin) return "mixed";
  if (hasHan) return "chinese";
  if (hasLatin) return "latin";
  return "other";
}

function extractTokens(text: string): string[] {
  const matches = text.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9][A-Za-z0-9&'+.-]{2,}/gu) ?? [];
  return matches
    .map(normalizeToken)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function topEntries<K>(map: Map<K, number>, limit: number): Array<[K, number]> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function buildPlaylistFingerprint(playlist: NeteaseSnapshotPlaylist): TasteProfilePlaylistFingerprint {
  const artistCounts = new Map<string, number>();
  for (const track of playlist.tracks) {
    artistCounts.set(track.artist, (artistCounts.get(track.artist) ?? 0) + 1);
  }

  return {
    id: playlist.id,
    name: playlist.name,
    trackCount: playlist.trackCount,
    storedTrackCount: playlist.tracks.length,
    topArtists: topEntries(artistCounts, 5).map(([artist]) => artist),
    sampleTracks: playlist.tracks.slice(0, 8).map((track) => `${track.name} - ${track.artist}`),
  };
}

function buildSummary(profile: TasteProfile): string {
  const total = profile.totalTrackCount || 1;
  const topArtists = profile.topArtists
    .slice(0, 10)
    .map((artist) => `${artist.name}(${artist.count})`)
    .join(", ");
  const topAlbums = profile.topAlbums
    .slice(0, 8)
    .map((album) => `${album.name} - ${album.artist}(${album.count})`)
    .join(", ");
  const topTracks = profile.topTracks
    .slice(0, 8)
    .map((track) => `${track.name} - ${track.artist}`)
    .join(", ");
  const titleKeywords = profile.titleKeywords
    .slice(0, 12)
    .map((keyword) => `${keyword.term}(${keyword.count})`)
    .join(", ");
  const artistKeywords = profile.artistKeywords
    .slice(0, 12)
    .map((keyword) => `${keyword.term}(${keyword.count})`)
    .join(", ");
  const playlistFingerprints = profile.playlistFingerprints
    .slice(0, 6)
    .map((fingerprint) => {
      const artists = fingerprint.topArtists.join(", ");
      const tracks = fingerprint.sampleTracks.slice(0, 4).join(", ");
      return `- ${fingerprint.name}：核心艺人 ${artists || "无"}；示例歌曲 ${tracks || "无"}`;
    })
    .join("\n");

  return `在线音乐口味索引（构建于 ${new Date(profile.generatedAt).toLocaleString("zh-CN")}，基于 ${profile.playlistCount} 个网易云歌单快照）：
- 总曲目数：${profile.totalTrackCount}
- 去重后曲目数：${profile.uniqueTrackCount}
- 去重后艺人数：${profile.uniqueArtistCount}
- 去重后专辑数：${profile.uniqueAlbumCount}
- 语言倾向：中文 ${toDisplayPercent(profile.languageMix.chinese, total)}，英文/拉丁 ${toDisplayPercent(profile.languageMix.latin, total)}，混合 ${toDisplayPercent(profile.languageMix.mixed, total)}，其他 ${toDisplayPercent(profile.languageMix.other, total)}
- 高频艺人：${topArtists || "无"}
- 高频专辑：${topAlbums || "无"}
- 高频代表曲目：${topTracks || "无"}
- 标题关键词：${titleKeywords || "无"}
- 艺人关键词：${artistKeywords || "无"}
- 歌单画像：
${playlistFingerprints || "- 无"}

推荐要求：
- 优先从上述核心艺人、相近艺人和相似氛围中挖掘，不要只看歌单名
- 优先推荐“熟悉体系里的新发现”，避免总是推最头部最显眼的曲目
- 当在线候选池里存在相似曲风、相似语言、相似情绪时，优先沿着这些线索扩展`;
}

export function buildTasteProfile(snapshot: NeteaseSnapshot): TasteProfile {
  const artistAggregates = new Map<string, { count: number; playlists: Set<number>; sampleTracks: string[] }>();
  const albumAggregates = new Map<string, { name: string; artist: string; count: number }>();
  const trackAggregates = new Map<number, { id: number; name: string; artist: string; album?: string; occurrences: number; playlists: Set<number> }>();
  const titleKeywordCounts = new Map<string, number>();
  const artistKeywordCounts = new Map<string, number>();
  const uniqueArtists = new Set<string>();
  const uniqueAlbums = new Set<string>();
  const languageMix: TasteProfileLanguageMix = { chinese: 0, latin: 0, mixed: 0, other: 0 };

  for (const playlist of snapshot.playlists) {
    for (const track of playlist.tracks) {
      const language = classifyLanguage(`${track.name} ${track.artist} ${track.album ?? ""}`);
      languageMix[language] += 1;

      uniqueArtists.add(track.artist);
      if (track.album) {
        uniqueAlbums.add(`${track.artist}::${track.album}`);
      }

      const artistAggregate = artistAggregates.get(track.artist) ?? {
        count: 0,
        playlists: new Set<number>(),
        sampleTracks: [],
      };
      artistAggregate.count += 1;
      artistAggregate.playlists.add(playlist.id);
      if (artistAggregate.sampleTracks.length < 5) {
        artistAggregate.sampleTracks.push(track.name);
      }
      artistAggregates.set(track.artist, artistAggregate);

      if (track.album) {
        const albumKey = `${track.artist}::${track.album}`;
        const albumAggregate = albumAggregates.get(albumKey) ?? {
          name: track.album,
          artist: track.artist,
          count: 0,
        };
        albumAggregate.count += 1;
        albumAggregates.set(albumKey, albumAggregate);
      }

      const trackAggregate = trackAggregates.get(track.id) ?? {
        id: track.id,
        name: track.name,
        artist: track.artist,
        album: track.album,
        occurrences: 0,
        playlists: new Set<number>(),
      };
      trackAggregate.occurrences += 1;
      trackAggregate.playlists.add(playlist.id);
      trackAggregates.set(track.id, trackAggregate);

      for (const token of extractTokens(track.name)) {
        titleKeywordCounts.set(token, (titleKeywordCounts.get(token) ?? 0) + 1);
      }
      for (const token of extractTokens(track.artist)) {
        artistKeywordCounts.set(token, (artistKeywordCounts.get(token) ?? 0) + 1);
      }
    }
  }

  const topArtists: TasteProfileArtist[] = [...artistAggregates.entries()]
    .map(([name, aggregate]) => ({
      name,
      count: aggregate.count,
      playlistCount: aggregate.playlists.size,
      sampleTracks: aggregate.sampleTracks,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const topAlbums: TasteProfileAlbum[] = [...albumAggregates.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const topTracks: TasteProfileTrack[] = [...trackAggregates.values()]
    .map((track) => ({
      id: track.id,
      name: track.name,
      artist: track.artist,
      album: track.album,
      occurrences: track.occurrences,
      playlistCount: track.playlists.size,
    }))
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 20);

  const titleKeywords: TasteProfileKeyword[] = topEntries(titleKeywordCounts, 30)
    .map(([term, count]) => ({ term, count }));
  const artistKeywords: TasteProfileKeyword[] = topEntries(artistKeywordCounts, 30)
    .map(([term, count]) => ({ term, count }));

  const profile: TasteProfile = {
    generatedAt: Date.now(),
    sourceSyncedAt: snapshot.syncedAt,
    playlistCount: snapshot.playlists.length,
    totalTrackCount: snapshot.playlists.reduce((sum, playlist) => sum + playlist.tracks.length, 0),
    uniqueTrackCount: trackAggregates.size,
    uniqueArtistCount: uniqueArtists.size,
    uniqueAlbumCount: uniqueAlbums.size,
    languageMix,
    topArtists,
    topAlbums,
    topTracks,
    titleKeywords,
    artistKeywords,
    playlistFingerprints: snapshot.playlists.map(buildPlaylistFingerprint),
    summary: "",
  };

  profile.summary = buildSummary(profile);
  return profile;
}

export async function writeTasteProfile(profile: TasteProfile): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tasteProfilePath, JSON.stringify(profile, null, 2), "utf-8");
}

export async function getTasteProfile(): Promise<TasteProfile | null> {
  try {
    const raw = await fs.readFile(tasteProfilePath, "utf-8");
    return normalizeTasteProfile(JSON.parse(raw) as TasteProfile);
  } catch {
    return null;
  }
}

function normalizeTasteProfile(profile: TasteProfile): TasteProfile {
  return {
    ...profile,
    summary: profile.summary
      .replace("本地音乐口味索引", "在线音乐口味索引")
      .replace("当本地曲库里存在相似曲风、相似语言、相似情绪时", "当在线候选池里存在相似曲风、相似语言、相似情绪时"),
  };
}

export async function rebuildTasteProfileFromSnapshot(snapshot: NeteaseSnapshot): Promise<TasteProfile> {
  const profile = buildTasteProfile(snapshot);
  await writeTasteProfile(profile);
  return profile;
}

export async function summarizeTasteProfile(): Promise<string> {
  const profile = await getTasteProfile();
  return profile?.summary ?? "";
}

function dominantLanguage(profile: TasteProfile): keyof TasteProfileLanguageMix {
  return (["latin", "mixed", "chinese", "other"] as Array<keyof TasteProfileLanguageMix>)
    .sort((a, b) => profile.languageMix[b] - profile.languageMix[a])[0] ?? "latin";
}

function buildRecentTrackKey(record: PlayRecord): string {
  return `${record.title.toLowerCase()}::${record.artist.toLowerCase()}`;
}

function buildFeedbackTrackKey(record: Pick<UserFeedbackRecord, "title" | "artist">): string {
  return `${record.title.toLowerCase()}::${record.artist.toLowerCase()}`;
}

function getFeedbackSignalWeight(type: UserFeedbackRecord["type"]): number {
  switch (type) {
    case "more_like_this":
      return 1;
    case "favorite_track":
      return 1.3;
    case "complete_track":
      return 0.55;
    case "ask_about_track":
    case "replay_dj":
      return 0.35;
    case "less_like_this":
      return -1;
    case "dislike_track":
      return -1.35;
    case "skip_track":
      return -0.8;
    default:
      return 0;
  }
}

function getFeedbackTimeDecay(createdAt: number, now = Date.now()): number {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return 0.65;
  if (createdAt < 946_684_800_000) return 1;
  const ageDays = Math.max(0, (now - createdAt) / 86_400_000);
  if (ageDays <= 1) return 1;
  if (ageDays <= 3) return 0.75;
  if (ageDays <= 7) return 0.45;
  if (ageDays <= 14) return 0.2;
  return 0.05;
}

function getRuntimeFeedbackWeight(feedback: UserFeedbackRecord, now = Date.now()): number {
  return getFeedbackSignalWeight(feedback.type) * getFeedbackTimeDecay(feedback.createdAt, now);
}

function getFeedbackSignalText(feedback: UserFeedbackRecord): string {
  return [feedback.title, feedback.artist, feedback.note].filter(Boolean).join(" ");
}

function formatFeedbackTrack(feedback: Pick<UserFeedbackRecord, "title" | "artist">): string {
  return `${feedback.title} - ${feedback.artist}`;
}

function roundSignalScore(score: number): number {
  return Math.round(score * 10) / 10;
}

function createSignalMapEntry(key: string, label: string) {
  return {
    key,
    label,
    score: 0,
    positiveCount: 0,
    negativeCount: 0,
    sampleTracks: [] as string[],
  };
}

function addRuntimeSignal(
  map: Map<string, RuntimeTasteSignal>,
  key: string,
  label: string,
  weight: number,
  sampleTrack: string,
): void {
  if (!key || weight === 0) return;
  const existing = map.get(key) ?? createSignalMapEntry(key, label);
  existing.score += weight;
  if (weight > 0) {
    existing.positiveCount += 1;
  } else {
    existing.negativeCount += 1;
  }
  if (sampleTrack && existing.sampleTracks.length < 4 && !existing.sampleTracks.includes(sampleTrack)) {
    existing.sampleTracks.push(sampleTrack);
  }
  map.set(key, existing);
}

function matchDirections(text: string, directions: readonly RuntimeDirection[]): RuntimeDirection[] {
  return directions.filter((direction) => direction.pattern.test(text));
}

function getPositiveSignals(map: Map<string, RuntimeTasteSignal>, limit: number): RuntimeTasteSignal[] {
  return [...map.values()]
    .filter((signal) => signal.score > 0)
    .map((signal) => ({ ...signal, score: roundSignalScore(signal.score) }))
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function getNegativeSignals(map: Map<string, RuntimeTasteSignal>, limit: number): RuntimeTasteSignal[] {
  return [...map.values()]
    .filter((signal) => signal.score < 0)
    .map((signal) => ({ ...signal, score: roundSignalScore(signal.score) }))
    .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function getNetSignals(map: Map<string, RuntimeTasteSignal>, limit: number): RuntimeTasteSignal[] {
  return [...map.values()]
    .filter((signal) => Math.abs(signal.score) >= 0.1)
    .map((signal) => ({ ...signal, score: roundSignalScore(signal.score) }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function formatRuntimeSignalList(signals: RuntimeTasteSignal[], emptyLabel = "无"): string {
  if (signals.length === 0) return emptyLabel;
  return signals
    .map((signal) => `${signal.label}(${signal.score > 0 ? "+" : ""}${signal.score})`)
    .join(", ");
}

function buildRuntimeTasteSummary(profile: Omit<RuntimeTasteProfile, "summary">): string {
  const likedLanguages = profile.languageSignals.filter((signal) => signal.score > 0);
  const avoidedLanguages = profile.languageSignals.filter((signal) => signal.score < 0);

  return `运行期口味画像（来自最近 ${profile.feedbackCount} 条反馈，已按时间衰减）：
- 正向艺人：${formatRuntimeSignalList(profile.likedArtists)}
- 暂时少放：${formatRuntimeSignalList(profile.avoidedArtists)}
- 正向语种：${formatRuntimeSignalList(likedLanguages)}
- 回避语种：${formatRuntimeSignalList(avoidedLanguages)}
- 正向能量：${formatRuntimeSignalList(profile.likedEnergy)}
- 回避能量：${formatRuntimeSignalList(profile.avoidedEnergy)}
- 正向情绪：${formatRuntimeSignalList(profile.likedMoods)}
- 回避情绪：${formatRuntimeSignalList(profile.avoidedMoods)}

使用规则：
- 这是今晚的短期偏好，不覆盖长期网易云歌单画像
- 正反馈可以扩大相邻探索，负反馈先收回到稳定区域
- 如果信号很少，仍以长期口味和可播放性为主`;
}

export function buildRuntimeTasteProfile(
  userFeedback: UserFeedbackRecord[],
  now = Date.now(),
): RuntimeTasteProfile {
  const artistSignals = new Map<string, RuntimeTasteSignal>();
  const languageSignals = new Map<string, RuntimeTasteSignal>();
  const energySignals = new Map<string, RuntimeTasteSignal>();
  const moodSignals = new Map<string, RuntimeTasteSignal>();
  let effectiveFeedbackCount = 0;

  for (const feedback of userFeedback.slice(0, 100)) {
    const weight = getRuntimeFeedbackWeight(feedback, now);
    if (Math.abs(weight) < 0.05) continue;
    effectiveFeedbackCount += 1;

    const sampleTrack = formatFeedbackTrack(feedback);
    const artist = feedback.artist.trim();
    if (artist) {
      addRuntimeSignal(artistSignals, artist.toLowerCase(), artist, weight, sampleTrack);
    }

    const language = classifyLanguage(`${feedback.title} ${feedback.artist}`);
    addRuntimeSignal(languageSignals, language, LANGUAGE_LABELS[language], weight, sampleTrack);

    const signalText = getFeedbackSignalText(feedback);
    for (const direction of matchDirections(signalText, ENERGY_DIRECTIONS)) {
      addRuntimeSignal(energySignals, direction.key, direction.label, weight, sampleTrack);
    }
    for (const direction of matchDirections(signalText, MOOD_DIRECTIONS)) {
      addRuntimeSignal(moodSignals, direction.key, direction.label, weight, sampleTrack);
    }
  }

  const profileWithoutSummary = {
    generatedAt: now,
    feedbackCount: userFeedback.length,
    effectiveFeedbackCount,
    likedArtists: getPositiveSignals(artistSignals, 8),
    avoidedArtists: getNegativeSignals(artistSignals, 8),
    languageSignals: getNetSignals(languageSignals, 4),
    likedEnergy: getPositiveSignals(energySignals, 5),
    avoidedEnergy: getNegativeSignals(energySignals, 5),
    likedMoods: getPositiveSignals(moodSignals, 6),
    avoidedMoods: getNegativeSignals(moodSignals, 6),
  };

  return {
    ...profileWithoutSummary,
    summary: buildRuntimeTasteSummary(profileWithoutSummary),
  };
}

export function summarizeRuntimeTasteProfile(userFeedback: UserFeedbackRecord[], now = Date.now()): string {
  if (userFeedback.length === 0) return "";
  const runtimeProfile = buildRuntimeTasteProfile(userFeedback, now);
  return runtimeProfile.effectiveFeedbackCount > 0 ? runtimeProfile.summary : "";
}

function getRuntimeSignalWeight(signals: RuntimeTasteSignal[], key: string): number {
  return signals.find((signal) => signal.key === key)?.score ?? 0;
}

function getDirectionRuntimeWeight(
  text: string,
  directions: readonly RuntimeDirection[],
  positiveSignals: RuntimeTasteSignal[],
  negativeSignals: RuntimeTasteSignal[],
): number {
  return matchDirections(text, directions).reduce((total, direction) => (
    total
      + getRuntimeSignalWeight(positiveSignals, direction.key)
      + getRuntimeSignalWeight(negativeSignals, direction.key)
  ), 0);
}

export function buildRecommendationCandidates(
  snapshot: NeteaseSnapshot,
  profile: TasteProfile,
  playHistory: PlayRecord[],
  limit = 20,
  userFeedback: UserFeedbackRecord[] = [],
): RecommendationCandidate[] {
  const recentTrackKeys = new Set(playHistory.slice(0, 50).map(buildRecentTrackKey));
  const dislikedTrackKeys = new Set(
    userFeedback
      .filter((feedback) => feedback.type === "dislike_track" && getFeedbackTimeDecay(feedback.createdAt) >= 0.2)
      .slice(0, 50)
      .map(buildFeedbackTrackKey),
  );
  const artistFeedbackWeights = new Map<string, number>();
  userFeedback.slice(0, 50).forEach((feedback, index) => {
    const artist = feedback.artist.trim();
    if (!artist) return;
    const recencyWeight = Math.max(1, 10 - Math.floor(index / 5));
    const signalWeight = getFeedbackSignalWeight(feedback.type);
    if (signalWeight === 0) return;
    const timeDecay = getFeedbackTimeDecay(feedback.createdAt);
    artistFeedbackWeights.set(
      artist,
      (artistFeedbackWeights.get(artist) ?? 0) + signalWeight * recencyWeight * timeDecay,
    );
  });
  const runtimeTaste = buildRuntimeTasteProfile(userFeedback);
  const topArtistWeights = new Map(profile.topArtists.map((artist, index) => [artist.name, Math.max(1, 12 - index)]));
  const topAlbumWeights = new Map(profile.topAlbums.map((album, index) => [`${album.artist}::${album.name}`, Math.max(1, 8 - index)]));
  const dominant = dominantLanguage(profile);

  const aggregates = new Map<number, RecommendationCandidate>();
  for (const playlist of snapshot.playlists) {
    for (const track of playlist.tracks) {
      const trackKey = `${track.name.toLowerCase()}::${track.artist.toLowerCase()}`;
      if (recentTrackKeys.has(trackKey) || dislikedTrackKeys.has(trackKey)) {
        continue;
      }

      const existing = aggregates.get(track.id) ?? {
        id: track.id,
        title: track.name,
        artist: track.artist,
        album: track.album,
        sourcePlaylists: [],
        playlistCount: 0,
        occurrences: 0,
        score: 0,
        reasons: [],
      };

      existing.occurrences += 1;
      if (!existing.sourcePlaylists.includes(playlist.name)) {
        existing.sourcePlaylists.push(playlist.name);
      }
      existing.playlistCount = existing.sourcePlaylists.length;
      existing.score += 1;

      const artistWeight = topArtistWeights.get(track.artist) ?? 0;
      if (artistWeight > 0) {
        existing.score += artistWeight;
        if (!existing.reasons.includes("core-artist")) {
          existing.reasons.push("core-artist");
        }
      }

      const feedbackWeight = artistFeedbackWeights.get(track.artist) ?? 0;
      if (feedbackWeight > 0) {
        existing.score += feedbackWeight;
        if (!existing.reasons.includes("positive-feedback")) {
          existing.reasons.push("positive-feedback");
        }
      } else if (feedbackWeight < 0) {
        existing.score += feedbackWeight;
        if (!existing.reasons.includes("reduced-by-feedback")) {
          existing.reasons.push("reduced-by-feedback");
        }
      }

      const albumWeight = topAlbumWeights.get(`${track.artist}::${track.album ?? ""}`) ?? 0;
      if (albumWeight > 0) {
        existing.score += albumWeight;
        if (!existing.reasons.includes("core-album")) {
          existing.reasons.push("core-album");
        }
      }

      if (existing.playlistCount > 1) {
        existing.score += existing.playlistCount * 2;
        if (!existing.reasons.includes("cross-playlist")) {
          existing.reasons.push("cross-playlist");
        }
      }

      const language = classifyLanguage(`${track.name} ${track.artist} ${track.album ?? ""}`);
      if (language === dominant) {
        existing.score += 2;
        if (!existing.reasons.includes("language-match")) {
          existing.reasons.push("language-match");
        }
      }
      const runtimeLanguageWeight = getRuntimeSignalWeight(runtimeTaste.languageSignals, language);
      if (runtimeLanguageWeight !== 0) {
        existing.score += runtimeLanguageWeight;
        const reason = runtimeLanguageWeight > 0 ? "runtime-language-match" : "runtime-language-reduced";
        if (!existing.reasons.includes(reason)) {
          existing.reasons.push(reason);
        }
      }

      const runtimeDirectionText = `${track.name} ${track.artist} ${track.album ?? ""}`;
      const runtimeEnergyWeight = getDirectionRuntimeWeight(
        runtimeDirectionText,
        ENERGY_DIRECTIONS,
        runtimeTaste.likedEnergy,
        runtimeTaste.avoidedEnergy,
      );
      if (runtimeEnergyWeight !== 0) {
        existing.score += runtimeEnergyWeight;
        const reason = runtimeEnergyWeight > 0 ? "runtime-energy-match" : "runtime-energy-reduced";
        if (!existing.reasons.includes(reason)) {
          existing.reasons.push(reason);
        }
      }

      const runtimeMoodWeight = getDirectionRuntimeWeight(
        runtimeDirectionText,
        MOOD_DIRECTIONS,
        runtimeTaste.likedMoods,
        runtimeTaste.avoidedMoods,
      );
      if (runtimeMoodWeight !== 0) {
        existing.score += runtimeMoodWeight;
        const reason = runtimeMoodWeight > 0 ? "runtime-mood-match" : "runtime-mood-reduced";
        if (!existing.reasons.includes(reason)) {
          existing.reasons.push(reason);
        }
      }

      aggregates.set(track.id, existing);
    }
  }

  const sorted = [...aggregates.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  const perArtistCap = new Map<string, number>();
  const candidates: RecommendationCandidate[] = [];
  for (const candidate of sorted) {
    const artistCount = perArtistCap.get(candidate.artist) ?? 0;
    if (artistCount >= 2) {
      continue;
    }
    perArtistCap.set(candidate.artist, artistCount + 1);
    candidates.push(candidate);
    if (candidates.length >= limit) {
      break;
    }
  }

  return candidates;
}

export function summarizeRecommendationCandidates(candidates: RecommendationCandidate[]): string {
  if (candidates.length === 0) return "";

  return `在线候选池（请优先从中选择，避免脱离用户现有口味体系）：\n${candidates
    .map((candidate, index) => {
      const code = `C${String(index + 1).padStart(2, "0")}`;
      const album = candidate.album ? ` | 专辑：${candidate.album}` : "";
      const playlists = candidate.sourcePlaylists.slice(0, 3).join(" / ");
      const reasons = candidate.reasons.join(", ");
      return `- ${code} | id=${candidate.id} | ${candidate.title} - ${candidate.artist}${album} | 来源歌单：${playlists} | 命中线索：${reasons || "local-match"}`;
    })
    .join("\n")}\n\n返回 play 字段时，如果选择了候选池中的歌曲，请带上对应的 id。`;
}
