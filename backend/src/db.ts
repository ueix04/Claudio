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

export const DEFAULT_PROFILE_ID = "default";

export interface UserProfile {
  id: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

export interface RootState {
  schemaVersion: 2;
  profiles: UserProfile[];
  activeProfileId: string;
  profileStates: Record<string, AppState>;
}

export class ProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Profile not found: ${profileId}`);
    this.name = "ProfileNotFoundError";
  }
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

let db: Low<RootState> | null = null;
let shouldPersistInitialState = false;

function defaultProfile(now = Date.now()): UserProfile {
  return {
    id: DEFAULT_PROFILE_ID,
    displayName: "xian",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  };
}

function defaultRootState(): RootState {
  const profile = defaultProfile();
  return {
    schemaVersion: 2,
    profiles: [profile],
    activeProfileId: profile.id,
    profileStates: {
      [profile.id]: defaultState(),
    },
  };
}

function normalizeAppState(parsed?: Partial<AppState>): AppState {
  const fallback = defaultState();
  if (!parsed || typeof parsed !== "object") {
    return fallback;
  }

  return {
    ...fallback,
    ...parsed,
    djProfile: {
      ...fallback.djProfile,
      ...(parsed.djProfile ?? {}),
    },
    radioQueue: Array.isArray(parsed.radioQueue) ? parsed.radioQueue : fallback.radioQueue,
    currentQueueIndex: typeof parsed.currentQueueIndex === "number"
      ? parsed.currentQueueIndex
      : fallback.currentQueueIndex,
    currentProgram: parsed.currentProgram ?? fallback.currentProgram,
    chatHistory: Array.isArray(parsed.chatHistory) ? parsed.chatHistory : fallback.chatHistory,
    playHistory: Array.isArray(parsed.playHistory) ? parsed.playHistory : fallback.playHistory,
    userFeedback: Array.isArray(parsed.userFeedback) ? parsed.userFeedback : fallback.userFeedback,
    discoveryCandidates: Array.isArray(parsed.discoveryCandidates)
      ? parsed.discoveryCandidates
      : fallback.discoveryCandidates,
    listenChecks: Array.isArray(parsed.listenChecks) ? parsed.listenChecks : fallback.listenChecks,
    playlists: Array.isArray(parsed.playlists) ? parsed.playlists : fallback.playlists,
    neteaseSnapshot: parsed.neteaseSnapshot ?? fallback.neteaseSnapshot,
    favorites: Array.isArray(parsed.favorites) ? parsed.favorites : fallback.favorites,
  };
}

function isRootState(value: unknown): value is Partial<RootState> {
  return Boolean(
    value
      && typeof value === "object"
      && "profileStates" in value
      && "profiles" in value,
  );
}

function normalizeRootState(parsed: Partial<RootState>): RootState {
  const fallback = defaultRootState();
  const rawProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : fallback.profiles;
  const profileStates = parsed.profileStates && typeof parsed.profileStates === "object"
    ? parsed.profileStates
    : {};

  const profiles = rawProfiles.flatMap((profile) => {
    if (!profile || typeof profile.id !== "string" || !profile.id.trim()) {
      return [];
    }
    const now = Date.now();
    return [{
      id: profile.id.trim(),
      displayName: typeof profile.displayName === "string" && profile.displayName.trim()
        ? profile.displayName.trim()
        : profile.id.trim(),
      createdAt: typeof profile.createdAt === "number" ? profile.createdAt : now,
      updatedAt: typeof profile.updatedAt === "number" ? profile.updatedAt : now,
      lastUsedAt: typeof profile.lastUsedAt === "number" ? profile.lastUsedAt : now,
    } satisfies UserProfile];
  });

  const dedupedProfiles = profiles.filter((profile, index) =>
    profiles.findIndex((candidate) => candidate.id === profile.id) === index,
  );
  const normalizedProfiles = dedupedProfiles.length > 0 ? dedupedProfiles : fallback.profiles;
  const normalizedStates = Object.fromEntries(
    normalizedProfiles.map((profile) => [
      profile.id,
      normalizeAppState(profileStates[profile.id]),
    ]),
  );
  const activeProfileId = typeof parsed.activeProfileId === "string"
    && normalizedStates[parsed.activeProfileId]
    ? parsed.activeProfileId
    : normalizedProfiles[0]?.id ?? DEFAULT_PROFILE_ID;

  return {
    schemaVersion: 2,
    profiles: normalizedProfiles,
    activeProfileId,
    profileStates: normalizedStates,
  };
}

function migrateLegacyState(parsed: Partial<AppState>): RootState {
  const profile = defaultProfile();
  const state = normalizeAppState(parsed);
  profile.lastUsedAt = state.lastInteraction;
  profile.updatedAt = state.lastInteraction;

  return {
    schemaVersion: 2,
    profiles: [profile],
    activeProfileId: profile.id,
    profileStates: {
      [profile.id]: state,
    },
  };
}

function ensureStateFile(): void {
  const directory = dirname(stateFilePath);
  mkdirSync(directory, { recursive: true });

  if (!existsSync(stateFilePath)) {
    writeFileSync(stateFilePath, JSON.stringify(defaultRootState(), null, 2), "utf-8");
  }
}

function loadInitialState(): RootState {
  try {
    const raw = readFileSync(stateFilePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RootState> | Partial<AppState>;
    if (isRootState(parsed)) {
      return normalizeRootState(parsed);
    }
    shouldPersistInitialState = true;
    return migrateLegacyState(parsed as Partial<AppState>);
  } catch {
    shouldPersistInitialState = true;
    return defaultRootState();
  }
}

function createDb(): Low<RootState> {
  ensureStateFile();
  const adapter = new JSONFile<RootState>(stateFilePath);
  const instance = new Low<RootState>(adapter, defaultRootState());
  instance.data = loadInitialState();
  return instance;
}

function getMutableRootState(): RootState {
  const current = getDb().data;
  if (!current) {
    const initial = defaultRootState();
    getDb().data = initial;
    return initial;
  }
  return current;
}

function resolveProfileId(profileId?: string): string {
  const normalized = profileId?.trim();
  return normalized || DEFAULT_PROFILE_ID;
}

function getMutableState(profileId?: string): AppState {
  const id = resolveProfileId(profileId);
  const root = getMutableRootState();
  const state = root.profileStates[id];
  if (!state) {
    throw new ProfileNotFoundError(id);
  }
  return state;
}

function touchProfile(root: RootState, profileId: string): void {
  const profile = root.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return;
  }
  const now = Date.now();
  profile.lastUsedAt = now;
  profile.updatedAt = now;
  root.activeProfileId = profileId;
}

function createProfileId(displayName: string): string {
  const base = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "profile";
  return `profile_${base}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function getDb(): Low<RootState> {
  if (!db) {
    db = createDb();
  }

  return db;
}

export async function getProfiles(): Promise<UserProfile[]> {
  return [...getMutableRootState().profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export async function getProfile(profileId: string): Promise<UserProfile | null> {
  const id = resolveProfileId(profileId);
  return getMutableRootState().profiles.find((profile) => profile.id === id) ?? null;
}

export function hasProfile(profileId: string): boolean {
  const id = resolveProfileId(profileId);
  return Boolean(getMutableRootState().profileStates[id]);
}

export async function createProfile(input?: { displayName?: string }): Promise<UserProfile> {
  const root = getMutableRootState();
  const displayName = input?.displayName?.trim() || `Profile ${root.profiles.length + 1}`;
  let id = createProfileId(displayName);
  while (root.profileStates[id]) {
    id = createProfileId(displayName);
  }

  const now = Date.now();
  const profile: UserProfile = {
    id,
    displayName,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  };
  root.profiles.push(profile);
  root.profileStates[id] = defaultState();
  root.activeProfileId = id;
  getDb().data = root;
  await getDb().write();
  return profile;
}

export async function updateProfile(
  profileId: string,
  patch: { displayName?: string },
): Promise<UserProfile> {
  const id = resolveProfileId(profileId);
  const root = getMutableRootState();
  const profile = root.profiles.find((item) => item.id === id);
  if (!profile) {
    throw new ProfileNotFoundError(id);
  }

  if (typeof patch.displayName === "string" && patch.displayName.trim()) {
    profile.displayName = patch.displayName.trim().slice(0, 80);
  }
  profile.updatedAt = Date.now();
  profile.lastUsedAt = profile.updatedAt;
  root.activeProfileId = id;
  getDb().data = root;
  await getDb().write();
  return profile;
}

export async function touchUserProfile(profileId?: string): Promise<UserProfile> {
  const id = resolveProfileId(profileId);
  const root = getMutableRootState();
  const profile = root.profiles.find((item) => item.id === id);
  if (!profile) {
    throw new ProfileNotFoundError(id);
  }
  touchProfile(root, id);
  getDb().data = root;
  await getDb().write();
  return profile;
}

export async function updateState(patch: Partial<AppState>, profileId?: string): Promise<AppState> {
  const id = resolveProfileId(profileId);
  const root = getMutableRootState();
  const current = getMutableState(id);
  const next: AppState = {
    ...current,
    ...patch,
    djProfile: patch.djProfile
      ? { ...current.djProfile, ...patch.djProfile }
      : current.djProfile,
    chatHistory: patch.chatHistory ?? current.chatHistory,
  };

  root.profileStates[id] = next;
  touchProfile(root, id);
  getDb().data = root;
  await getDb().write();
  return next;
}

export async function getState(profileId?: string): Promise<AppState> {
  const state = getMutableState(profileId);
  if (!existsSync(stateFilePath) || shouldPersistInitialState) {
    await getDb().write();
    shouldPersistInitialState = false;
  }
  return state;
}

export async function addChatMessage(
  msg: Omit<ChatMessage, "timestamp"> & { timestamp?: number },
  profileId?: string,
): Promise<AppState> {
  const current = getMutableState(profileId);
  return updateState({
    chatHistory: [
      ...current.chatHistory,
      {
        role: msg.role,
        text: msg.text,
        timestamp: msg.timestamp ?? Date.now(),
      },
    ],
    lastInteraction: Date.now(),
  }, profileId);
}

export async function setStatus(status: AppStatus, profileId?: string): Promise<AppState> {
  return updateState({ status, lastInteraction: Date.now() }, profileId);
}

export async function setCurrentTrack(track: Track | null, profileId?: string): Promise<AppState> {
  return updateState({ currentTrack: track, lastInteraction: Date.now() }, profileId);
}

export async function setRadioQueue(
  queue: Track[],
  options?: {
    currentIndex?: number;
    program?: RadioProgram | null;
  },
  profileId?: string,
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
  }, profileId);
}

export async function advanceRadioQueue(step = 1, profileId?: string): Promise<AppState | null> {
  const current = getMutableState(profileId);
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
  }, profileId);
}

