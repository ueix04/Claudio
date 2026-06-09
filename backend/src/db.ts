import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { dataDir } from "./runtime.js";

export type AppStatus = "idle" | "thinking" | "speaking" | "playing" | "error";

export interface Track {
  id: string;
  name: string;
  artist: string;
  url: string;
  source?: string;
  sourceTrackId?: string;
  urlSource?: string;
  album?: string;
  duration?: number;
  picUrl?: string;
  urlExpiresAt?: number;
  urlRefreshedAt?: number;
  playbackHealth?: "ready" | "refreshing" | "fallback" | "failed" | "expired";
  lastPlaybackIssue?: {
    code: string;
    message: string;
    at: number;
  };
  lastResolveError?: {
    code: string;
    message: string;
    at: number;
  };
}

export interface ChatMessage {
  role: "user" | "dj";
  text: string;
  timestamp: number;
}

export interface DjProfile {
  voice: string;
  style: string;
  name: string;
}

export interface PlaylistItem {
  name: string;
  artist: string;
  album?: string;
}

export interface Playlist {
  id: string;
  name: string;
  tracks: PlaylistItem[];
  createdAt: number;
}

export interface PlayRecord {
  title: string;
  artist: string;
  playedAt: number;
}

export type UserFeedbackType =
  | "more_like_this"
  | "less_like_this"
  | "dislike_track"
  | "favorite_track"
  | "complete_track"
  | "skip_track"
  | "replay_dj"
  | "ask_about_track";

export interface UserFeedbackRecord {
  id: string;
  type: UserFeedbackType;
  trackId?: string;
  title: string;
  artist: string;
  source?: string;
  sourceTrackId?: string;
  urlSource?: string;
  programSessionId?: string;
  queueIndex?: number;
  note?: string;
  createdAt: number;
}

export type DiscoveryRisk = "adjacent" | "small_adventure";
export type DiscoveryCandidateHealth = "ready" | "failed";

export interface DiscoveryCandidateRecord {
  id: string;
  query: string;
  direction: string;
  title: string;
  artist: string;
  reason: string;
  risk: DiscoveryRisk;
  source?: string;
  sourceTrackId?: string;
  urlSource?: string;
  health: DiscoveryCandidateHealth;
  createdAt: number;
}

export interface ListenCheckEvidence {
  playbackIssueCount: number;
  fallbackCount: number;
  discoveryCount: number;
  feedbackCount: number;
  djLineCount: number;
  playedTrackCount: number;
  clientSignalSampleCount?: number;
  clientLowSignalSampleCount?: number;
  clientSilentMs?: number;
  clientMaxSilentRunMs?: number;
  discoveryTracks?: Array<{
    title: string;
    artist: string;
    risk?: DiscoveryRisk;
  }>;
  recentIssues?: Array<{
    code: string;
    message: string;
    trackTitle?: string;
    at?: number;
  }>;
}

export interface ListenCheckRecord {
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  playbackMs?: number;
  playbackSegments?: Array<{
    trackId: string;
    title: string;
    artist: string;
    playedMs: number;
  }>;
  checks: {
    program: boolean;
    dj: boolean;
    context: boolean;
  };
  note?: string;
  needsFollowUp?: boolean;
  programAudit?: {
    ok: boolean;
    plannedMinutes: number;
    trackCount: number;
    speechSlotCount: number;
    issueCount: number;
  };
  programContinuity?: {
    ok: boolean;
    startedSessionId?: string;
    completedSessionId?: string;
    startedGeneratedAt?: number;
    completedGeneratedAt?: number;
  };
  listenEvidence?: ListenCheckEvidence;
  programSnapshot?: {
    sessionId?: string;
    title?: string;
    mood?: string;
    source?: RadioProgram["source"];
    generatedAt?: number;
    currentQueueIndex: number;
    tracks: Array<{
      id: string;
      name: string;
      artist: string;
      source?: string;
      urlSource?: string;
      duration?: number;
    }>;
  };
  recordedAt: number;
}

