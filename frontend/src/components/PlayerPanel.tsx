import React, { useCallback, useEffect, useRef, useState } from "react";
import { AUDIO_EFFECT_OPTIONS } from "../audio-effects";
import {
  AppStatus,
  DiscoveryCandidateRecord,
  FavoriteTrackItem,
  ListenAcceptanceSummary,
  ListenCheckRecord,
  LocalLibraryStatus,
  LocalLibraryTasteMatchSummary,
  MusicSourceRuntimeStatus,
  PlaybackDiagnosticTrack,
  PlaybackDiagnostics,
  PlayHistoryEntry,
  PlayerState,
  ProgramExperienceAudit,
  SyncSummary,
  TasteProfile,
  TrackFeedbackType,
  TriggerMode,
  UserFeedbackRecord,
} from "../types";
import { useLayout } from "./LayoutManager";
import { PixelClock } from "./PixelClock";

interface PlayerPanelProps {
  playerState: PlayerState;
  favoriteTracks: FavoriteTrackItem[];
  playHistory: PlayHistoryEntry[];
  userFeedback: UserFeedbackRecord[];
  discoveryCandidates: DiscoveryCandidateRecord[];
  tasteProfile: TasteProfile | null;
  isSyncingLibrary: boolean;
  lastSyncSummary: SyncSummary | null;
  musicSourceStatus: MusicSourceRuntimeStatus | null;
  playbackDiagnostics: PlaybackDiagnostics | null;
  localLibraryStatus: LocalLibraryStatus | null;
  localLibraryMatchStatus: LocalLibraryTasteMatchSummary | null;
  programAudit: ProgramExperienceAudit | null;
  listenCheckRecords: ListenCheckRecord[];
  listenAcceptance: ListenAcceptanceSummary | null;
  isRescanningLocalLibrary: boolean;
  utilityNotice: string | null;
  visualizerBars: number[];
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (time: number) => void;
  onVolumeChange: (volume: number) => void;
  onToggleFavorite: (trackId: string) => void;
  onTrackFeedback: (type: TrackFeedbackType) => void;
  onSelectTrack: (trackId: string) => void;
  onPlaySavedTrack: (trackId: string) => void;
  onUserAvatarUpload: (file: File) => Promise<void>;
  onFullscreenToggle: () => void;
  isFullscreen: boolean;
  onTrigger: (mode: TriggerMode) => void;
  onSyncLibrary: () => void;
  onRetryFailedSync: () => void;
  onRescanLocalLibrary: () => void;
  onListenCheckSaved: () => void;
  isTriggerBusy: boolean;
  statusText: string;
  status: AppStatus;
}

type PlayerView = "list" | "favorites" | "taste";
type PlayerDisplayMode = "playlist" | "clock";
type SettingsPanel = "root" | "theme" | "display" | "audio";
type WeatherBadge = { emoji: string; summary: string };
type ListenCheckId = "program" | "dj" | "context";
type ListenPlaybackSegment = {
  trackId: string;
  title: string;
  artist: string;
  playedMs: number;
};
type ListenCheckState = {
  startedAt: number | null;
  completedAt: number | null;
  playbackMs: number;
  playbackSegments: ListenPlaybackSegment[];
  audioSignalSampleCount: number;
  lowSignalSampleCount: number;
  silentMs: number;
  maxSilentRunMs: number;
  currentSilentRunMs: number;
  lastPlaybackTickAt: number | null;
  lastPlaybackTrackKey: string | null;
  lastPlaybackPositionSec: number | null;
  savedRecordId: string | null;
  programSessionId: string | null;
  programGeneratedAt: number | null;
  programTitle: string | null;
  checks: Record<ListenCheckId, boolean>;
  note: string;
  needsFollowUp: boolean;
};

const LISTEN_CHECK_STORAGE_KEY = "claudio-listen-check";
const LISTEN_CHECK_TARGET_MS = 20 * 60 * 1000;
const LISTEN_SIGNAL_SILENCE_LEVEL = 0.012;
const LISTEN_SIGNAL_MIN_VOLUME = 0.05;
const LISTEN_CHECK_ITEMS: Array<{ id: ListenCheckId; label: string }> = [
  { id: "program", label: "PROGRAM FEEL" },
  { id: "dj", label: "DJ RESTRAINT" },
  { id: "context", label: "CONTEXT FLOW" },
];

const createEmptyListenCheck = (): ListenCheckState => ({
  startedAt: null,
  completedAt: null,
  playbackMs: 0,
  playbackSegments: [],
  audioSignalSampleCount: 0,
  lowSignalSampleCount: 0,
  silentMs: 0,
  maxSilentRunMs: 0,
  currentSilentRunMs: 0,
  lastPlaybackTickAt: null,
  lastPlaybackTrackKey: null,
  lastPlaybackPositionSec: null,
  savedRecordId: null,
  programSessionId: null,
  programGeneratedAt: null,
  programTitle: null,
  checks: {
    program: false,
    dj: false,
    context: false,
  },
  note: "",
  needsFollowUp: false,
});