export async function getRadioQueue(profileId?: string): Promise<Track[]> {
  return getMutableState(profileId).radioQueue;
}

export async function selectRadioQueueTrack(trackId: string, profileId?: string): Promise<AppState | null> {
  const current = getMutableState(profileId);
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
  }, profileId);
}

export async function addPlaylist(name: string, tracks: PlaylistItem[], profileId?: string): Promise<Playlist> {
  const playlist: Playlist = {
    id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    tracks,
    createdAt: Date.now(),
  };

  const current = getMutableState(profileId);
  await updateState({
    playlists: [...current.playlists, playlist],
    lastInteraction: Date.now(),
  }, profileId);
  return playlist;
}

export async function getPlaylists(profileId?: string): Promise<Playlist[]> {
  return getMutableState(profileId).playlists;
}

export async function removePlaylist(id: string, profileId?: string): Promise<boolean> {
  const current = getMutableState(profileId);
  const idx = current.playlists.findIndex((p) => p.id === id);
  if (idx === -1) return false;

  await updateState({
    playlists: current.playlists.filter((p) => p.id !== id),
    lastInteraction: Date.now(),
  }, profileId);
  return true;
}

export function summarizePlaylists(profileId?: string): string {
  const playlists = getMutableState(profileId).playlists;
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

export async function getNeteaseSnapshot(profileId?: string): Promise<NeteaseSnapshot | null> {
  return getMutableState(profileId).neteaseSnapshot;
}

export async function setNeteaseSnapshot(snapshot: NeteaseSnapshot, profileId?: string): Promise<AppState> {
  return updateState({
    neteaseSnapshot: snapshot,
    lastInteraction: Date.now(),
  }, profileId);
}

export function summarizeNeteaseSnapshot(limit = 5, profileId?: string): string {
  const snapshot = getMutableState(profileId).neteaseSnapshot;
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

export async function getFavorites(profileId?: string): Promise<string[]> {
  return getMutableState(profileId).favorites;
}

export async function addFavorite(trackId: string, profileId?: string): Promise<AppState> {
  const current = getMutableState(profileId);
  if (current.favorites.includes(trackId)) return current;
  return updateState({
    favorites: [...current.favorites, trackId],
    lastInteraction: Date.now(),
  }, profileId);
}

export async function removeFavorite(trackId: string, profileId?: string): Promise<AppState> {
  const current = getMutableState(profileId);
  return updateState({
    favorites: current.favorites.filter((id) => id !== trackId),
    lastInteraction: Date.now(),
  }, profileId);
}

export async function toggleFavorite(trackId: string, profileId?: string): Promise<{ favorited: boolean }> {
  const current = getMutableState(profileId);
  if (current.favorites.includes(trackId)) {
    await removeFavorite(trackId, profileId);
    return { favorited: false };
  }
  await addFavorite(trackId, profileId);
  return { favorited: true };
}

export async function recordPlay(title: string, artist: string, profileId?: string): Promise<AppState> {
  const current = getMutableState(profileId);
  const record: PlayRecord = { title, artist, playedAt: Date.now() };
  const history = [record, ...current.playHistory];
  return updateState({ playHistory: history, lastInteraction: Date.now() }, profileId);
}

export async function getPlayHistory(limit = 20, profileId?: string): Promise<PlayRecord[]> {
  return getMutableState(profileId).playHistory.slice(0, limit);
}

export async function addUserFeedback(
  feedback: Omit<UserFeedbackRecord, "id" | "createdAt">,
  profileId?: string,
): Promise<UserFeedbackRecord> {
  const record: UserFeedbackRecord = {
    ...feedback,
    id: `feedback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  };
  const current = getMutableState(profileId);
  const userFeedback = [record, ...current.userFeedback].slice(0, 200);
  await updateState({ userFeedback, lastInteraction: Date.now() }, profileId);
  return record;
}

export async function getUserFeedback(limit = 50, profileId?: string): Promise<UserFeedbackRecord[]> {
  return getMutableState(profileId).userFeedback.slice(0, limit);
}

export function summarizeUserFeedback(limit = 20, profileId?: string): string {
  const feedback = getMutableState(profileId).userFeedback.slice(0, limit);
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
  profileId?: string,
): Promise<DiscoveryCandidateRecord[]> {
  if (candidates.length === 0) return [];

  const createdAt = Date.now();
  const records = candidates.map((candidate, index) => ({
    ...candidate,
    id: `discovery_${createdAt}_${index}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
  }));
  const current = getMutableState(profileId);
  const discoveryCandidates = [...records, ...current.discoveryCandidates].slice(0, 120);
  await updateState({ discoveryCandidates, lastInteraction: Date.now() }, profileId);
  return records;
}