export interface RadioSpeechSlot {
  beforeTrackIndex: number;
  type: "intro" | "short_say" | "bumper" | "closing";
  note?: string;
}

export interface RadioProgram {
  source: "startup" | "manual" | "chat_switch";
  sessionId?: string;
  title?: string;
  mood?: string;
  summary?: string;
  plannedMinutes?: number;
  speechPlan?: RadioSpeechSlot[];
  preparedUntilIndex?: number;
  generatedAt: number;
  weatherContext?: string;
  userRequest?: string;
}

export interface NeteaseSnapshotAccount {
  userId: number;
  nickname: string;
  avatarUrl: string;
}

export interface NeteaseSnapshotPlaylist {
  tracks: Array<{
    id: number;
    name: string;
    artist: string;
    album?: string;
  }>;
  id: number;
  name: string;
  trackCount: number;
  playCount: number;
  coverImgUrl: string;
  creator: {
    nickname: string;
    userId: number;
  };
}

export interface NeteaseSnapshot {
  account: NeteaseSnapshotAccount;
  playlists: NeteaseSnapshotPlaylist[];
  syncedAt: number;
}

export interface AppState {
  status: AppStatus;
  currentTrack: Track | null;
  radioQueue: Track[];
  currentQueueIndex: number;
  currentProgram: RadioProgram | null;
  chatHistory: ChatMessage[];
  playHistory: PlayRecord[];
  userFeedback: UserFeedbackRecord[];
  discoveryCandidates: DiscoveryCandidateRecord[];
  listenChecks: ListenCheckRecord[];
  djProfile: DjProfile;
  playlists: Playlist[];
  neteaseSnapshot: NeteaseSnapshot | null;
  favorites: string[];
  lastInteraction: number;
}

const defaultState = (): AppState => ({
  status: "idle",
  currentTrack: null,
  radioQueue: [],
  currentQueueIndex: 0,
  currentProgram: null,
  chatHistory: [],
  playHistory: [],
  userFeedback: [],
  discoveryCandidates: [],
  listenChecks: [],
  djProfile: {
    voice: "冰糖",
    style: "情感电台",
    name: "Claudio",
  },
  playlists: [],
  neteaseSnapshot: null,
  favorites: [],
  lastInteraction: Date.now(),
});

const stateFilePath = resolve(dataDir, "state.json");

let db: Low<AppState> | null = null;

function ensureStateFile(): void {
  const directory = dirname(stateFilePath);
  mkdirSync(directory, { recursive: true });

  if (!existsSync(stateFilePath)) {
    writeFileSync(stateFilePath, JSON.stringify(defaultState(), null, 2), "utf-8");
  }
}

function loadInitialState(): AppState {
  try {
    const raw = readFileSync(stateFilePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      ...defaultState(),
      ...parsed,
      djProfile: {
        ...defaultState().djProfile,
        ...(parsed.djProfile ?? {}),
      },
      radioQueue: Array.isArray(parsed.radioQueue)
        ? parsed.radioQueue
        : defaultState().radioQueue,
      currentQueueIndex: typeof parsed.currentQueueIndex === "number"
        ? parsed.currentQueueIndex
        : defaultState().currentQueueIndex,
      currentProgram: parsed.currentProgram ?? defaultState().currentProgram,
      neteaseSnapshot: parsed.neteaseSnapshot ?? defaultState().neteaseSnapshot,
      chatHistory: Array.isArray(parsed.chatHistory)
        ? parsed.chatHistory
        : defaultState().chatHistory,
      listenChecks: Array.isArray(parsed.listenChecks)
        ? parsed.listenChecks
        : defaultState().listenChecks,
      userFeedback: Array.isArray(parsed.userFeedback)
        ? parsed.userFeedback
        : defaultState().userFeedback,
      discoveryCandidates: Array.isArray(parsed.discoveryCandidates)
        ? parsed.discoveryCandidates
        : defaultState().discoveryCandidates,
    };
  } catch {
    return defaultState();
  }
}

