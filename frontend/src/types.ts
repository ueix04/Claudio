export type AppStatus = "idle" | "thinking" | "speaking" | "playing" | "error";

export type TriggerMode = "morning_brief" | "mood_pick" | "random_discover";

export type LayoutMode = "split" | "player-fullscreen" | "chat-fullscreen";

export type ThemeMode = "dark" | "light";
export type AudioEffectMode = "wave" | "border-pulse";
export type TtsPreset = "冰糖" | "Dean";

export type DjProfile = {
  voice: string;
  style: string;
  name: string;
};

export type WSMessage = {
  type: "state" | "status" | "dj_message" | "track" | "error" | "chat" | "segue";
  data: unknown;
};

export type WSStatusPayload = AppStatus | {
  status: AppStatus;
};

export type WSChatPayload = {
  role: "user" | "dj";
  text: string;
  timestamp?: number;
};

export type WSDJMessagePayload = {
  text: string;
  ttsAudioPath?: string;
  timestamp?: number;
};

export type WSTrackPayload = {
  url: string;
  title?: string;
  name?: string;
  artist: string;
  album?: string;
  duration?: number;
  id?: string | number;
  picUrl?: string;
};

export type WSSeguePayload = {
  text: string;
  audioPath?: string;
};

export type ChatEntry = {
  id: string;
  role: "user" | "dj";
  text: string;
  time: string;
  timestamp: number;
  sender: string;
  avatarUrl?: string;
  audioUrl?: string;
  isReplay?: boolean;
};

export type TrackInfo = {
  id?: string;
  url: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  isFavorite?: boolean;
};

export type PlaylistTrack = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  isPlaying: boolean;
  url: string;
};

export type PlayerState = {
  currentTrack: TrackInfo | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  playlist: PlaylistTrack[];
  queueCount: number;
  status: AppStatus;
  isOnAir: boolean;
};

export type DJMessage = {
  id: string;
  sender: string;
  text: string;
  time: string;
  timestamp: number;
  avatarUrl?: string;
  hasAudio: boolean;
  audioUrl?: string;
};

export type PipelineResult = {
  status: "success" | "error";
  djMessage: string;
  tracks: Array<{ id: number; name: string; artist: string; url: string; picUrl: string; duration: number }>;
  reason: string;
  segue?: string;
  ttsAudioPath?: string;
};

export type PlayHistoryEntry = {
  title: string;
  artist: string;
  playedAt: number;
};

export type TasteProfileArtist = {
  name: string;
  count: number;
  playlistCount: number;
  sampleTracks: string[];
};

export type TasteProfileAlbum = {
  name: string;
  artist: string;
  count: number;
};

export type TasteProfileKeyword = {
  term: string;
  count: number;
};

export type TasteProfilePlaylistFingerprint = {
  id: number;
  name: string;
  trackCount: number;
  storedTrackCount: number;
  topArtists: string[];
  sampleTracks: string[];
};

export type TasteProfile = {
  generatedAt: number;
  sourceSyncedAt: number;
  playlistCount: number;
  totalTrackCount: number;
  uniqueTrackCount: number;
  uniqueArtistCount: number;
  uniqueAlbumCount: number;
  languageMix: {
    chinese: number;
    latin: number;
    mixed: number;
    other: number;
  };
  topArtists: TasteProfileArtist[];
  topAlbums: TasteProfileAlbum[];
  titleKeywords: TasteProfileKeyword[];
  artistKeywords: TasteProfileKeyword[];
  playlistFingerprints: TasteProfilePlaylistFingerprint[];
  summary: string;
};

export type SyncSummary = {
  ok: boolean;
  playlistCount: number;
  syncedAt: number;
  totalTrackCount: number;
  failedPlaylists: Array<{ id: number; name: string; error: string }>;
  topPlaylists: Array<{ id: number; name: string; trackCount: number; storedTracks: number }>;
  tasteProfile?: {
    generatedAt: number;
    totalTrackCount: number;
    uniqueArtistCount: number;
  };
};

export type FavoriteTrackItem = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  url?: string;
  isResolved: boolean;
};

export type LocalLibrarySampleTrack = {
  source: "local_library";
  sourceTrackId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
};

export type LocalLibraryStatus = {
  source: "local_library";
  enabled: boolean;
  configuredDirectoryCount: number;
  availableDirectoryCount: number;
  trackCount: number;
  maxFiles: number;
  scanCacheMs: number;
  scannedAt?: number;
  sampleTracks: LocalLibrarySampleTrack[];
  message: string;
};

export type ProgramAuditStatus = "pass" | "warning" | "fail";

export type ProgramAuditCheck = {
  id: string;
  label: string;
  status: ProgramAuditStatus;
  detail: string;
};

export type ProgramExperienceAudit = {
  ok: boolean;
  generatedAt: number;
  trackCount: number;
  plannedMinutes: number;
  speechSlotCount: number;
  djLineCount: number;
  checks: ProgramAuditCheck[];
  issues: ProgramAuditCheck[];
};

export type ListenCheckRecord = {
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
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
  recordedAt: number;
};

export type ListenAcceptanceCriterion = {
  id: "program" | "dj" | "context";
  label: string;
  passed: boolean;
  detail: string;
  recordId?: string;
  recordedAt?: number;
};

export type ListenAcceptanceSummary = {
  ready: boolean;
  status: "waiting" | "needs_review" | "ready";
  targetMinutes: number;
  totalRecords: number;
  latestRecord?: {
    id: string;
    recordedAt: number;
    durationMs: number;
    needsFollowUp: boolean;
    issueCount: number | null;
  };
  criteria: ListenAcceptanceCriterion[];
  generatedAt: number;
};
