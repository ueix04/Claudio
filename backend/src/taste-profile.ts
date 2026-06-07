import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./runtime.js";
import type { NeteaseSnapshot, NeteaseSnapshotPlaylist } from "./db.js";
import type { PlayRecord } from "./db.js";

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

  return `本地音乐口味索引（构建于 ${new Date(profile.generatedAt).toLocaleString("zh-CN")}，基于 ${profile.playlistCount} 个网易云歌单快照）：
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
- 当本地曲库里存在相似曲风、相似语言、相似情绪时，优先沿着这些线索扩展`;
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
    return JSON.parse(raw) as TasteProfile;
  } catch {
    return null;
  }
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

export function buildRecommendationCandidates(
  snapshot: NeteaseSnapshot,
  profile: TasteProfile,
  playHistory: PlayRecord[],
  limit = 20,
): RecommendationCandidate[] {
  const recentTrackKeys = new Set(playHistory.slice(0, 50).map(buildRecentTrackKey));
  const topArtistWeights = new Map(profile.topArtists.map((artist, index) => [artist.name, Math.max(1, 12 - index)]));
  const topAlbumWeights = new Map(profile.topAlbums.map((album, index) => [`${album.artist}::${album.name}`, Math.max(1, 8 - index)]));
  const dominant = dominantLanguage(profile);

  const aggregates = new Map<number, RecommendationCandidate>();
  for (const playlist of snapshot.playlists) {
    for (const track of playlist.tracks) {
      const trackKey = `${track.name.toLowerCase()}::${track.artist.toLowerCase()}`;
      if (recentTrackKeys.has(trackKey)) {
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

  return `本地候选曲库（请优先从中选择，避免脱离用户现有口味体系）：\n${candidates
    .map((candidate, index) => {
      const code = `C${String(index + 1).padStart(2, "0")}`;
      const album = candidate.album ? ` | 专辑：${candidate.album}` : "";
      const playlists = candidate.sourcePlaylists.slice(0, 3).join(" / ");
      const reasons = candidate.reasons.join(", ");
      return `- ${code} | id=${candidate.id} | ${candidate.title} - ${candidate.artist}${album} | 来源歌单：${playlists} | 命中线索：${reasons || "local-match"}`;
    })
    .join("\n")}\n\n返回 play 字段时，如果选择了候选曲库中的歌曲，请带上对应的 id。`;
}