function createDb(): Low<AppState> {
  ensureStateFile();
  const adapter = new JSONFile<AppState>(stateFilePath);
  const instance = new Low<AppState>(adapter, defaultState());
  instance.data = loadInitialState();
  return instance;
}

function getMutableState(): AppState {
  const current = getDb().data;
  if (!current) {
    const initial = defaultState();
    getDb().data = initial;
    return initial;
  }
  return current;
}

export function getDb(): Low<AppState> {
  if (!db) {
    db = createDb();
  }

  return db;
}

export async function updateState(patch: Partial<AppState>): Promise<AppState> {
  const current = getMutableState();
  const next: AppState = {
    ...current,
    ...patch,
    djProfile: patch.djProfile
      ? { ...current.djProfile, ...patch.djProfile }
      : current.djProfile,
    chatHistory: patch.chatHistory ?? current.chatHistory,
  };

  getDb().data = next;
  await getDb().write();
  return next;
}

export async function getState(): Promise<AppState> {
  const state = getMutableState();
  if (!existsSync(stateFilePath)) {
    await getDb().write();
  }
  return state;
}

export async function addChatMessage(msg: Omit<ChatMessage, "timestamp"> & { timestamp?: number }): Promise<AppState> {
  const current = getMutableState();
  const next: AppState = {
    ...current,
    chatHistory: [
      ...current.chatHistory,
      {
        role: msg.role,
        text: msg.text,
        timestamp: msg.timestamp ?? Date.now(),
      },
    ],
    lastInteraction: Date.now(),
  };

  getDb().data = next;
  await getDb().write();
  return next;
}

export async function setStatus(status: AppStatus): Promise<AppState> {
  return updateState({ status, lastInteraction: Date.now() });
}

export async function setCurrentTrack(track: Track | null): Promise<AppState> {
  return updateState({ currentTrack: track, lastInteraction: Date.now() });
}

export async function setRadioQueue(
  queue: Track[],
  options?: {
    currentIndex?: number;
    program?: RadioProgram | null;
  },
): Promise<AppState> {
  const normalizedQueue = queue.map((track) => ({
    id: track.id,
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
    playbackHealth: track.playbackHealth,
    lastPlaybackIssue: track.lastPlaybackIssue,
    lastResolveError: track.lastResolveError,
  }));
  const requestedIndex = options?.currentIndex ?? 0;
  const boundedIndex = normalizedQueue.length === 0
    ? 0
    : Math.min(Math.max(requestedIndex, 0), normalizedQueue.length - 1);

  return updateState({
    radioQueue: normalizedQueue,
    currentQueueIndex: boundedIndex,
    currentTrack: normalizedQueue[boundedIndex] ?? null,
    currentProgram: options?.program ?? null,
    lastInteraction: Date.now(),
  });
}

export async function advanceRadioQueue(step = 1): Promise<AppState | null> {
  const current = getMutableState();
  if (current.radioQueue.length === 0) {
    return null;
  }

  const currentIndex = Math.min(
    Math.max(current.currentQueueIndex, 0),
    Math.max(current.radioQueue.length - 1, 0),
  );
  const nextIndex = (currentIndex + step + current.radioQueue.length) % current.radioQueue.length;

  return updateState({
    currentQueueIndex: nextIndex,
    currentTrack: current.radioQueue[nextIndex] ?? null,
    lastInteraction: Date.now(),
  });
}

export async function getRadioQueue(): Promise<Track[]> {
  return getMutableState().radioQueue;
}

export async function selectRadioQueueTrack(trackId: string): Promise<AppState | null> {
  const current = getMutableState();
  if (current.radioQueue.length === 0) {
    return null;
  }

  const nextIndex = current.radioQueue.findIndex((track) => track.id === trackId || track.url === trackId);
  if (nextIndex === -1) {
    return null;
  }

  return updateState({
    currentQueueIndex: nextIndex,
    currentTrack: current.radioQueue[nextIndex] ?? null,
    lastInteraction: Date.now(),
  });
}