export async function getDiscoveryCandidates(limit = 30, profileId?: string): Promise<DiscoveryCandidateRecord[]> {
  return getMutableState(profileId).discoveryCandidates.slice(0, limit);
}

export function summarizeDiscoveryCandidates(limit = 12, profileId?: string): string {
  const candidates = getMutableState(profileId).discoveryCandidates.slice(0, limit);
  if (candidates.length === 0) return "";

  return `最近已验证探索候选：\n${candidates
    .map((candidate) =>
      `- ${candidate.risk} | ${candidate.title} - ${candidate.artist} | 方向：${candidate.direction} | 来源：${candidate.urlSource ?? candidate.source ?? "unknown"} | ${candidate.health}`,
    )
    .join("\n")}`;
}

export async function addListenCheckRecord(
  record: Omit<ListenCheckRecord, "id" | "recordedAt">,
  profileId?: string,
): Promise<ListenCheckRecord> {
  const nextRecord: ListenCheckRecord = {
    ...record,
    id: `listen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    recordedAt: Date.now(),
  };
  const current = getMutableState(profileId);
  const listenChecks = [nextRecord, ...current.listenChecks].slice(0, 20);
  await updateState({ listenChecks, lastInteraction: Date.now() }, profileId);
  return nextRecord;
}

export async function getListenCheckRecords(limit = 10, profileId?: string): Promise<ListenCheckRecord[]> {
  return getMutableState(profileId).listenChecks.slice(0, limit);
}