const loadListenCheckState = (): ListenCheckState => {
  const empty = createEmptyListenCheck();
  if (typeof window === "undefined") return empty;

  try {
    const raw = window.localStorage.getItem(LISTEN_CHECK_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<ListenCheckState>;
    return {
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null,
      completedAt: typeof parsed.completedAt === "number" ? parsed.completedAt : null,
      playbackMs: typeof parsed.playbackMs === "number" && parsed.playbackMs > 0 ? parsed.playbackMs : 0,
      playbackSegments: Array.isArray(parsed.playbackSegments)
        ? parsed.playbackSegments.flatMap((segment) => {
            const trackId = typeof segment.trackId === "string" ? segment.trackId.trim().slice(0, 160) : "";
            const playedMs = Number(segment.playedMs);
            if (!trackId || !Number.isFinite(playedMs) || playedMs <= 0) return [];
            return [{
              trackId,
              title: typeof segment.title === "string" ? segment.title.trim().slice(0, 160) : "Unknown Title",
              artist: typeof segment.artist === "string" ? segment.artist.trim().slice(0, 160) : "Unknown Artist",
              playedMs: Math.round(playedMs),
            }];
          }).slice(0, 20)
        : [],
      audioSignalSampleCount: typeof parsed.audioSignalSampleCount === "number" && parsed.audioSignalSampleCount > 0
        ? Math.round(parsed.audioSignalSampleCount)
        : 0,
      lowSignalSampleCount: typeof parsed.lowSignalSampleCount === "number" && parsed.lowSignalSampleCount > 0
        ? Math.round(parsed.lowSignalSampleCount)
        : 0,
      silentMs: typeof parsed.silentMs === "number" && parsed.silentMs > 0
        ? Math.round(parsed.silentMs)
        : 0,
      maxSilentRunMs: typeof parsed.maxSilentRunMs === "number" && parsed.maxSilentRunMs > 0
        ? Math.round(parsed.maxSilentRunMs)
        : 0,
      currentSilentRunMs: 0,
      lastPlaybackTickAt: null,
      lastPlaybackTrackKey: null,
      lastPlaybackPositionSec: null,
      savedRecordId: typeof parsed.savedRecordId === "string" ? parsed.savedRecordId : null,
      programSessionId: typeof parsed.programSessionId === "string" ? parsed.programSessionId : null,
      programGeneratedAt: typeof parsed.programGeneratedAt === "number" ? parsed.programGeneratedAt : null,
      programTitle: typeof parsed.programTitle === "string" ? parsed.programTitle : null,
      checks: {
        program: Boolean(parsed.checks?.program),
        dj: Boolean(parsed.checks?.dj),
        context: Boolean(parsed.checks?.context),
      },
      note: typeof parsed.note === "string" ? parsed.note.slice(0, 500) : "",
      needsFollowUp: parsed.needsFollowUp === true,
    };
  } catch {
    return empty;
  }
};

const formatPlaybackTime = (timeInSeconds: number) => {
  if (isNaN(timeInSeconds)) return "0:00";
  const m = Math.floor(timeInSeconds / 60);
  const s = Math.floor(timeInSeconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const formatTrackDuration = (duration?: number) => {
  if (!duration || Number.isNaN(duration)) return "--:--";
  const seconds = duration > 1000 ? Math.round(duration / 1000) : Math.round(duration);
  return formatPlaybackTime(seconds);
};

const formatHistoryTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const formatScanTime = (timestamp?: number) =>
  timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--";

const formatLeaseTime = (ttlMs: number | null | undefined) => {
  if (ttlMs === null || ttlMs === undefined || !Number.isFinite(ttlMs)) return "--";
  if (ttlMs <= 0) return "expired";
  return formatPlaybackTime(Math.floor(ttlMs / 1000));
};

const formatDateLabel = (date: Date) =>
  date.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase();

const formatMonthDayLabel = (date: Date) =>
  date.toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase();

const toPercent = (value: number, total: number) =>
  total <= 0 ? 0 : Math.round((value / total) * 100);

const formatRuntimeScore = (score: number) =>
  `${score > 0 ? "+" : ""}${score.toFixed(1)}`;

const addListenPlaybackSegment = (
  segments: ListenPlaybackSegment[],
  segment: ListenPlaybackSegment,
): ListenPlaybackSegment[] => {
  if (segment.playedMs <= 0) return segments;
  const existingIndex = segments.findIndex((item) => item.trackId === segment.trackId);
  if (existingIndex === -1) {
    return [...segments, segment].slice(-20);
  }

  return segments.map((item, index) => (
    index === existingIndex
      ? { ...item, playedMs: item.playedMs + segment.playedMs }
      : item
  ));
};

export const PlayerPanel: React.FC<PlayerPanelProps> = ({
  playerState,
  favoriteTracks,
  playHistory,
  userFeedback,
  discoveryCandidates,
  tasteProfile,
  isSyncingLibrary,
  lastSyncSummary,
  musicSourceStatus,
  playbackDiagnostics,
  localLibraryStatus,
  localLibraryMatchStatus,
  programAudit,
  listenCheckRecords,
  listenAcceptance,
  isRescanningLocalLibrary,
  utilityNotice,
  visualizerBars,
  onPlayPause,
  onNext,
  onPrevious,
  onSeek,
  onVolumeChange,
  onToggleFavorite,
  onTrackFeedback,
  onSelectTrack,
  onPlaySavedTrack,
  onUserAvatarUpload,
  onFullscreenToggle,
  isFullscreen,
  onTrigger,
  onSyncLibrary,
  onRetryFailedSync,
  onRescanLocalLibrary,
  onListenCheckSaved,
  isTriggerBusy,
  statusText,
  status,
}) => {
  const { togglePlayerFullscreen, theme, setTheme, audioEffect, setAudioEffect } = useLayout();
  const [activeView, setActiveView] = useState<PlayerView>("list");
  const [displayMode, setDisplayMode] = useState<PlayerDisplayMode>("playlist");
  const [isQueueExpanded, setIsQueueExpanded] = useState(false);
  const [isRecentExpanded, setIsRecentExpanded] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [weatherBadge, setWeatherBadge] = useState<WeatherBadge | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanel>("root");
  const [listenCheck, setListenCheck] = useState<ListenCheckState>(() => loadListenCheckState());
  const volumeTrackRef = useRef<HTMLDivElement>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const listStageScrollRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const listenCheckSaveKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(LISTEN_CHECK_STORAGE_KEY, JSON.stringify(listenCheck));
  }, [listenCheck]);

  useEffect(() => {
    setListenCheck((current) => {
      if (!current.startedAt || current.completedAt) return current;
      const currentTrackKey = playerState.currentTrack?.id ?? playerState.currentTrack?.url ?? null;
      const currentPositionSec = Number.isFinite(playerState.currentTime)
        ? Math.max(0, playerState.currentTime)
        : 0;
      const isPlaybackActive = playerState.isPlaying && Boolean(currentTrackKey);
      const fallbackSegmentTrackId = [
        playerState.currentTrack?.title,
        playerState.currentTrack?.artist,
      ].filter(Boolean).join("::");
      const segmentTrackId = playerState.currentTrack?.id ?? (fallbackSegmentTrackId || null);
      const nowMs = Date.now();
      const sameTrack = isPlaybackActive && current.lastPlaybackTrackKey === currentTrackKey;
      const positionDeltaMs = sameTrack && current.lastPlaybackPositionSec !== null
        ? Math.max(0, (currentPositionSec - current.lastPlaybackPositionSec) * 1000)
        : 0;
      const wallDeltaMs = current.lastPlaybackTickAt !== null
        ? Math.max(0, nowMs - current.lastPlaybackTickAt)
        : 0;
      const playedDeltaMs = isPlaybackActive
        ? Math.min(positionDeltaMs, wallDeltaMs)
        : 0;
      const canSampleSignal = Boolean(
        isPlaybackActive
          && playedDeltaMs > 0
          && status !== "speaking"
          && playerState.volume >= LISTEN_SIGNAL_MIN_VOLUME
          && typeof playerState.audioSignalLevel === "number",
      );
      const hasLowSignal = canSampleSignal && (playerState.audioSignalLevel ?? 0) <= LISTEN_SIGNAL_SILENCE_LEVEL;
      const nextAudioSignalSampleCount = canSampleSignal
        ? current.audioSignalSampleCount + 1
        : current.audioSignalSampleCount;
      const nextLowSignalSampleCount = hasLowSignal
        ? current.lowSignalSampleCount + 1
        : current.lowSignalSampleCount;
      const nextSilentMs = hasLowSignal
        ? current.silentMs + playedDeltaMs
        : current.silentMs;
      const nextCurrentSilentRunMs = hasLowSignal
        ? current.currentSilentRunMs + playedDeltaMs
        : 0;
      const nextMaxSilentRunMs = Math.max(current.maxSilentRunMs, nextCurrentSilentRunMs);
      const nextPlaybackMs = isPlaybackActive
        ? Math.min(
            LISTEN_CHECK_TARGET_MS,
            current.playbackMs + playedDeltaMs,
          )
        : current.playbackMs;
      const nextTrackKey = isPlaybackActive ? currentTrackKey : currentTrackKey ?? current.lastPlaybackTrackKey;
      const nextPositionSec = isPlaybackActive || currentTrackKey
        ? currentPositionSec
        : current.lastPlaybackPositionSec;
      const nextPlaybackSegments = playedDeltaMs > 0 && segmentTrackId
        ? addListenPlaybackSegment(current.playbackSegments, {
            trackId: segmentTrackId,
            title: playerState.currentTrack?.title ?? "Unknown Title",
            artist: playerState.currentTrack?.artist ?? "Unknown Artist",
            playedMs: Math.round(playedDeltaMs),
          })
        : current.playbackSegments;
      const allChecksPassed = LISTEN_CHECK_ITEMS.every((item) => current.checks[item.id]);
      if (!allChecksPassed || nextPlaybackMs < LISTEN_CHECK_TARGET_MS) {
        if (
          nextPlaybackMs === current.playbackMs
          && nextPlaybackSegments === current.playbackSegments
          && nextAudioSignalSampleCount === current.audioSignalSampleCount
          && nextLowSignalSampleCount === current.lowSignalSampleCount
          && nextSilentMs === current.silentMs
          && nextMaxSilentRunMs === current.maxSilentRunMs
          && nextCurrentSilentRunMs === current.currentSilentRunMs
          && current.lastPlaybackTickAt === (isPlaybackActive ? nowMs : null)
          && current.lastPlaybackTrackKey === nextTrackKey
          && current.lastPlaybackPositionSec === nextPositionSec
        ) {
          return current;
        }
        return {
          ...current,
          playbackMs: nextPlaybackMs,
          playbackSegments: nextPlaybackSegments,
          audioSignalSampleCount: nextAudioSignalSampleCount,
          lowSignalSampleCount: nextLowSignalSampleCount,
          silentMs: Math.round(nextSilentMs),
          maxSilentRunMs: Math.round(nextMaxSilentRunMs),
          currentSilentRunMs: Math.round(nextCurrentSilentRunMs),
          lastPlaybackTickAt: isPlaybackActive ? nowMs : null,
          lastPlaybackTrackKey: nextTrackKey,
          lastPlaybackPositionSec: nextPositionSec,
        };
      }
      return {
        ...current,
        playbackMs: nextPlaybackMs,
        playbackSegments: nextPlaybackSegments,
        audioSignalSampleCount: nextAudioSignalSampleCount,
        lowSignalSampleCount: nextLowSignalSampleCount,
        silentMs: Math.round(nextSilentMs),
        maxSilentRunMs: Math.round(nextMaxSilentRunMs),
        currentSilentRunMs: Math.round(nextCurrentSilentRunMs),
        lastPlaybackTickAt: isPlaybackActive ? nowMs : null,
        lastPlaybackTrackKey: nextTrackKey,
        lastPlaybackPositionSec: nextPositionSec,
        completedAt: nowMs,
      };
    });
  }, [
    playerState.currentTrack?.id,
    playerState.currentTrack?.url,
    playerState.currentTime,
    playerState.isPlaying,
    playerState.audioSignalLevel,
    playerState.volume,
    status,
  ]);

  useEffect(() => {
    if (!listenCheck.startedAt || !listenCheck.completedAt || listenCheck.savedRecordId) return;
    const saveKey = `${listenCheck.startedAt}:${listenCheck.completedAt}`;
    if (listenCheckSaveKeyRef.current === saveKey) return;
    listenCheckSaveKeyRef.current = saveKey;

    let cancelled = false;
    const saveListenCheck = async () => {
      try {
        const res = await fetch("/api/radio/listen-checks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startedAt: listenCheck.startedAt,
            completedAt: listenCheck.completedAt,
            playbackMs: listenCheck.playbackMs,
            playbackSegments: listenCheck.playbackSegments,
            clientAudioEvidence: {
              signalSampleCount: listenCheck.audioSignalSampleCount,
              lowSignalSampleCount: listenCheck.lowSignalSampleCount,
              silentMs: listenCheck.silentMs,
              maxSilentRunMs: listenCheck.maxSilentRunMs,
            },
            checks: listenCheck.checks,
            note: listenCheck.note,
            needsFollowUp: listenCheck.needsFollowUp,
            startedProgram: {
              sessionId: listenCheck.programSessionId ?? undefined,
              generatedAt: listenCheck.programGeneratedAt ?? undefined,
            },
          }),
        });
        if (!res.ok) {
          if (!cancelled) {
            listenCheckSaveKeyRef.current = null;
          }
          return;
        }
        const record = await res.json() as { id?: string };
        if (cancelled || !record.id) return;
        setListenCheck((current) => (
          current.completedAt === listenCheck.completedAt && !current.savedRecordId
            ? { ...current, savedRecordId: record.id ?? null }
            : current
        ));
        onListenCheckSaved();
      } catch {
        if (!cancelled) {
          listenCheckSaveKeyRef.current = null;
        }
        // keep the local listen check; it can be retried by restarting or toggling a check.
      }
    };

    void saveListenCheck();
    return () => {
      cancelled = true;
    };
  }, [listenCheck, onListenCheckSaved]);

  useEffect(() => {
    const toEmoji = (description: string) => {
      const text = description.toLowerCase();
      if (text.includes("雨") || text.includes("rain")) return "🌧️";
      if (text.includes("雷") || text.includes("storm")) return "⛈️";
      if (text.includes("雪") || text.includes("snow")) return "❄️";
      if (text.includes("云") || text.includes("cloud")) return "☁️";
      if (text.includes("雾") || text.includes("fog") || text.includes("霾")) return "🌫️";
      return "☀️";
    };

    let cancelled = false;

    const loadWeather = async () => {
      try {
        const res = await fetch("/api/weather/current");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const description = data?.weather?.description ?? "晴";
        const temp = typeof data?.temperature?.actual === "number" ? Math.round(data.temperature.actual) : null;
        const unit = data?.temperature?.unit ?? "°C";
        setWeatherBadge({
          emoji: toEmoji(description),
          summary: temp === null ? description : `${description} ${temp}${unit}`,
        });
      } catch {
        if (!cancelled) setWeatherBadge(null);
      }
    };

    void loadWeather();
    const timer = window.setInterval(() => void loadWeather(), 15 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!isSettingsOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!settingsMenuRef.current?.contains(target)) {
        setIsSettingsOpen(false);
        setSettingsPanel("root");
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isSettingsOpen]);

  useEffect(() => {
    if (displayMode !== "playlist") return;
    listStageScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [displayMode, activeView]);

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    onSeek(percent * playerState.duration);
  };

  const progressPercent = playerState.duration > 0
    ? (playerState.currentTime / playerState.duration) * 100
    : 0;

  const currentTrackId = playerState.currentTrack?.id;
  const currentTrackFavorited = playerState.currentTrack?.isFavorite ?? false;
  const currentPlaylistIndex = playerState.playlist.findIndex((track) => track.isPlaying);
  const orderedPlaylist = currentPlaylistIndex > 0
    ? [
        ...playerState.playlist.slice(currentPlaylistIndex),
        ...playerState.playlist.slice(0, currentPlaylistIndex),
      ]
    : playerState.playlist;
  const onlineSourceCount = musicSourceStatus?.sources.filter((source) =>
    source.source !== "local_library" && source.enabled && source.ok
  ).length ?? 0;
  const librarySignalText = onlineSourceCount > 0
    ? `${onlineSourceCount} online source${onlineSourceCount === 1 ? "" : "s"} ready`
    : "Online sources standby";
  const formatSourceName = (source: string) =>
    source === "local_library" ? "LOCAL"
      : source === "netease_legacy" ? "NETEASE"
        : source === "unblock_netease" ? "UNBLOCK" : source.toUpperCase();

  const updateVolumeFromClientX = useCallback((clientX: number) => {
    const track = volumeTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const percent = (clientX - rect.left) / rect.width;
    onVolumeChange(Math.max(0, Math.min(1, percent)));
  }, [onVolumeChange]);

  const handleVolumePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    updateVolumeFromClientX(e.clientX);
  };

  const handleVolumePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    updateVolumeFromClientX(e.clientX);
  };

  const handleVolumePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    activePointerIdRef.current = null;
  };

  const renderVisualizer = (size: "compact" | "wide" = "compact") => {
    const bars = visualizerBars.length > 0 ? visualizerBars : Array.from({ length: size === "wide" ? 24 : 12 }, () => 0.08);
    return (
      <div className={`visualizer-shell ${size === "wide" ? "visualizer-shell-wide" : ""}`}>
        {bars.map((value, index) => (
          <span
            key={`${size}-${index}`}
            className="visualizer-bar"
            style={{
              height: `${Math.max(size === "wide" ? 14 : 10, value * (size === "wide" ? 84 : 34))}px`,
              animationDuration: `${0.48 + (index % 5) * 0.07}s`,
            }}
          />
        ))}
      </div>
    );
  };

  const renderTriggerPills = () => (
    <div className="flex justify-center gap-3 px-6 py-2">
      <button className="trigger-pill" disabled={isTriggerBusy} onClick={() => onTrigger("morning_brief")}>
        MORNING
      </button>
      <button className="trigger-pill" disabled={isTriggerBusy} onClick={() => onTrigger("mood_pick")}>
        MOOD
      </button>
      <button className="trigger-pill" disabled={isTriggerBusy} onClick={() => onTrigger("random_discover")}>
        DISCOVER
      </button>
    </div>
  );

  const renderThemeToggle = (variant: "overlay" | "inline" = "overlay") => (
    <div className={`theme-topbar ${variant === "inline" ? "theme-topbar-inline" : ""}`}>
      <button
        onClick={() => setTheme("dark")}
        className={`theme-toggle ${theme === "dark" ? "theme-toggle-active" : ""}`}
      >
        DARK
      </button>
      <button
        onClick={() => setTheme("light")}
        className={`theme-toggle ${theme === "light" ? "theme-toggle-active" : ""}`}
      >
        LIGHT
      </button>
    </div>
  );

  const renderDisplayModeToggle = () => (
    <div className="display-toggle-group">
      <button
        onClick={() => setDisplayMode("playlist")}
        className={`display-toggle display-toggle-list ${displayMode === "playlist" ? "display-toggle-active" : ""}`}
      >
        LIST
      </button>
      <button
        onClick={() => setDisplayMode("clock")}
        className={`display-toggle display-toggle-clock ${displayMode === "clock" ? "display-toggle-active" : ""}`}
      >
        CLOCK
      </button>
    </div>
  );

  const renderSettingsMenu = () => {
    if (!isSettingsOpen) return null;

    if (settingsPanel === "theme") {
      return (
        <div className="settings-menu-popover">
          <button className="settings-menu-back" onClick={() => setSettingsPanel("root")}>
            BACK
          </button>
          <div className="settings-menu-section">
            {renderThemeToggle("inline")}
          </div>
        </div>
      );
    }

    if (settingsPanel === "display") {
      return (
        <div className="settings-menu-popover">
          <button className="settings-menu-back" onClick={() => setSettingsPanel("root")}>
            BACK
          </button>
          <div className="settings-menu-section">
            {renderDisplayModeToggle()}
          </div>
        </div>
      );
    }

    if (settingsPanel === "audio") {
      return (
        <div className="settings-menu-popover">
          <button className="settings-menu-back" onClick={() => setSettingsPanel("root")}>
            BACK
          </button>
          <div className="settings-menu-section">
            <div className="settings-choice-stack">
              {AUDIO_EFFECT_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  className={`settings-choice-item ${audioEffect === option.id ? "settings-choice-item-active" : ""}`}
                  onClick={() => setAudioEffect(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="settings-menu-popover">
        <div className="settings-menu-section">
          <button
            className="settings-menu-item"
            onClick={() => {
              avatarInputRef.current?.click();
              setIsSettingsOpen(false);
              setSettingsPanel("root");
            }}
          >
            UPLOAD AVATAR
          </button>
          <button className="settings-menu-item" onClick={() => setSettingsPanel("theme")}>
            THEME
          </button>
          <button className="settings-menu-item" onClick={() => setSettingsPanel("display")}>
            VIEW MODE
          </button>
          <button className="settings-menu-item" onClick={() => setSettingsPanel("audio")}>
            AUDIO FX
          </button>
          <button className="settings-menu-item" onClick={onSyncLibrary} disabled={isSyncingLibrary}>
            {isSyncingLibrary ? "SYNCING..." : "SYNC LIBRARY"}
          </button>
        </div>
      </div>
    );
  };

  const renderCompactStatus = () => {
    if ((status === "idle" || status === "playing") && !utilityNotice) return null;

    return (
      <div className="flex flex-wrap items-center gap-2">
        {status === "thinking" && <div className="thinking-spinner"></div>}
        {status === "speaking" && <div className="speaking-pulse"></div>}
        {(status === "thinking" || status === "speaking") && (
          <span className="text-[10px] uppercase tracking-[0.18em] claudio-theme-text-dim">
            {statusText}
          </span>
        )}
        {utilityNotice && (
          <span className="text-[10px] uppercase tracking-[0.18em] claudio-theme-accent">
            {utilityNotice}
          </span>
        )}
      </div>
    );
  };

  const renderDockProgress = () => (
    <div className="player-dock-progress" onClick={handleProgressClick}>
      <div className="player-dock-progress-rail">
        <div className="player-dock-progress-fill" style={{ width: `${progressPercent}%` }}></div>
        <div className="player-dock-progress-thumb" style={{ left: `${progressPercent}%` }}></div>
      </div>
    </div>
  );

  const renderPlaybackControls = () => (
    <div className="flex flex-wrap items-center justify-center gap-3 player-dock-controls">
      <button onClick={onPrevious} className="ctrl-btn w-9 h-9 rounded-full border border-[#2a2a35] flex items-center justify-center text-[#a1a1aa] hover:border-[#a1a1aa] hover:text-white transition-colors">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 6v12h2V6H7zm10 12l-7-6 7-6v12z" />
        </svg>
      </button>

      <button onClick={onPlayPause} className="ctrl-btn play-btn w-11 h-11 rounded-full border border-[#2a2a35] flex items-center justify-center text-[#a1a1aa] hover:border-[#a1a1aa] hover:text-white transition-colors">
        {playerState.isPlaying ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="ml-1">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      <button onClick={onNext} className="ctrl-btn w-9 h-9 rounded-full border border-[#2a2a35] flex items-center justify-center text-[#a1a1aa] hover:border-[#a1a1aa] hover:text-white transition-colors">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M15 6v12h2V6h-2zM5 18l7-6-7-6v12z" />
        </svg>
      </button>

      <button
        onClick={() => playerState.currentTrack && onToggleFavorite(currentTrackId ?? playerState.currentTrack.url)}
        className={`ctrl-btn w-9 h-9 rounded-full border flex items-center justify-center transition-colors ml-2 ${
          currentTrackFavorited
            ? "border-[color:var(--claudio-accent)] text-[color:var(--claudio-accent)] neon-border"
            : "border-[#2a2a35] text-[#a1a1aa] hover:border-[color:var(--claudio-accent)] hover:text-[color:var(--claudio-accent)]"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={currentTrackFavorited ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>
      </button>
    </div>
  );

  const renderUtilityControls = () => (
    <div className="utility-minimal" ref={settingsMenuRef}>
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void onUserAvatarUpload(file);
          event.target.value = "";
        }}
      />
      <button
        onClick={() => {
          setIsSettingsOpen((prev) => {
            const next = !prev;
            if (next) setSettingsPanel("root");
            return next;
          });
        }}
        className="ctrl-btn utility-compact-btn text-[#a1a1aa] hover:text-white transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V22a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.57 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H2a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.57-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H8a1.7 1.7 0 0 0 1.04-1.56V2a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.11 1.57 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V8c0 .68.4 1.3 1.04 1.56.17.07.35.11.53.11H22a2 2 0 1 1 0 4h-.09c-.68 0-1.3.4-1.57 1.04Z" />
        </svg>
      </button>
      {renderSettingsMenu()}
      <button onClick={togglePlayerFullscreen} className="ctrl-btn utility-compact-btn text-[#a1a1aa] hover:text-white transition-colors">
        {isFullscreen ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
          </svg>
        )}
      </button>
    </div>
  );

  const renderDockVolume = () => (
    <div className="player-dock-volume">
      <span className="claudio-theme-text-dim text-xs font-bold tracking-wider">VOL</span>
      <div
        ref={volumeTrackRef}
        className="volume-slider volume-slider-draggable relative h-4 w-[110px] flex items-center cursor-pointer group"
        onPointerDown={handleVolumePointerDown}
        onPointerMove={handleVolumePointerMove}
        onPointerUp={handleVolumePointerEnd}
        onPointerCancel={handleVolumePointerEnd}
      >
        <div className="absolute w-full h-[2px] bg-[color:var(--claudio-border)] rounded-full overflow-hidden">
          <div className="h-full bg-[color:var(--claudio-text-strong)] transition-all duration-150" style={{ width: `${playerState.volume * 100}%` }}></div>
        </div>
        <div className="absolute w-3 h-3 bg-[color:var(--claudio-text-strong)] rounded-full shadow-[0_0_10px_rgba(255,255,255,0.24)] transition-all duration-150 group-hover:scale-125" style={{ left: `calc(${playerState.volume * 100}% - 6px)` }}></div>
      </div>
    </div>
  );

  const renderPlayerDock = () => (
    <div className="player-dock-shell border-t claudio-theme-border claudio-bottom-bar">
      {renderDockProgress()}
      <div className="mx-auto flex h-[72px] w-full max-w-5xl items-center px-6">
        <div className="player-dock-grid w-full">
          <div className="flex min-w-0 flex-1 basis-[220px] items-center gap-4">
            {renderVisualizer("compact")}
            <div className="min-w-0 flex flex-col">
              <span className="claudio-theme-text-strong truncate font-medium">
                {playerState.currentTrack?.title || "Unknown Title"}
              </span>
              <div className="player-dock-meta">
                <span className="truncate">{playerState.currentTrack?.artist || "Unknown Artist"}</span>
                <span className="h-1 w-1 rounded-full bg-[color:var(--claudio-border)]"></span>
                <span className="flex-shrink-0">{formatPlaybackTime(playerState.currentTime)}</span>
                <span className="flex-shrink-0">/</span>
                <span className="flex-shrink-0">{formatPlaybackTime(playerState.duration)}</span>
              </div>
            </div>
          </div>

          <div className="flex justify-center">
            {renderPlaybackControls()}
          </div>

          <div className="flex justify-end">
            {renderDockVolume()}
          </div>
        </div>
      </div>
    </div>
  );

  const renderEmptyState = () => (
    <div className="relative w-full h-full flex flex-col claudio-grid-bg claudio-theme-bg claudio-theme-text p-8">
      {renderThemeToggle()}
      <div className="flex flex-col items-center justify-center pt-10 pb-8">
        <div className="pixel-clock flex flex-col items-center gap-4 mb-6">
          <div className="flex items-center gap-3">
            <span className="w-3 h-3 rounded-full bg-[#4ade80] neon-glow pulse-dot"></span>
            <span className="claudio-theme-accent font-bold tracking-widest uppercase text-sm">ON AIR</span>
          </div>
          <PixelClock
            value={now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            dotSize={11}
            gap={4}
            className="drop-shadow-[0_0_18px_rgba(255,255,255,0.08)]"
          />
          <div className="flex items-center gap-4 claudio-theme-text-dim font-medium text-lg uppercase tracking-wider">
            <span>{formatDateLabel(now)}</span>
            <span className="w-1 h-1 rounded-full claudio-theme-border claudio-theme-surface-strong"></span>
            <span>{formatMonthDayLabel(now)}</span>
          </div>
        </div>

        <div className="mb-6 flex w-full max-w-3xl items-center justify-between rounded-[20px] border claudio-theme-border bg-[color:var(--claudio-surface-strong)] px-5 py-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] claudio-theme-text-muted">SIGNAL</div>
            <div className="mt-2 text-sm claudio-theme-text-strong">{librarySignalText}</div>
          </div>
          {renderVisualizer("wide")}
        </div>

        <button
          onClick={onSyncLibrary}
          disabled={isSyncingLibrary}
          className="sync-pill mb-6"
        >
          {isSyncingLibrary ? "SYNCING..." : "SYNC LIBRARY"}
        </button>

        {renderTriggerPills()}
      </div>

      <div className="flex items-center justify-between pt-2 pb-4">
        {renderPanelTabs()}
        {utilityNotice && (
          <span className="text-[10px] uppercase tracking-[0.18em] claudio-theme-accent">
            {utilityNotice}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto claudio-scrollbar">
        <div className="max-w-4xl mx-auto pb-10">
          {activeView === "list" && renderListView()}
          {activeView === "favorites" && renderFavoritesView()}
          {activeView === "taste" && renderTasteView()}
        </div>
      </div>
    </div>
  );

  const renderPanelTabs = () => (
    <div className="flex items-center gap-2">
      {[
        { id: "list" as const, label: "LIST" },
        { id: "favorites" as const, label: "FAV" },
        { id: "taste" as const, label: "TASTE" },
      ].map((item) => (
        <button
          key={item.id}
          onClick={() => setActiveView(item.id)}
          className={`mode-chip ${activeView === item.id ? "mode-chip-active" : ""}`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  const renderFeedbackControls = () => {
    const currentTrack = playerState.currentTrack;
    const feedbackItems: Array<{ type: TrackFeedbackType; label: string }> = [
      { type: "more_like_this", label: "多来点这种" },
      { type: "less_like_this", label: "少放这种" },
      { type: "dislike_track", label: "不喜欢这首" },
    ];
    const feedbackLabel = (type: TrackFeedbackType) =>
      type === "more_like_this" ? "MORE"
        : type === "less_like_this" ? "LESS"
          : type === "dislike_track" ? "NOPE"
            : type === "favorite_track" ? "FAV"
              : type === "complete_track" ? "DONE"
                : type === "skip_track" ? "SKIP"
                  : type === "replay_dj" ? "REPLAY" : "ASK";

    return (
      <section className="panel-card">
        <div className="panel-card-head">
          <span>FEEDBACK</span>
          <span>{userFeedback.length}</span>
        </div>
        <div className="flex flex-wrap gap-3">
          {feedbackItems.map((item) => (
            <button
              key={item.type}
              type="button"
              className="sync-pill"
              disabled={!currentTrack}
              onClick={() => onTrackFeedback(item.type)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {!currentTrack ? (
          <div className="panel-empty mt-4">No active track to tag yet</div>
        ) : userFeedback.length === 0 ? (
          <div className="panel-empty mt-4">No feedback recorded yet</div>
        ) : (
          <div className="mt-4 grid md:grid-cols-2 gap-3">
            {userFeedback.slice(0, 4).map((item) => (
              <div key={item.id} className="insight-row">
                <div className="flex flex-col min-w-0">
                  <span className="truncate text-sm claudio-theme-text-strong">{item.title}</span>
                  <span className="truncate text-xs text-[#71717a]">{item.artist}</span>
                </div>
                <span className="text-[10px] uppercase claudio-theme-accent">{feedbackLabel(item.type)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  };

  const renderDiscoveryCandidates = () => {
    const readyCount = discoveryCandidates.filter((item) => item.health === "ready").length;
    const discoveryStatus = discoveryCandidates.length === 0
      ? "EMPTY"
      : `${readyCount}/${discoveryCandidates.length} READY`;
    const riskLabel = (risk: DiscoveryCandidateRecord["risk"]) =>
      risk === "small_adventure" ? "ADVENTURE" : "ADJACENT";
    const riskClass = (risk: DiscoveryCandidateRecord["risk"]) =>
      risk === "small_adventure" ? "text-[#facc15]" : "claudio-theme-accent";
    const healthClass = (health: DiscoveryCandidateRecord["health"]) =>
      health === "ready" ? "claudio-theme-accent" : "text-[color:var(--claudio-danger)]";

    return (
      <section className="panel-card">
        <div className="panel-card-head">
          <span>DISCOVERY CANDIDATES</span>
          <span>{discoveryStatus}</span>
        </div>
        {discoveryCandidates.length === 0 ? (
          <div className="panel-empty">No verified discoveries yet</div>
        ) : (
          <div className="grid md:grid-cols-2 gap-3">
            {discoveryCandidates.slice(0, 4).map((item) => (
              <div key={item.id} className="insight-row items-start">
                <div className="flex flex-col min-w-0 gap-1">
                  <span className="truncate text-sm claudio-theme-text-strong">
                    {item.title} - {item.artist}
                  </span>
                  <span className="text-xs text-[#71717a] leading-relaxed break-words">
                    {item.direction || item.query}
                    {" · "}
                    {item.reason}
                  </span>
                  <span className="truncate text-[10px] uppercase claudio-theme-text-muted">
                    {formatHistoryTime(item.createdAt)}
                    {item.urlSource ? ` · ${formatSourceName(item.urlSource)}` : ""}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`text-[10px] uppercase ${riskClass(item.risk)}`}>
                    {riskLabel(item.risk)}
                  </span>
                  <span className={`text-[10px] uppercase ${healthClass(item.health)}`}>
                    {item.health}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  };

  const renderListView = () => (
    <div className="flex flex-col gap-6">
      {renderFeedbackControls()}
      {renderDiscoveryCandidates()}

      <section className="panel-card">
        <div className="panel-card-head">
          <span>QUEUE</span>
          <div className="flex items-center gap-3">
            {playerState.playlist.length > 3 && (
              <button className="queue-toggle" onClick={() => setIsQueueExpanded((prev) => !prev)}>
                {isQueueExpanded ? "COLLAPSE" : "EXPAND"}
              </button>
            )}
            <span>{playerState.queueCount} TRACKS</span>
          </div>
        </div>
        <div className="relative">
          <div className="queue-section-body">
            <div className="flex flex-col gap-3">
              {playerState.playlist.length === 0 ? (
                <div className="panel-empty">Queue is empty</div>
              ) : (
                (isQueueExpanded ? orderedPlaylist : orderedPlaylist.slice(0, 3)).map((track) => {
                  const isSelected = track.isPlaying;
                  return (
                    <div
                      key={track.id}
                      onClick={() => onSelectTrack(track.id)}
                      className={`queue-row ${isSelected ? "queue-row-active" : ""}`}
                    >
                      <div className="queue-row-icon">
                        {isSelected ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="neon-glow claudio-theme-accent">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </div>

                      <div className="flex flex-col flex-1 min-w-0">
                        <span className={`truncate text-sm font-medium ${isSelected ? "claudio-theme-text-strong" : "claudio-theme-text"}`}>
                          {track.title}
                        </span>
                        <span className={`truncate text-xs ${isSelected ? "text-[#a1a1aa]" : "text-[#71717a]"}`}>
                          {track.artist}
                        </span>
                      </div>

                      {track.album && (
                        <div className="hidden md:block flex-1 truncate text-xs text-[#71717a]">
                          {track.album}
                        </div>
                      )}

                      <div className="text-xs text-[#71717a]">
                        {formatTrackDuration(track.duration)}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          {!isQueueExpanded && playerState.playlist.length > 3 && <div className="queue-scroll-fade"></div>}
        </div>
      </section>

      <section className="panel-card">
        <div className="panel-card-head">
          <span>RECENT</span>
          <div className="flex items-center gap-3">
            {playHistory.length > 3 && (
              <button className="queue-toggle" onClick={() => setIsRecentExpanded((prev) => !prev)}>
                {isRecentExpanded ? "COLLAPSE" : "EXPAND"}
              </button>
            )}
            <span>{playHistory.length}</span>
          </div>
        </div>
        <div className="relative">
          <div className="queue-section-body">
            <div className="flex flex-col gap-3">
              {playHistory.length === 0 ? (
                <div className="panel-empty">No play history yet</div>
              ) : (
                (isRecentExpanded ? playHistory.slice(0, 12) : playHistory.slice(0, 3)).map((entry, index) => (
                  <div key={`${entry.playedAt}_${index}`} className="queue-row queue-row-static">
                    <div className="queue-row-icon">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                    <div className="flex flex-col flex-1 min-w-0">
                      <span className="truncate text-sm claudio-theme-text-strong">{entry.title}</span>
                      <span className="truncate text-xs text-[#71717a]">{entry.artist}</span>
                    </div>
                    <span className="text-[10px] text-[#71717a]">{formatHistoryTime(entry.playedAt)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
          {!isRecentExpanded && playHistory.length > 3 && <div className="queue-scroll-fade"></div>}
        </div>
      </section>
    </div>
  );

  const renderPlaylistStage = () => (
    <div className="list-stage-shell">
      <div className="playlist-stage-header">
        <div className="flex items-center justify-between gap-4">
          {renderPanelTabs()}
          <span className="text-[10px] font-bold tracking-[0.2em] uppercase claudio-theme-text-muted">
            {activeView === "list" ? "QUEUE / RECENT" : activeView === "favorites" ? "FAVORITES" : "TASTE / AUDIT"}
          </span>
        </div>
        <div className="flex items-center justify-between pt-3">
          <span className="text-[10px] claudio-theme-text-dim">
            {activeView === "list"
              ? `${playerState.queueCount} TRACKS`
              : activeView === "favorites"
                ? `${favoriteTracks.length} SAVED`
                : tasteProfile ? `${tasteProfile.uniqueArtistCount} ARTISTS` : "NO PROFILE"}
          </span>
          {utilityNotice && (
            <span className="text-[10px] uppercase tracking-[0.18em] claudio-theme-accent">
              {utilityNotice}
            </span>
          )}
        </div>
      </div>

      <div ref={listStageScrollRef} className="list-stage-body-scroll claudio-scrollbar">
        <div className="playlist-stage-body">
          {activeView === "list" && renderListView()}
          {activeView === "favorites" && renderFavoritesView()}
          {activeView === "taste" && renderTasteView()}
        </div>
      </div>
    </div>
  );

  const renderClockStage = () => (
    <div className="clock-stage-shell">
      <div className="clock-stage-center">
        <div className="flex flex-col items-center gap-6">
          <div className="pixel-clock flex flex-col items-center gap-5">
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 rounded-full bg-[#4ade80] neon-glow pulse-dot"></span>
              <span className="claudio-theme-accent font-bold tracking-widest uppercase text-sm">ON AIR</span>
            </div>
            <PixelClock
              value={now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
              dotSize={11}
              gap={4}
              className="drop-shadow-[0_0_18px_rgba(255,255,255,0.08)]"
            />
            <div className="flex items-center gap-4 claudio-theme-text-dim font-medium text-lg uppercase tracking-wider">
              <span>{formatDateLabel(now)}</span>
              <span className="w-1 h-1 rounded-full claudio-theme-border claudio-theme-surface-strong"></span>
              <span>{formatMonthDayLabel(now)}</span>
            </div>
          </div>
          {renderTriggerPills()}
        </div>
      </div>
    </div>
  );

  const renderFavoritesView = () => (
    <section className="panel-card">
      <div className="panel-card-head">
        <span>FAVORITES</span>
        <span>{favoriteTracks.length}</span>
      </div>
      <div className="flex flex-col gap-3">
        {favoriteTracks.length === 0 ? (
          <div className="panel-empty">No favorites yet</div>
        ) : (
          favoriteTracks.map((track) => (
            <div key={track.id} className={`queue-row ${track.isResolved ? "" : "opacity-60"}`}>
              <button
                onClick={() => track.isResolved && onPlaySavedTrack(track.id)}
                className="queue-row-icon disabled:opacity-40"
                disabled={!track.isResolved}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
              <div className="flex flex-col flex-1 min-w-0">
                <span className="truncate text-sm claudio-theme-text-strong">{track.title}</span>
                <span className="truncate text-xs text-[#71717a]">{track.artist}</span>
              </div>
              {track.album && (
                <div className="hidden md:block flex-1 truncate text-xs text-[#71717a]">
                  {track.album}
                </div>
              )}
              <button
                onClick={() => onToggleFavorite(track.id)}
                className="text-[#4ade80] hover:text-white transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );

  const renderTasteView = () => {
    const failedCount = lastSyncSummary?.failedPlaylists.length ?? 0;
    const languageMix = tasteProfile?.languageMix ?? { chinese: 0, latin: 0, mixed: 0, other: 0 };
    const totalTracks = tasteProfile?.totalTrackCount ?? 0;
    const runtimeTaste = tasteProfile?.runtimeTaste;
    const sourceStatusLabel = musicSourceStatus
      ? musicSourceStatus.sources.some((source) => source.enabled && !source.ok) ? "CHECK" : "READY"
      : "STANDBY";
    const sourceStatusClass = musicSourceStatus
      ? musicSourceStatus.sources.some((source) => source.enabled && !source.ok) ? "text-[#facc15]" : "claudio-theme-accent"
      : "claudio-theme-text-muted";
    const searchOrderLabel = musicSourceStatus?.searchOrder.length
      ? musicSourceStatus.searchOrder.map(formatSourceName).join(" > ")
      : "--";
    const fallbackLabel = musicSourceStatus?.playableUrlFallbacks
      .flatMap((item) => item.fallbacks.map((fallback) => `${formatSourceName(item.source)} > ${formatSourceName(fallback)}`))
      .join(" / ") || "--";
    const activeLocalLibraryStatus = localLibraryStatus?.enabled ? localLibraryStatus : null;
    const localStatusLabel = localLibraryStatus?.enabled
      ? localLibraryStatus.trackCount > 0 ? "READY" : "EMPTY"
      : "STANDBY";
    const localMatchLabel = localLibraryMatchStatus
      ? localLibraryMatchStatus.profileAvailable
        ? `${localLibraryMatchStatus.coveragePercent}%`
        : "NO PROFILE"
      : "--";
    const localMatchStatusClass = localLibraryMatchStatus?.profileAvailable
      ? localLibraryMatchStatus.matchedCount > 0 ? "claudio-theme-accent" : "text-[#facc15]"
      : "claudio-theme-text-muted";
    const programAuditLabel = programAudit
      ? programAudit.ok ? "READY" : "CHECK"
      : "STANDBY";
    const programAuditIssueCount = programAudit?.issues.length ?? 0;
    const programAuditStatusClass = programAudit?.ok
      ? "claudio-theme-accent"
      : programAuditIssueCount > 0 ? "text-[#f87171]" : "claudio-theme-text-muted";
    const programAuditChecks = programAudit?.issues.length
      ? programAudit.issues
      : programAudit?.checks.slice(0, 4) ?? [];
    const rawListenElapsedMs = listenCheck.startedAt
      ? listenCheck.playbackMs
      : 0;
    const listenElapsedMs = Math.min(rawListenElapsedMs, LISTEN_CHECK_TARGET_MS);
    const listenProgressPercent = Math.round((listenElapsedMs / LISTEN_CHECK_TARGET_MS) * 100);
    const listenCheckedCount = LISTEN_CHECK_ITEMS.filter((item) => listenCheck.checks[item.id]).length;
    const listenReady = Boolean(listenCheck.startedAt && rawListenElapsedMs >= LISTEN_CHECK_TARGET_MS);
    const currentAudioSignalLabel = typeof playerState.audioSignalLevel === "number"
      ? `${Math.round(playerState.audioSignalLevel * 100)}%`
      : "--";
    const currentAudioSignalClass = typeof playerState.audioSignalLevel === "number"
      ? playerState.audioSignalLevel <= LISTEN_SIGNAL_SILENCE_LEVEL ? "text-[#facc15]" : "claudio-theme-accent"
      : "claudio-theme-text-muted";
    const listenComplete = Boolean(listenCheck.completedAt)
      || (listenReady && listenCheckedCount === LISTEN_CHECK_ITEMS.length);
    const listenAuditReady = programAudit?.ok === true;
    const listenCheckLabel = listenComplete
      ? "DONE"
      : listenCheck.startedAt ? listenReady ? "READY" : "RUNNING" : "STANDBY";
    const listenCheckStatusClass = listenComplete
      ? "claudio-theme-accent"
      : listenCheck.startedAt ? "claudio-theme-accent" : "claudio-theme-text-muted";
    const listenAcceptanceLabel = listenAcceptance
      ? listenAcceptance.ready ? "READY" : listenAcceptance.status === "needs_review" ? "REVIEW" : "WAITING"
      : "WAITING";
    const listenAcceptanceStatusClass = listenAcceptance?.ready
      ? "claudio-theme-accent"
      : listenAcceptance?.status === "needs_review" ? "text-[#facc15]" : "claudio-theme-text-muted";
    const listenCheckLocked = Boolean(listenCheck.completedAt || listenCheck.savedRecordId);
    const listenConfirmEnabled = Boolean(listenCheck.startedAt && listenReady && !listenCheckLocked);
    const listenProgramLocked = Boolean(listenCheck.programSessionId || listenCheck.programGeneratedAt);
    const hasListenDraft = Boolean(
      listenCheck.startedAt
        || listenCheck.playbackMs > 0
        || listenCheckedCount > 0
        || listenCheck.note.trim()
        || listenCheck.needsFollowUp,
    );
    const startListenCheck = () => {
      if (!listenAuditReady) return;
      const programGeneratedAt = programAudit?.program?.generatedAt;
      const startedAt = Date.now();
      const currentTrackKey = playerState.currentTrack?.id ?? playerState.currentTrack?.url ?? null;
      const currentPositionSec = Number.isFinite(playerState.currentTime)
        ? Math.max(0, playerState.currentTime)
        : 0;
      const isPlaybackActive = playerState.isPlaying && Boolean(currentTrackKey);
      setListenCheck({
        ...createEmptyListenCheck(),
        startedAt,
        lastPlaybackTickAt: isPlaybackActive ? startedAt : null,
        lastPlaybackTrackKey: currentTrackKey,
        lastPlaybackPositionSec: currentTrackKey ? currentPositionSec : null,
        programSessionId: programAudit?.program?.sessionId ?? null,
        programGeneratedAt: typeof programGeneratedAt === "number" ? programGeneratedAt : null,
        programTitle: programAudit?.program?.title ?? null,
      });
    };
    const resetListenCheck = () => {
      setListenCheck(createEmptyListenCheck());
    };
    const toggleListenCheck = (id: ListenCheckId) => {
      if (!listenConfirmEnabled) return;
      setListenCheck((current) => {
        const nextChecks = {
          ...current.checks,
          [id]: !current.checks[id],
        };
        const allChecksPassed = LISTEN_CHECK_ITEMS.every((item) => nextChecks[item.id]);
        return {
          ...current,
          completedAt: allChecksPassed && current.playbackMs >= LISTEN_CHECK_TARGET_MS
            ? Date.now()
            : null,
          checks: nextChecks,
          savedRecordId: null,
        };
      });
    };
    const updateListenNote = (note: string) => {
      setListenCheck((current) => ({
        ...current,
        note: note.slice(0, 500),
      }));
    };
    const toggleListenFollowUp = () => {
      setListenCheck((current) => ({
        ...current,
        needsFollowUp: !current.needsFollowUp,
        savedRecordId: current.savedRecordId,
      }));
    };
    const formatListenRecordTime = (timestamp: number) =>
      `${new Date(timestamp).toLocaleDateString([], { month: "short", day: "2-digit" })} ${formatHistoryTime(timestamp)}`;
    const getRecordPlaybackMs = (record: ListenCheckRecord) =>
      typeof record.playbackMs === "number" ? record.playbackMs : record.durationMs;
    const countRecordChecks = (record: ListenCheckRecord) =>
      LISTEN_CHECK_ITEMS.filter((item) => record.checks[item.id]).length;
    const hasCleanListenRecord = (record: ListenCheckRecord) =>
      record.programAudit?.issueCount === 0
        && countRecordChecks(record) === LISTEN_CHECK_ITEMS.length
        && record.needsFollowUp !== true
        && record.programContinuity?.ok === true;
    const getRecordStatusLabel = (record: ListenCheckRecord) => {
      if (record.needsFollowUp) return "follow-up";
      if (record.programContinuity?.ok === false) return "program changed";
      if (!record.programContinuity) return "no session";
      return `${record.programAudit?.issueCount ?? 0} issues`;
    };
    const latestAcceptanceRecord = listenAcceptance?.latestRecord;
    const acceptanceTargetMs = (listenAcceptance?.targetMinutes ?? 20) * 60_000;
    const latestAcceptancePlaybackMs = latestAcceptanceRecord?.playbackMs ?? 0;
    const latestAcceptanceMissingMs = latestAcceptanceRecord
      ? Math.max(
          0,
          typeof latestAcceptanceRecord.missingPlaybackMs === "number"
            ? latestAcceptanceRecord.missingPlaybackMs
            : acceptanceTargetMs - latestAcceptancePlaybackMs,
        )
      : 0;
    const latestAcceptanceCheckCount = latestAcceptanceRecord?.checkCount ?? 0;
    const latestAcceptanceAuditLabel = latestAcceptanceRecord
      ? latestAcceptanceRecord.programAuditOk === true && latestAcceptanceRecord.issueCount === 0
        ? "OK"
        : latestAcceptanceRecord.issueCount === null ? "--" : String(latestAcceptanceRecord.issueCount)
      : "--";
    const latestAcceptanceAuditClass = latestAcceptanceRecord
      ? latestAcceptanceRecord.programAuditOk === true && latestAcceptanceRecord.issueCount === 0
        ? "claudio-theme-accent"
        : "text-[#facc15]"
      : "claudio-theme-text-muted";
    const latestAcceptanceSessionLabel = latestAcceptanceRecord
      ? latestAcceptanceRecord.programContinuityOk === true
        ? "OK"
        : latestAcceptanceRecord.programContinuityOk === false ? "CHANGE" : "--"
      : "--";
    const latestAcceptanceSessionClass = latestAcceptanceRecord
      ? latestAcceptanceRecord.programContinuityOk === true ? "claudio-theme-accent" : "text-[#facc15]"
      : "claudio-theme-text-muted";
    const latestAcceptanceFollowUpClass = latestAcceptanceRecord?.needsFollowUp
      ? "text-[#facc15]"
      : latestAcceptanceRecord ? "claudio-theme-accent" : "claudio-theme-text-muted";
    const latestAcceptanceIssueClass = latestAcceptanceRecord
      ? latestAcceptanceRecord.playbackIssueCount === 0 ? "claudio-theme-accent" : "text-[#facc15]"
      : "claudio-theme-text-muted";
    const latestAcceptanceDiscoveryClass = latestAcceptanceRecord
      ? (latestAcceptanceRecord.discoveryCount ?? 0) > 0 ? "claudio-theme-accent" : "text-[#facc15]"
      : "claudio-theme-text-muted";
    const latestAcceptanceFeedbackClass = latestAcceptanceRecord
      ? (latestAcceptanceRecord.feedbackCount ?? 0) > 0 ? "claudio-theme-accent" : "text-[#facc15]"
      : "claudio-theme-text-muted";
    const latestAcceptanceSignalClass = latestAcceptanceRecord
      ? (latestAcceptanceRecord.clientSignalSampleCount ?? 0) > 0 ? "claudio-theme-accent" : "text-[#facc15]"
      : "claudio-theme-text-muted";
    const latestAcceptanceSilenceClass = latestAcceptanceRecord
      ? (latestAcceptanceRecord.clientMaxSilentRunMs ?? 0) <= 10_000 ? "claudio-theme-accent" : "text-[#facc15]"
      : "claudio-theme-text-muted";
    const currentPlaybackDiagnostic = playbackDiagnostics?.current ?? null;
    const playbackProblem = playbackDiagnostics
      ? [playbackDiagnostics.current, ...playbackDiagnostics.upcoming].some((track) =>
          track && (track.health === "failed" || track.health === "expired" || track.shouldRefresh),
        )
      : false;
    const playbackDiagnosticsLabel = playbackDiagnostics
      ? playbackProblem ? "CHECK" : "READY"
      : "STANDBY";
    const playbackDiagnosticsClass = playbackDiagnostics
      ? playbackProblem ? "text-[#facc15]" : "claudio-theme-accent"
      : "claudio-theme-text-muted";
    const playbackSourceLabel = (track?: PlaybackDiagnosticTrack | null) => {
      if (!track) return "--";
      const primary = track.source ? formatSourceName(track.source) : "--";
      const resolved = track.urlSource ? formatSourceName(track.urlSource) : primary;
      return primary === resolved ? resolved : `${primary} > ${resolved}`;
    };
    const playbackHealthClass = (health?: PlaybackDiagnosticTrack["health"]) =>
      health === "ready" || health === "fallback"
        ? "claudio-theme-accent"
        : health === "refreshing" ? "text-[#facc15]" : "text-[#f87171]";
    const recentPlaybackIssue = playbackDiagnostics?.recentIssue
      ?? currentPlaybackDiagnostic?.lastPlaybackIssue
      ?? currentPlaybackDiagnostic?.lastResolveError;
    const renderRuntimeSignals = (
      signals: NonNullable<TasteProfile["runtimeTaste"]>["likedArtists"],
      emptyLabel: string,
    ) => (
      signals.length === 0 ? (
        <div className="panel-empty">{emptyLabel}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {signals.slice(0, 5).map((signal) => (
            <div key={signal.key} className="insight-row">
              <div className="flex flex-col min-w-0">
                <span className="truncate text-sm claudio-theme-text-strong">{signal.label}</span>
                <span className="truncate text-xs text-[#71717a]">{signal.sampleTracks.slice(0, 2).join(" · ") || "No samples"}</span>
              </div>
              <span className={signal.score >= 0 ? "text-[10px] claudio-theme-accent" : "text-[10px] text-[#f87171]"}>
                {formatRuntimeScore(signal.score)}
              </span>
            </div>
          ))}
        </div>
      )
    );

    return (
      <div className="flex flex-col gap-6">
        <section className="panel-card">
          <div className="panel-card-head">
            <span>PROGRAM AUDIT</span>
            <span className={programAuditStatusClass}>{programAuditLabel}</span>
          </div>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="stat-card">
              <span className="stat-label">MINUTES</span>
              <span className="stat-value">{programAudit?.plannedMinutes ?? 0}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">TRACKS</span>
              <span className="stat-value">{programAudit?.trackCount ?? 0}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">SPEECH</span>
              <span className="stat-value">{programAudit?.speechSlotCount ?? 0}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">ISSUES</span>
              <span className={`stat-value ${programAuditStatusClass}`}>{programAuditIssueCount}</span>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            {!programAudit ? (
              <div className="panel-empty">No program audit yet</div>
            ) : programAuditChecks.length === 0 ? (
              <div className="panel-empty">Audit clear</div>
            ) : (
              programAuditChecks.map((check) => (
                <div key={check.id} className="insight-row items-start">
                  <div className="flex flex-col min-w-0 gap-1">
                    <span className="truncate text-sm claudio-theme-text-strong">{check.label}</span>
                    <span className="text-xs text-[#71717a] leading-relaxed break-words">{check.detail}</span>
                  </div>
                  <span className={`text-[10px] uppercase ${
                    check.status === "pass"
                      ? "claudio-theme-accent"
                      : check.status === "warning" ? "text-[#facc15]" : "text-[#f87171]"
                  }`}>
                    {check.status}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="mt-5 border-t claudio-theme-border pt-4">
            <div className="panel-card-head">
              <span>LISTEN CHECK</span>
              <span className={listenCheckStatusClass}>{listenCheckLabel}</span>
            </div>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
              <div className="stat-card">
                <span className="stat-label">PLAYED</span>
                <span className="stat-value">{formatPlaybackTime(Math.floor(listenElapsedMs / 1000))}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">TARGET</span>
                <span className="stat-value">20:00</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">CHECKS</span>
                <span className="stat-value">{listenCheckedCount}/{LISTEN_CHECK_ITEMS.length}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">READY</span>
                <span className={`stat-value ${listenReady ? "claudio-theme-accent" : "claudio-theme-text-muted"}`}>
                  {listenReady ? "YES" : "NO"}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">SESSION</span>
                <span className={`stat-value ${listenProgramLocked ? "claudio-theme-accent" : "claudio-theme-text-muted"}`}>
                  {listenProgramLocked ? "LOCKED" : "--"}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">SIGNAL</span>
                <span className={`stat-value ${currentAudioSignalClass}`}>{currentAudioSignalLabel}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">SILENCE</span>
                <span className={`stat-value ${listenCheck.maxSilentRunMs > 10_000 ? "text-[#facc15]" : "claudio-theme-text-muted"}`}>
                  {formatPlaybackTime(Math.floor(listenCheck.maxSilentRunMs / 1000))}
                </span>
              </div>
            </div>
            {listenCheck.programTitle && (
              <div className="panel-empty mt-4">
                Locked program: {listenCheck.programTitle}
              </div>
            )}
            <div className="mt-4 h-[5px] overflow-hidden rounded-full bg-[color:var(--claudio-border)]">
              <div
                className="h-full bg-[color:var(--claudio-accent)] transition-all duration-300"
                style={{ width: `${listenProgressPercent}%` }}
              ></div>
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button className="sync-pill" onClick={startListenCheck} disabled={!listenAuditReady}>
                {listenCheck.startedAt ? "RESTART" : "START 20 MIN"}
              </button>
              <button
                className="sync-pill"
                onClick={resetListenCheck}
                disabled={!hasListenDraft}
              >
                RESET
              </button>
              {listenCheck.savedRecordId && (
                <span className="sync-pill pointer-events-none">SAVED</span>
              )}
            </div>
            {!listenAuditReady && (
              <div className="panel-empty mt-4">
                Program audit must be clear before a 20-minute listen check can start
              </div>
            )}
            <div className="mt-4 grid md:grid-cols-3 gap-3">
              {LISTEN_CHECK_ITEMS.map((item) => {
                const checked = listenCheck.checks[item.id];
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggleListenCheck(item.id)}
                    disabled={!listenConfirmEnabled}
                    className={`insight-row text-left transition-colors ${
                      checked ? "border-[color:var(--claudio-accent)]" : ""
                    }`}
                  >
                    <span className="truncate text-sm claudio-theme-text-strong">{item.label}</span>
                    <span className={`text-[10px] uppercase ${checked ? "claudio-theme-accent" : "claudio-theme-text-muted"}`}>
                      {checked ? "PASS" : "OPEN"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-4 flex flex-col gap-3">
              <button
                type="button"
                onClick={toggleListenFollowUp}
                className={`insight-row text-left transition-colors ${
                  listenCheck.needsFollowUp ? "border-[#facc15]" : ""
                }`}
                disabled={!listenCheck.startedAt || listenCheckLocked}
              >
                <span className="truncate text-sm claudio-theme-text-strong">FOLLOW-UP NEEDED</span>
                <span className={`text-[10px] uppercase ${
                  listenCheck.needsFollowUp ? "text-[#facc15]" : "claudio-theme-text-muted"
                }`}>
                  {listenCheck.needsFollowUp ? "YES" : "NO"}
                </span>
              </button>
              <textarea
                value={listenCheck.note}
                onChange={(event) => updateListenNote(event.target.value)}
                disabled={!listenCheck.startedAt || listenCheckLocked}
                maxLength={500}
                rows={3}
                className="claudio-input min-h-[82px] resize-none px-4 py-3 text-sm leading-relaxed"
                placeholder="Notes after the 20-minute listen"
              />
            </div>
            <div className="mt-5 flex flex-col gap-3">
              <div className="panel-card-head mb-0">
                <span>ACCEPTANCE</span>
                <span className={listenAcceptanceStatusClass}>{listenAcceptanceLabel}</span>
              </div>
              {listenAcceptance && (
                <div className="mt-3">
                  {latestAcceptanceRecord ? (
                    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                      <div className="stat-card">
                        <span className="stat-label">LATEST</span>
                        <span className="stat-value">
                          {formatPlaybackTime(Math.floor(latestAcceptancePlaybackMs / 1000))}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">MISSING</span>
                        <span className={`stat-value ${latestAcceptanceMissingMs === 0 ? "claudio-theme-accent" : "text-[#facc15]"}`}>
                          {formatPlaybackTime(Math.floor(latestAcceptanceMissingMs / 1000))}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">CHECKS</span>
                        <span className={`stat-value ${
                          latestAcceptanceCheckCount === LISTEN_CHECK_ITEMS.length ? "claudio-theme-accent" : "text-[#facc15]"
                        }`}>
                          {latestAcceptanceCheckCount}/{LISTEN_CHECK_ITEMS.length}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">AUDIT</span>
                        <span className={`stat-value ${latestAcceptanceAuditClass}`}>{latestAcceptanceAuditLabel}</span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">SESSION</span>
                        <span className={`stat-value ${latestAcceptanceSessionClass}`}>{latestAcceptanceSessionLabel}</span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">FOLLOW</span>
                        <span className={`stat-value ${latestAcceptanceFollowUpClass}`}>
                          {latestAcceptanceRecord.needsFollowUp ? "YES" : "NO"}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">ISSUES</span>
                        <span className={`stat-value ${latestAcceptanceIssueClass}`}>
                          {latestAcceptanceRecord.playbackIssueCount ?? "--"}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">DISC</span>
                        <span className={`stat-value ${latestAcceptanceDiscoveryClass}`}>
                          {latestAcceptanceRecord.discoveryCount ?? "--"}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">FB</span>
                        <span className={`stat-value ${latestAcceptanceFeedbackClass}`}>
                          {latestAcceptanceRecord.feedbackCount ?? "--"}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">FALLBACK</span>
                        <span className="stat-value">{latestAcceptanceRecord.fallbackCount ?? "--"}</span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">SIGNAL</span>
                        <span className={`stat-value ${latestAcceptanceSignalClass}`}>
                          {latestAcceptanceRecord.clientSignalSampleCount ?? "--"}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-label">SILENCE</span>
                        <span className={`stat-value ${latestAcceptanceSilenceClass}`}>
                          {formatPlaybackTime(Math.floor((latestAcceptanceRecord.clientMaxSilentRunMs ?? 0) / 1000))}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="panel-empty">No saved listen evidence yet</div>
                  )}
                </div>
              )}
              {!listenAcceptance ? (
                <div className="panel-empty">No acceptance summary yet</div>
              ) : (
                listenAcceptance.criteria.map((criterion) => (
                  <div key={criterion.id} className="insight-row items-start">
                    <div className="flex flex-col min-w-0 gap-1">
                      <span className="text-sm claudio-theme-text-strong leading-relaxed break-words">
                        {criterion.planText}
                      </span>
                      <span className="text-xs text-[#71717a] leading-relaxed break-words">{criterion.detail}</span>
                      {criterion.evidence && (
                        <span className="text-xs text-[#71717a] leading-relaxed break-words">
                          {formatListenRecordTime(criterion.evidence.recordedAt)}
                          {" · "}
                          {formatPlaybackTime(Math.floor(criterion.evidence.playbackMs / 1000))}
                          {criterion.evidence.note ? ` · ${criterion.evidence.note}` : ""}
                        </span>
                      )}
                    </div>
                    <span className={`text-[10px] uppercase ${
                      criterion.passed ? "claudio-theme-accent" : "claudio-theme-text-muted"
                    }`}>
                      {criterion.passed ? "PASS" : "OPEN"}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="mt-5 flex flex-col gap-3">
              <div className="panel-card-head mb-0">
                <span>RECENT LISTENS</span>
                <span>{listenCheckRecords.length}</span>
              </div>
              {listenCheckRecords.length === 0 ? (
                <div className="panel-empty">No saved listen checks yet</div>
              ) : (
                listenCheckRecords.map((record) => (
                  <div key={record.id} className="insight-row">
                    <div className="flex flex-col min-w-0 gap-1">
                      <span className="truncate text-sm claudio-theme-text-strong">
                        {record.programSnapshot?.title || formatListenRecordTime(record.recordedAt)}
                      </span>
                      <span className="truncate text-xs text-[#71717a]">
                        {record.programSnapshot?.title ? `${formatListenRecordTime(record.recordedAt)} · ` : ""}
                        {formatPlaybackTime(Math.floor(getRecordPlaybackMs(record) / 1000))}
                        {" · "}
                        {countRecordChecks(record)}/{LISTEN_CHECK_ITEMS.length} checks
                        {" · "}
                        {record.playbackSegments?.length ?? 0} tracks
                        {" · "}
                        {record.programAudit?.plannedMinutes ?? 0} min
                      </span>
                      {record.listenEvidence && (
                        <span className="truncate text-xs text-[#71717a]">
                          evidence: {record.listenEvidence.playbackIssueCount} issues
                          {" / "}
                          {record.listenEvidence.discoveryCount} discovery
                          {" / "}
                          {record.listenEvidence.feedbackCount} feedback
                          {" / "}
                          {record.listenEvidence.fallbackCount} fallback
                          {" / "}
                          signal {record.listenEvidence.clientSignalSampleCount ?? "--"}
                          {" / "}
                          silence {formatPlaybackTime(Math.floor((record.listenEvidence.clientMaxSilentRunMs ?? 0) / 1000))}
                        </span>
                      )}
                      {record.playbackSegments?.length ? (
                        <span className="truncate text-xs text-[#71717a]">
                          {record.playbackSegments.slice(0, 3).map((segment) =>
                            `${segment.title} - ${segment.artist} ${formatPlaybackTime(Math.floor(segment.playedMs / 1000))}`,
                          ).join(" / ")}
                        </span>
                      ) : record.programSnapshot?.tracks.length ? (
                        <span className="truncate text-xs text-[#71717a]">
                          {record.programSnapshot.tracks.slice(0, 3).map((track) => `${track.name} - ${track.artist}`).join(" / ")}
                        </span>
                      ) : null}
                      {record.note && (
                        <span className="text-xs text-[#71717a] leading-relaxed break-words">{record.note}</span>
                      )}
                    </div>
                    <span className={`text-[10px] uppercase ${
                      hasCleanListenRecord(record)
                        ? "claudio-theme-accent"
                        : "text-[#facc15]"
                    }`}>
                      {getRecordStatusLabel(record)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="panel-card">
          <div className="panel-card-head">
            <span>MUSIC SOURCES</span>
            <span className={sourceStatusClass}>{sourceStatusLabel}</span>
          </div>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="stat-card">
              <span className="stat-label">SEARCH</span>
              <span className="stat-value text-base leading-tight break-words">{searchOrderLabel}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">FALLBACK</span>
              <span className="stat-value text-base leading-tight break-words">{fallbackLabel}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">SOURCES</span>
              <span className="stat-value">{musicSourceStatus?.sources.length ?? 0}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">CHECKED</span>
              <span className="stat-value">{formatScanTime(musicSourceStatus?.generatedAt)}</span>
            </div>
          </div>
          {!musicSourceStatus ? (
            <div className="panel-empty mt-4">No source status yet</div>
          ) : (
            <div className="mt-4 grid md:grid-cols-3 gap-3">
              {musicSourceStatus.sources.map((source) => (
                <div key={source.source} className="insight-row items-start">
                  <div className="flex flex-col min-w-0 gap-1">
                    <span className="truncate text-sm claudio-theme-text-strong">{formatSourceName(source.source)}</span>
                    <span className="text-xs text-[#71717a] leading-relaxed break-words">
                      {source.message || source.displayName}
                    </span>
                  </div>
                  <span className={`text-[10px] uppercase ${
                    !source.enabled
                      ? "claudio-theme-text-muted"
                      : source.ok ? "claudio-theme-accent" : "text-[#facc15]"
                  }`}>
                    {!source.enabled ? "off" : source.ok ? source.role : "check"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel-card">
          <div className="panel-card-head">
            <span>PLAYBACK DIAGNOSTICS</span>
            <span className={playbackDiagnosticsClass}>{playbackDiagnosticsLabel}</span>
          </div>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="stat-card">
              <span className="stat-label">CURRENT</span>
              <span className="stat-value text-base leading-tight break-words">
                {currentPlaybackDiagnostic ? playbackSourceLabel(currentPlaybackDiagnostic) : "--"}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">LEASE</span>
              <span className="stat-value">{formatLeaseTime(currentPlaybackDiagnostic?.urlTtlMs)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">HEALTH</span>
              <span className={`stat-value ${playbackHealthClass(currentPlaybackDiagnostic?.health)}`}>
                {currentPlaybackDiagnostic?.health.toUpperCase() ?? "--"}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">CHECKED</span>
              <span className="stat-value">{formatScanTime(playbackDiagnostics?.generatedAt)}</span>
            </div>
          </div>
          {!playbackDiagnostics ? (
            <div className="panel-empty mt-4">No playback diagnostics yet</div>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              {currentPlaybackDiagnostic && (
                <div className="insight-row items-start">
                  <div className="flex flex-col min-w-0 gap-1">
                    <span className="truncate text-sm claudio-theme-text-strong">
                      Now: {currentPlaybackDiagnostic.name}
                    </span>
                    <span className="text-xs text-[#71717a] leading-relaxed break-words">
                      {currentPlaybackDiagnostic.artist} · {playbackSourceLabel(currentPlaybackDiagnostic)} · {currentPlaybackDiagnostic.leaseStatus}
                    </span>
                  </div>
                  <span className={`text-[10px] uppercase ${playbackHealthClass(currentPlaybackDiagnostic.health)}`}>
                    {currentPlaybackDiagnostic.health}
                  </span>
                </div>
              )}
              {playbackDiagnostics.upcoming.length === 0 ? (
                <div className="panel-empty">No upcoming queue diagnostics</div>
              ) : (
                playbackDiagnostics.upcoming.slice(0, 3).map((track) => (
                  <div key={`${track.queueIndex}-${track.id}`} className="insight-row items-start">
                    <div className="flex flex-col min-w-0 gap-1">
                      <span className="truncate text-sm claudio-theme-text-strong">
                        #{track.queueIndex + 1} {track.name}
                      </span>
                      <span className="text-xs text-[#71717a] leading-relaxed break-words">
                        {playbackSourceLabel(track)} · lease {formatLeaseTime(track.urlTtlMs)} · {track.leaseStatus}
                      </span>
                    </div>
                    <span className={`text-[10px] uppercase ${playbackHealthClass(track.health)}`}>
                      {track.health}
                    </span>
                  </div>
                ))
              )}
              {recentPlaybackIssue && (
                <div className="panel-empty">
                  Last issue: {recentPlaybackIssue.code} · {recentPlaybackIssue.message}
                </div>
              )}
            </div>
          )}
        </section>

        {activeLocalLibraryStatus && (
          <section className="panel-card">
            <div className="panel-card-head">
              <span>LOCAL LIBRARY</span>
              <span>{localStatusLabel}</span>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={onRescanLocalLibrary}
                disabled={isRescanningLocalLibrary}
                className="sync-pill"
              >
                {isRescanningLocalLibrary ? "SCANNING..." : "RESCAN"}
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 xl:grid-cols-5 gap-3">
              <div className="stat-card">
                <span className="stat-label">TRACKS</span>
                <span className="stat-value">{activeLocalLibraryStatus.trackCount}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">DIRS</span>
                <span className="stat-value">
                  {`${activeLocalLibraryStatus.availableDirectoryCount}/${activeLocalLibraryStatus.configuredDirectoryCount}`}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">LIMIT</span>
                <span className="stat-value">{activeLocalLibraryStatus.maxFiles}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">SCANNED</span>
                <span className="stat-value">{formatScanTime(activeLocalLibraryStatus.scannedAt)}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">MATCH</span>
                <span className={`stat-value ${localMatchStatusClass}`}>{localMatchLabel}</span>
              </div>
            </div>
            {localLibraryMatchStatus && (
              <div className="mt-4">
                <div className="text-xs text-[#71717a] leading-relaxed">
                  {localLibraryMatchStatus.profileAvailable
                    ? `${localLibraryMatchStatus.matchedCount}/${localLibraryMatchStatus.targetCount} taste tracks matched locally`
                    : localLibraryMatchStatus.message}
                </div>
                {localLibraryMatchStatus.samples.length > 0 && (
                  <div className="mt-3 grid md:grid-cols-2 gap-3">
                    {localLibraryMatchStatus.samples.slice(0, 4).map((sample) => (
                      <div key={`${sample.title}-${sample.artist}`} className="insight-row">
                        <div className="flex flex-col min-w-0">
                          <span className="truncate text-sm claudio-theme-text-strong">{sample.title}</span>
                          <span className="truncate text-xs text-[#71717a]">
                            {sample.localTrack
                              ? `${sample.localTrack.title} · ${sample.localTrack.artist}`
                              : sample.artist}
                          </span>
                        </div>
                        <span className={`text-[10px] uppercase ${sample.matched ? "claudio-theme-accent" : "text-[#facc15]"}`}>
                          {sample.matched ? "match" : "miss"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {activeLocalLibraryStatus.sampleTracks.length === 0 ? (
              <div className="panel-empty mt-4">No local tracks found</div>
            ) : (
              <div className="mt-4 grid md:grid-cols-2 gap-3">
                {activeLocalLibraryStatus.sampleTracks.slice(0, 6).map((track) => (
                  <div key={track.sourceTrackId} className="insight-row">
                    <div className="flex flex-col min-w-0">
                      <span className="truncate text-sm claudio-theme-text-strong">{track.title}</span>
                      <span className="truncate text-xs text-[#71717a]">
                        {[track.artist, track.album].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    <span className="text-[10px] claudio-theme-accent">LOCAL</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="panel-card">
          <div className="panel-card-head">
            <span>TASTE PROFILE</span>
            <span>{tasteProfile ? "READY" : "EMPTY"}</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <button onClick={onSyncLibrary} disabled={isSyncingLibrary} className="sync-pill">
              {isSyncingLibrary ? "SYNCING..." : "SYNC"}
            </button>
            <button
              onClick={onRetryFailedSync}
              disabled={isSyncingLibrary || failedCount === 0}
              className="sync-pill"
            >
              RETRY FAILED
            </button>
          </div>
          {lastSyncSummary && (
            <div className="mt-4 text-xs text-[#71717a]">
              Last sync: {formatHistoryTime(lastSyncSummary.syncedAt)} · {lastSyncSummary.playlistCount} playlists · {lastSyncSummary.totalTrackCount} tracks
            </div>
          )}
          {!tasteProfile ? (
            <div className="panel-empty mt-4">No taste profile yet. Sync your library first.</div>
          ) : (
            <div className="mt-4 grid grid-cols-2 xl:grid-cols-4 gap-3">
              <div className="stat-card">
                <span className="stat-label">PLAYLISTS</span>
                <span className="stat-value">{tasteProfile.playlistCount}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">TRACKS</span>
                <span className="stat-value">{tasteProfile.totalTrackCount}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">ARTISTS</span>
                <span className="stat-value">{tasteProfile.uniqueArtistCount}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">ALBUMS</span>
                <span className="stat-value">{tasteProfile.uniqueAlbumCount}</span>
              </div>
            </div>
          )}
        </section>

        {tasteProfile && (
          <>
            <section className="panel-card">
              <div className="panel-card-head">
                <span>LANGUAGE MIX</span>
                <span>{totalTracks}</span>
              </div>
              <div className="flex flex-col gap-3">
                {[
                  ["CHINESE", languageMix.chinese],
                  ["LATIN", languageMix.latin],
                  ["MIXED", languageMix.mixed],
                  ["OTHER", languageMix.other],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center gap-3">
                    <span className="taste-mix-label w-16 text-[10px] tracking-[0.18em]">{label}</span>
                    <div className="taste-mix-track flex-1 h-[5px] rounded-full overflow-hidden">
                      <div className="taste-mix-fill h-full" style={{ width: `${toPercent(Number(value), totalTracks)}%` }}></div>
                    </div>
                    <span className="taste-mix-value w-10 text-right text-[10px]">{toPercent(Number(value), totalTracks)}%</span>
                  </div>
                ))}
              </div>
            </section>

            {runtimeTaste && (
              <section className="panel-card">
                <div className="panel-card-head">
                  <span>RUNTIME TASTE</span>
                  <span>{runtimeTaste.effectiveFeedbackCount}/{runtimeTaste.feedbackCount}</span>
                </div>
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
                  <div className="stat-card">
                    <span className="stat-label">LIKE</span>
                    <span className="stat-value">{runtimeTaste.likedArtists.length}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">LESS</span>
                    <span className="stat-value">{runtimeTaste.avoidedArtists.length}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">ENERGY</span>
                    <span className="stat-value">{runtimeTaste.likedEnergy.length + runtimeTaste.avoidedEnergy.length}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">MOOD</span>
                    <span className="stat-value">{runtimeTaste.likedMoods.length + runtimeTaste.avoidedMoods.length}</span>
                  </div>
                </div>
                <div className="grid md:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.18em] claudio-theme-accent mb-2">Positive</div>
                      {renderRuntimeSignals([
                        ...runtimeTaste.likedArtists,
                        ...runtimeTaste.languageSignals.filter((signal) => signal.score > 0),
                        ...runtimeTaste.likedEnergy,
                        ...runtimeTaste.likedMoods,
                      ], "No positive runtime signals")}
                    </div>
                  </div>
                  <div className="flex flex-col gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-[#f87171] mb-2">Pull Back</div>
                      {renderRuntimeSignals([
                        ...runtimeTaste.avoidedArtists,
                        ...runtimeTaste.languageSignals.filter((signal) => signal.score < 0),
                        ...runtimeTaste.avoidedEnergy,
                        ...runtimeTaste.avoidedMoods,
                      ], "No pull-back signals")}
                    </div>
                  </div>
                </div>
              </section>
            )}

            <section className="panel-card">
              <div className="panel-card-head">
                <span>TOP ARTISTS</span>
                <span>{tasteProfile.topArtists.length}</span>
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                {tasteProfile.topArtists.slice(0, 10).map((artist) => (
                  <div key={artist.name} className="insight-row">
                    <div className="flex flex-col min-w-0">
                      <span className="truncate text-sm claudio-theme-text-strong">{artist.name}</span>
                      <span className="truncate text-xs text-[#71717a]">{artist.sampleTracks.slice(0, 2).join(" · ") || "No samples"}</span>
                    </div>
                    <span className="text-[10px] claudio-theme-accent">{artist.count}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel-card">
              <div className="panel-card-head">
                <span>TOP ALBUMS</span>
                <span>{tasteProfile.topAlbums.length}</span>
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                {tasteProfile.topAlbums.slice(0, 10).map((album) => (
                  <div key={`${album.artist}-${album.name}`} className="insight-row">
                    <div className="flex flex-col min-w-0">
                      <span className="truncate text-sm claudio-theme-text-strong">{album.name}</span>
                      <span className="truncate text-xs text-[#71717a]">{album.artist}</span>
                    </div>
                    <span className="text-[10px] claudio-theme-accent">{album.count}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel-card">
              <div className="panel-card-head">
                <span>SUMMARY</span>
                <span>{new Date(tasteProfile.generatedAt).toLocaleDateString()}</span>
              </div>
              <pre className="summary-block">{tasteProfile.summary}</pre>
            </section>
          </>
        )}
      </div>
    );
  };

  if (!playerState.playlist || playerState.playlist.length === 0) {
    return renderEmptyState();
  }

  return (
    <div className="relative w-full h-full flex flex-col claudio-grid-bg claudio-theme-bg claudio-theme-text font-sans">
      <div className="relative px-6 pt-5">
        <div className="max-w-4xl mx-auto w-full">
          <div className={`flex min-w-0 flex-col gap-2 ${displayMode === "playlist" ? "playlist-topbar" : ""}`}>
            <div className={`flex flex-wrap items-start gap-4 ${displayMode === "clock" ? "opacity-0 pointer-events-none h-0 overflow-hidden" : ""}`}>
              <div className="playlist-clock-anchor">
                <div className="playlist-clock-stack">
                  <PixelClock
                    value={now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                    dotSize={9}
                    gap={2}
                    className="drop-shadow-[0_0_10px_rgba(0,0,0,0.05)]"
                  />
                  <div className="playlist-clock-meta">
                    <span>{formatDateLabel(now)}</span>
                    <span className="h-1 w-1 rounded-full claudio-theme-surface-strong claudio-theme-border"></span>
                    <span>{formatMonthDayLabel(now)}</span>
                  </div>
                  {weatherBadge && (
                    <div className="playlist-weather-badge">
                      <span>{weatherBadge.emoji}</span>
                      <span>{weatherBadge.summary}</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="pt-2">
                {renderCompactStatus()}
              </div>
            </div>
          </div>
        </div>
        <div className="absolute right-6 top-5">
          {renderUtilityControls()}
        </div>
      </div>

      <div className={`flex-1 p-6 ${displayMode === "playlist" ? "overflow-hidden" : ""}`}>
        <div className={`max-w-4xl mx-auto ${displayMode === "playlist" ? "h-full" : "pb-10"}`}>
          {displayMode === "playlist" ? renderPlaylistStage() : renderClockStage()}
        </div>
      </div>

      {renderPlayerDock()}
    </div>
  );
};

export default PlayerPanel;