export async function addPlaylist(name: string, tracks: PlaylistItem[]): Promise<Playlist> {
  const playlist: Playlist = {
    id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    tracks,
    createdAt: Date.now(),
  };

  const current = getMutableState();
  const next: AppState = {
    ...current,
    playlists: [...current.playlists, playlist],
    lastInteraction: Date.now(),
  };

  getDb().data = next;
  await getDb().write();
  return playlist;
}

export async function getPlaylists(): Promise<Playlist[]> {
  return getMutableState().playlists;
}

export async function removePlaylist(id: string): Promise<boolean> {
  const current = getMutableState();
  const idx = current.playlists.findIndex((p) => p.id === id);
  if (idx === -1) return false;

  const next: AppState = {
    ...current,
    playlists: current.playlists.filter((p) => p.id !== id),
    lastInteraction: Date.now(),
  };

  getDb().data = next;
  await getDb().write();
  return true;
}

export function summarizePlaylists(): string {
  const playlists = getMutableState().playlists;
  if (playlists.length === 0) return "";

  return playlists
    .map((pl) => {
      const trackList = pl.tracks
        .slice(0, 10)
        .map((t) => `${t.name} - ${t.artist}`)
        .join(", ");
      const more = pl.tracks.length > 10 ? ` 等共 ${pl.tracks.length} 首` : "";
      return `【${pl.name}】: ${trackList}${more}`;
    })
    .join("\n");
}

export async function getNeteaseSnapshot(): Promise<NeteaseSnapshot | null> {
  return getMutableState().neteaseSnapshot;
}

export async function setNeteaseSnapshot(snapshot: NeteaseSnapshot): Promise<AppState> {
  return updateState({
    neteaseSnapshot: snapshot,
    lastInteraction: Date.now(),
  });
}

export function summarizeNeteaseSnapshot(limit = 5): string {
  const snapshot = getMutableState().neteaseSnapshot;
  if (!snapshot || snapshot.playlists.length === 0) return "";

  const topPlaylists = [...snapshot.playlists]
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, limit);

  return `你的网易云音乐歌单快照（同步于 ${new Date(snapshot.syncedAt).toLocaleString("zh-CN")}，共 ${snapshot.playlists.length} 个，以下按播放量排序前 ${topPlaylists.length}）：\n${topPlaylists
    .map((pl) => {
      const sampleTracks = pl.tracks
        .slice(0, 10)
        .map((track) => `${track.name} - ${track.artist}`)
        .join(", ");
      const trackSuffix = sampleTracks
        ? `；示例歌曲：${sampleTracks}${pl.tracks.length > 10 ? " 等" : ""}`
        : "";
      return `- ${pl.name}（${pl.trackCount} 首，播放 ${pl.playCount} 次）${trackSuffix}`;
    })
    .join("\n")}\n\n请根据这些歌单推测用户的音乐口味（年代、风格、语种、情绪），在此基础上做推荐。`;
}

export async function getFavorites(): Promise<string[]> {
  return getMutableState().favorites;
}

export async function addFavorite(trackId: string): Promise<AppState> {
  const current = getMutableState();
  if (current.favorites.includes(trackId)) return current;
  return updateState({
    favorites: [...current.favorites, trackId],
    lastInteraction: Date.now(),
  });
}

export async function removeFavorite(trackId: string): Promise<AppState> {
  const current = getMutableState();
  return updateState({
    favorites: current.favorites.filter((id) => id !== trackId),
    lastInteraction: Date.now(),
  });
}

export async function toggleFavorite(trackId: string): Promise<{ favorited: boolean }> {
  const current = getMutableState();
  if (current.favorites.includes(trackId)) {
    await removeFavorite(trackId);
    return { favorited: false };
  }
  await addFavorite(trackId);
  return { favorited: true };
}

export async function recordPlay(title: string, artist: string): Promise<AppState> {
  const current = getMutableState();
  const record: PlayRecord = { title, artist, playedAt: Date.now() };
  const history = [record, ...current.playHistory];
  return updateState({ playHistory: history, lastInteraction: Date.now() });
}

export async function getPlayHistory(limit = 20): Promise<PlayRecord[]> {
  return getMutableState().playHistory.slice(0, limit);
}

export async function addUserFeedback(
  feedback: Omit<UserFeedbackRecord, "id" | "createdAt">,
): Promise<UserFeedbackRecord> {
  const record: UserFeedbackRecord = {
    ...feedback,
    id: `feedback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  };
  const current = getMutableState();
  const userFeedback = [record, ...current.userFeedback].slice(0, 200);
  await updateState({ userFeedback, lastInteraction: Date.now() });
  return record;
}

export async function getUserFeedback(limit = 50): Promise<UserFeedbackRecord[]> {
  return getMutableState().userFeedback.slice(0, limit);
}

export function summarizeUserFeedback(limit = 20): string {
  const feedback = getMutableState().userFeedback.slice(0, limit);
  if (feedback.length === 0) return "";

  const labels: Record<UserFeedbackType, string> = {
    more_like_this: "多来点这种",
    less_like_this: "少放这种",
    dislike_track: "不喜欢这首",
    favorite_track: "收藏了这首",
    complete_track: "听完了这首",
    skip_track: "跳过了这首",
    replay_dj: "重播了 DJ 回复",
    ask_about_track: "追问了这首",
  };

  return `最近用户音乐反馈：\n${feedback
    .map((item) => {
      const track = `${item.title} - ${item.artist}`;
      const note = item.note ? `；备注：${item.note}` : "";
      return `- ${labels[item.type]}：${track}${note}`;
    })
    .join("\n")}`;
}

export async function addDiscoveryCandidates(
  candidates: Array<Omit<DiscoveryCandidateRecord, "id" | "createdAt">>,
): Promise<DiscoveryCandidateRecord[]> {
  if (candidates.length === 0) return [];

  const createdAt = Date.now();
  const records = candidates.map((candidate, index) => ({
    ...candidate,
    id: `discovery_${createdAt}_${index}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
  }));
  const current = getMutableState();
  const discoveryCandidates = [...records, ...current.discoveryCandidates].slice(0, 120);
  await updateState({ discoveryCandidates, lastInteraction: Date.now() });
  return records;
}

export async function getDiscoveryCandidates(limit = 30): Promise<DiscoveryCandidateRecord[]> {
  return getMutableState().discoveryCandidates.slice(0, limit);
}

export function summarizeDiscoveryCandidates(limit = 12): string {
  const candidates = getMutableState().discoveryCandidates.slice(0, limit);
  if (candidates.length === 0) return "";

  return `最近已验证探索候选：\n${candidates
    .map((candidate) =>
      `- ${candidate.risk} | ${candidate.title} - ${candidate.artist} | 方向：${candidate.direction} | 来源：${candidate.urlSource ?? candidate.source ?? "unknown"} | ${candidate.health}`,
    )
    .join("\n")}`;
}

export async function addListenCheckRecord(
  record: Omit<ListenCheckRecord, "id" | "recordedAt">,
): Promise<ListenCheckRecord> {
  const nextRecord: ListenCheckRecord = {
    ...record,
    id: `listen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    recordedAt: Date.now(),
  };
  const current = getMutableState();
  const listenChecks = [nextRecord, ...current.listenChecks].slice(0, 20);
  await updateState({ listenChecks, lastInteraction: Date.now() });
  return nextRecord;
}

export async function getListenCheckRecords(limit = 10): Promise<ListenCheckRecord[]> {
  return getMutableState().listenChecks.slice(0, limit);
}
