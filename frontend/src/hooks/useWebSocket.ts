import { useState, useEffect, useCallback, useRef } from "react";
import { normalizeVoicePreset } from "../types";
import { PcmSpeechPlayer } from "../pcm-speech";
import type {
  AppStatus,
  ChatEntry,
  DiscoveryCandidateRecord,
  DjProfile,
  DJMessage,
  ListenAcceptanceSummary,
  ListenCheckRecord,
  LocalLibraryStatus,
  LocalLibraryTasteMatchSummary,
  MusicSourceRuntimeStatus,
  PlaybackDiagnostics,
  PlayHistoryEntry,
  ProgramExperienceAudit,
  SyncSummary,
  TasteProfile,
  TrackFeedbackType,
  TtsPreset,
  UserFeedbackRecord,
  WSMessage,
  TrackInfo,
  PlayerState,
  PlaylistTrack,
  TriggerMode,
  WSStatusPayload,
  WSDJMessagePayload,
  WSTrackPayload,
  WSChatPayload,
  WSSeguePayload,
  WSTtsChunkPayload,
  WSTtsCompletePayload,
} from "../types";

const USER_DISPLAY_NAME = "xian";
const DJ_DISPLAY_NAME = "CLAUDIO";
const USER_AVATAR_STORAGE_KEY = "claudio-user-avatar";
const MUSIC_FADE_MS = 420;
const TTS_DUCK_RATIO = 0.34;
const PRELOAD_READY_STATE = 2;
const AUDIO_SIGNAL_STATE_INTERVAL_MS = 500;
const AUDIO_SILENCE_RECOVERY_LEVEL = 0.006;
const AUDIO_SILENCE_RECOVERY_MIN_VOLUME = 0.05;
const AUDIO_SILENCE_RECOVERY_MS = 8_000;
const AUDIO_SILENCE_RECOVERY_COOLDOWN_MS = 12_000;

type SpeechStream = {
  id: string;
  text: string;
  player?: PcmSpeechPlayer;
  started: boolean;
};

function resolveSpeechUrl(cachePath?: string): string | undefined {
  const filename = cachePath?.split(/[/\\]/).pop();
  return filename ? `/api/audio/tts/${filename}` : undefined;
}

function chatEntryKey(entry: Pick<ChatEntry, "role" | "text" | "timestamp">): string {
  return JSON.stringify([entry.timestamp, entry.role, entry.text]);
}

type QueueStepReason = "manual_skip" | "track_complete";
type QueueStepPayload = {
  reason?: QueueStepReason;
  trackId?: string;
  title?: string;
  artist?: string;
  positionSec?: number;
  durationSec?: number;
};

type ClientPlaybackIssueCode = "client_silent_audio" | "audio_error";

const getTrackPlaybackKey = (track?: Pick<TrackInfo, "id" | "url"> | Pick<PlaylistTrack, "id" | "url"> | null) =>
  track?.id || track?.url || "";

function positiveDuration(duration?: number): number | undefined {
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function normalizeTrackDuration(duration?: number): number | undefined {
  const value = positiveDuration(duration);
  // NetEase sends milliseconds. Older saved queues can contain seconds.
  return value && value > 1000 ? value / 1000 : value;
}

export function useWebSocket() {
  const [hasHydratedState, setHasHydratedState] = useState(false);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [djMessages, setDjMessages] = useState<DJMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [subtitle, setSubtitle] = useState("");
  const [subtitleFading, setSubtitleFading] = useState(false);
  const [visualizerBars, setVisualizerBars] = useState<number[]>(Array.from({ length: 20 }, () => 0.08));
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [playHistory, setPlayHistory] = useState<PlayHistoryEntry[]>([]);
  const [userFeedback, setUserFeedback] = useState<UserFeedbackRecord[]>([]);
  const [discoveryCandidates, setDiscoveryCandidates] = useState<DiscoveryCandidateRecord[]>([]);
  const [tasteProfile, setTasteProfile] = useState<TasteProfile | null>(null);
  const [isSyncingLibrary, setIsSyncingLibrary] = useState(false);
  const [isUpdatingVoicePreset, setIsUpdatingVoicePreset] = useState(false);
  const [lastSyncSummary, setLastSyncSummary] = useState<SyncSummary | null>(null);
  const [musicSourceStatus, setMusicSourceStatus] = useState<MusicSourceRuntimeStatus | null>(null);
  const [playbackDiagnostics, setPlaybackDiagnostics] = useState<PlaybackDiagnostics | null>(null);
  const [localLibraryStatus, setLocalLibraryStatus] = useState<LocalLibraryStatus | null>(null);
  const [localLibraryMatchStatus, setLocalLibraryMatchStatus] = useState<LocalLibraryTasteMatchSummary | null>(null);
  const [programAudit, setProgramAudit] = useState<ProgramExperienceAudit | null>(null);
  const [listenCheckRecords, setListenCheckRecords] = useState<ListenCheckRecord[]>([]);
  const [listenAcceptance, setListenAcceptance] = useState<ListenAcceptanceSummary | null>(null);
  const [isRescanningLocalLibrary, setIsRescanningLocalLibrary] = useState(false);
  const [utilityNotice, setUtilityNotice] = useState<string | null>(null);
  const [djProfile, setDjProfile] = useState<DjProfile | null>(null);
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(USER_AVATAR_STORAGE_KEY);
  });
  const [playerState, setPlayerState] = useState<PlayerState>({
    currentTrack: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    audioSignalLevel: null,
    playlist: [],
    queueCount: 0,
    status: "idle",
    isOnAir: false,
  });

  const audioRef = useRef<HTMLAudioElement>(null);
  const nextAudioRef = useRef<HTMLAudioElement>(null);
  const ttsAudioRef = useRef<HTMLAudioElement>(null);
  const speechStreamRef = useRef<SpeechStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ttsPlayingRef = useRef(false);
  const prefetchedTrackKeyRef = useRef<string | null>(null);
  const activeMusicAudioRef = useRef<HTMLAudioElement | null>(null);
  const outgoingMusicAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackAttemptRef = useRef(0);
  const audioRecoveryRef = useRef<{ trackKey?: string; url?: string; attempts: number }>({ attempts: 0 });
  const silentAudioRecoveryRef = useRef<{
    trackKey?: string;
    url?: string;
    lastPositionSec: number | null;
    silentRunMs: number;
    lastActionAt: number;
  }>({
    lastPositionSec: null,
    silentRunMs: 0,
    lastActionAt: 0,
  });
  const userVolumeRef = useRef(0.8);
  const audioFadesRef = useRef(new Map<HTMLAudioElement, { frame: number; finish: () => void }>());
  const playerStateRef = useRef(playerState);
  const favoriteIdsRef = useRef<string[]>([]);
  const trackCatalogRef = useRef<Map<string, TrackInfo>>(new Map());
  const utilityNoticeTimerRef = useRef<number | null>(null);
  const subtitleFadeTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaSourcesRef = useRef<WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>>(new WeakMap());
  const analyserNodesRef = useRef<WeakMap<HTMLAudioElement, AnalyserNode>>(new WeakMap());
  const visualizerFrameRef = useRef<number | null>(null);
  const lastAudioSignalStateAtRef = useRef(0);
  const [, setCatalogVersion] = useState(0);

  const todayTime = () =>
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const formatClockTime = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const toPlayableUrl = useCallback((url: string) => {
    if (url.startsWith("/api/audio/")) return url;
    return `/api/audio/music?url=${encodeURIComponent(url)}`;
  }, []);

  const showUtilityNotice = useCallback((text: string) => {
    setUtilityNotice(text);
    if (utilityNoticeTimerRef.current !== null) {
      window.clearTimeout(utilityNoticeTimerRef.current);
    }
    utilityNoticeTimerRef.current = window.setTimeout(() => {
      setUtilityNotice(null);
    }, 2400);
  }, []);

  const clearSubtitleFadeTimer = useCallback(() => {
    if (subtitleFadeTimerRef.current !== null) {
      window.clearTimeout(subtitleFadeTimerRef.current);
      subtitleFadeTimerRef.current = null;
    }
  }, []);

  const showSubtitle = useCallback((text: string) => {
    clearSubtitleFadeTimer();
    setSubtitle(text);
    setSubtitleFading(false);
  }, [clearSubtitleFadeTimer]);

  const hideSubtitle = useCallback((fade = true) => {
    clearSubtitleFadeTimer();
    if (!fade) {
      setSubtitle("");
      setSubtitleFading(false);
      return;
    }

    setSubtitleFading(true);
    subtitleFadeTimerRef.current = window.setTimeout(() => {
      setSubtitle("");
      setSubtitleFading(false);
      subtitleFadeTimerRef.current = null;
    }, 900);
  }, [clearSubtitleFadeTimer]);

  const getActiveMusicAudio = useCallback(() => {
    if (!activeMusicAudioRef.current && audioRef.current) {
      activeMusicAudioRef.current = audioRef.current;
    }
    return activeMusicAudioRef.current ?? audioRef.current;
  }, []);

  const getStandbyMusicAudio = useCallback(() => {
    return getActiveMusicAudio() === audioRef.current ? nextAudioRef.current : audioRef.current;
  }, [getActiveMusicAudio]);

  const getEffectiveMusicVolume = useCallback(() => (
    userVolumeRef.current * (ttsPlayingRef.current ? TTS_DUCK_RATIO : 1)
  ), []);

  const fadeAudioVolume = useCallback((
    audio: HTMLAudioElement,
    targetVolume: number,
    duration = MUSIC_FADE_MS,
    onComplete?: () => void,
  ) => {
    const fades = audioFadesRef.current;
    const previousFade = fades.get(audio);
    if (previousFade) {
      window.cancelAnimationFrame(previousFade.frame);
      fades.delete(audio);
    }

    const boundedTarget = Math.min(1, Math.max(0, targetVolume));
    // Background tabs suspend animation frames, including one that would raise music from zero.
    if (document.hidden || duration <= 0 || audio.volume === boundedTarget) {
      audio.volume = boundedTarget;
      onComplete?.();
      return;
    }

    const startVolume = audio.volume;
    const startedAt = performance.now();
    const finish = () => {
      window.cancelAnimationFrame(fade.frame);
      fades.delete(audio);
      audio.volume = boundedTarget;
      onComplete?.();
    };
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      if (progress < 1) {
        audio.volume = startVolume + ((boundedTarget - startVolume) * progress);
        fade.frame = window.requestAnimationFrame(step);
      } else {
        finish();
      }
    };

    const fade = { frame: window.requestAnimationFrame(step), finish };
    fades.set(audio, fade);
  }, []);

  const applyActiveMusicVolume = useCallback((duration = 180) => {
    const active = getActiveMusicAudio();
    if (active) {
      fadeAudioVolume(active, getEffectiveMusicVolume(), duration);
    }
  }, [fadeAudioVolume, getActiveMusicAudio, getEffectiveMusicVolume]);

  useEffect(() => {
    const fades = audioFadesRef.current;
    const onVisibilityChange = () => {
      if (!document.hidden) return;
      for (const fade of [...fades.values()]) fade.finish();
      applyActiveMusicVolume(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const fade of fades.values()) window.cancelAnimationFrame(fade.frame);
      fades.clear();
    };
  }, [applyActiveMusicVolume]);

  const releaseMusicAudio = useCallback((audio: HTMLAudioElement) => {
    fadeAudioVolume(audio, 0, 0);
    audio.pause();
    audio.removeAttribute("src");
    delete audio.dataset.loadedUrl;
    delete audio.dataset.playbackKey;
    delete audio.dataset.preloadKey;
    audio.load();
  }, [fadeAudioVolume]);

  const finishTrackTransition = useCallback(() => {
    const outgoing = outgoingMusicAudioRef.current;
    if (!outgoing) return;
    outgoingMusicAudioRef.current = null;
    releaseMusicAudio(outgoing);
  }, [releaseMusicAudio]);

  const findNextPlaylistTrack = useCallback((): PlaylistTrack | null => {
    const state = playerStateRef.current;
    const playlist = state.playlist;
    if (!state.currentTrack || playlist.length <= 1) {
      return null;
    }

    const currentKey = getTrackPlaybackKey(state.currentTrack);
    const currentIndex = playlist.findIndex((track) => track.id === currentKey);
    if (currentIndex === -1) {
      return null;
    }

    const nextTrack = playlist[(currentIndex + 1) % playlist.length];
    if (!nextTrack || getTrackPlaybackKey(nextTrack) === currentKey) {
      return null;
    }

    return nextTrack;
  }, []);

  const preloadNextPlaylistTrack = useCallback(() => {
    if (outgoingMusicAudioRef.current) return;
    const active = getActiveMusicAudio();
    if (active?.dataset.playbackKey !== getTrackPlaybackKey(playerStateRef.current.currentTrack)) return;

    const standby = getStandbyMusicAudio();
    const nextTrack = findNextPlaylistTrack();
    if (!standby || !nextTrack?.url) {
      return;
    }

    const key = getTrackPlaybackKey(nextTrack);
    if (standby.dataset.preloadKey === key && standby.dataset.loadedUrl === nextTrack.url) {
      return;
    }

    standby.pause();
    standby.volume = 0;
    delete standby.dataset.playbackKey;
    standby.dataset.preloadKey = key;
    standby.dataset.loadedUrl = nextTrack.url;
    standby.src = nextTrack.url;
  }, [findNextPlaylistTrack, getActiveMusicAudio, getStandbyMusicAudio]);

  const rememberTrack = useCallback((track: TrackInfo) => {
    const next = new Map(trackCatalogRef.current);
    let changed = false;
    if (track.id) {
      const existing = next.get(track.id);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(track)) {
        next.set(track.id, track);
        changed = true;
      }
    }
    const urlKey = `url:${track.url}`;
    const existingByUrl = next.get(urlKey);
    if (!existingByUrl || JSON.stringify(existingByUrl) !== JSON.stringify(track)) {
      next.set(urlKey, track);
      changed = true;
    }
    if (changed) {
      trackCatalogRef.current = next;
      setCatalogVersion((v) => v + 1);
    }
  }, []);

  const normalizeTrack = useCallback((data: Partial<WSTrackPayload> & { url: string; artist: string }) => {
    const title = data.title ?? data.name ?? "Unknown Title";
    const proxiedUrl = toPlayableUrl(data.url);
    return {
      id: data.id ? String(data.id) : `${title}_${data.artist}`,
      title,
      artist: data.artist,
      album: data.album,
      url: proxiedUrl,
      duration: normalizeTrackDuration(data.duration),
    };
  }, [toPlayableUrl]);

  const playMusic = useCallback((track: TrackInfo, autoplay = true) => {
    const active = getActiveMusicAudio();
    if (!active) return;
    const attempt = ++playbackAttemptRef.current;
    finishTrackTransition();
    const { id, url } = track;
    const trackKey = getTrackPlaybackKey(track);
    const recovery = audioRecoveryRef.current;
    if (recovery.trackKey !== trackKey || recovery.url !== url) {
      audioRecoveryRef.current = { trackKey, url, attempts: 0 };
    }

    prefetchedTrackKeyRef.current = null;
    const standby = getStandbyMusicAudio();
    const preloaded = autoplay && standby?.dataset.preloadKey === trackKey
      && standby.dataset.loadedUrl === url && standby.readyState >= PRELOAD_READY_STATE ? standby : null;
    const audio = preloaded ?? active;
    activeMusicAudioRef.current = audio;
    outgoingMusicAudioRef.current = preloaded ? active : null;
    const mediaDuration = audio.dataset.loadedUrl === url && !audio.error
      ? positiveDuration(audio.duration)
      : undefined;

    const loadTrack = (element: HTMLAudioElement) => {
      delete element.dataset.preloadKey;
      element.dataset.playbackKey = trackKey;
      if (element.dataset.loadedUrl !== url || element.error) {
        element.dataset.loadedUrl = url;
        element.src = url;
      }
      if (element.currentTime !== 0) element.currentTime = 0;
    };
    if (!preloaded) audio.pause();
    loadTrack(audio);

    const isFavorite = id ? favoriteIdsRef.current.includes(id) : false;
    const currentTrack = { ...track, duration: mediaDuration ?? track.duration, isFavorite };
    setPlayerState((p) => {
      const queuedTrack = p.playlist.find((item) => item.id === trackKey);
      const duration = mediaDuration ?? queuedTrack?.duration ?? track.duration;
      const playlist = p.playlist.map((item) => item.id === trackKey
        ? { ...currentTrack, id: trackKey, duration, isPlaying: true }
        : { ...item, isPlaying: false });
      if (!queuedTrack) playlist.push({ ...currentTrack, id: trackKey, duration, isPlaying: true });
      return {
        ...p,
        currentTrack: { ...currentTrack, duration },
        playlist,
        queueCount: playlist.length,
        isPlaying: false,
        currentTime: 0,
        duration: duration ?? 0,
        audioSignalLevel: null,
      };
    });
    rememberTrack(currentTrack);

    if (!autoplay) return;

    const startAudio = async (element: HTMLAudioElement) => {
      fadeAudioVolume(element, document.hidden ? getEffectiveMusicVolume() : 0, 0);
      await element.play();
      if (playbackAttemptRef.current !== attempt) return;
      fadeAudioVolume(element, getEffectiveMusicVolume());
      if (outgoingMusicAudioRef.current === active) {
        fadeAudioVolume(active, 0, MUSIC_FADE_MS, () => {
          finishTrackTransition();
          preloadNextPlaylistTrack();
        });
      }
    };

    void startAudio(audio).catch(() => {
      if (playbackAttemptRef.current !== attempt || !preloaded) return;
      activeMusicAudioRef.current = active;
      outgoingMusicAudioRef.current = null;
      releaseMusicAudio(audio);
      active.pause();
      loadTrack(active);
      void startAudio(active).catch(() => {});
      preloadNextPlaylistTrack();
    });
  }, [
    fadeAudioVolume,
    finishTrackTransition,
    getActiveMusicAudio,
    getEffectiveMusicVolume,
    getStandbyMusicAudio,
    preloadNextPlaylistTrack,
    releaseMusicAudio,
    rememberTrack,
  ]);

  const requestUpcomingPrefetch = useCallback(() => {
    const ws = wsRef.current;
    const currentTrack = playerStateRef.current.currentTrack;
    preloadNextPlaylistTrack();
    if (!ws || ws.readyState !== WebSocket.OPEN || !currentTrack || playerStateRef.current.queueCount < 2) {
      return;
    }

    const prefetchKey = currentTrack.id ?? currentTrack.url;
    if (!prefetchKey || prefetchedTrackKeyRef.current === prefetchKey) {
      return;
    }

    prefetchedTrackKeyRef.current = prefetchKey;
    ws.send(JSON.stringify({ type: "queue_prefetch" }));
  }, [preloadNextPlaylistTrack]);

  const buildQueueStepPayload = useCallback((reason: QueueStepReason, audio?: HTMLAudioElement): QueueStepPayload => {
    const state = playerStateRef.current;
    const track = state.currentTrack;
    return {
      reason,
      trackId: track?.id,
      title: track?.title,
      artist: track?.artist,
      positionSec: Number.isFinite(audio?.currentTime)
        ? audio!.currentTime
        : state.currentTime,
      durationSec: Number.isFinite(audio?.duration)
        ? audio!.duration
        : state.duration,
    };
  }, []);

  const requestQueueStep = useCallback((direction: "next" | "previous", fallback: () => void, data?: QueueStepPayload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: direction === "next" ? "queue_next" : "queue_previous",
        data,
      }));
      return;
    }
    fallback();
  }, []);

  const reportClientPlaybackIssue = useCallback((code: ClientPlaybackIssueCode, message: string) => {
    const state = playerStateRef.current;
    const track = state.currentTrack;
    if (!track || wsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    wsRef.current.send(JSON.stringify({
      type: "playback_issue",
      data: {
        code,
        message,
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        positionSec: Number.isFinite(state.currentTime) ? state.currentTime : undefined,
        durationSec: Number.isFinite(state.duration) ? state.duration : undefined,
        signalLevel: typeof state.audioSignalLevel === "number" ? state.audioSignalLevel : undefined,
      },
    }));
  }, []);

  const playRelativeTrackLocally = useCallback((step: number) => {
    const pl = playerStateRef.current.playlist;
    if (pl.length === 0) return;
    const idx = pl.findIndex((t) => t.isPlaying);
    const target = pl[(idx + step + pl.length) % pl.length];
    playMusic(target);
  }, [playMusic]);

  const onNext = useCallback(() => {
    const pl = playerStateRef.current.playlist;
    if (pl.length === 0) return;
    requestQueueStep("next", () => playRelativeTrackLocally(1), buildQueueStepPayload("manual_skip", getActiveMusicAudio() ?? undefined));
  }, [buildQueueStepPayload, getActiveMusicAudio, playRelativeTrackLocally, requestQueueStep]);

  const onPrevious = useCallback(() => {
    const pl = playerStateRef.current.playlist;
    if (pl.length === 0) return;
    requestQueueStep("previous", () => playRelativeTrackLocally(-1));
  }, [playRelativeTrackLocally, requestQueueStep]);

  const handleActiveAudioFailure = useCallback((reason: "error" | "stalled" | "waiting" | "silent") => {
    const currentTrack = playerStateRef.current.currentTrack;
    const trackKey = getTrackPlaybackKey(currentTrack);
    if (!currentTrack || !trackKey) {
      return;
    }

    if (reason === "waiting" || reason === "stalled") {
      requestUpcomingPrefetch();
      return;
    }

    const recovery = audioRecoveryRef.current;
    const samePlayback = recovery.trackKey === trackKey && recovery.url === currentTrack.url;
    const attempts = samePlayback ? recovery.attempts + 1 : 1;
    audioRecoveryRef.current = {
      trackKey,
      url: currentTrack.url,
      attempts,
    };

    if (reason === "error") {
      reportClientPlaybackIssue("audio_error", "Browser audio element reported a playback error");
    } else if (reason === "silent") {
      reportClientPlaybackIssue("client_silent_audio", "Playback position advanced while browser audio signal stayed too low");
    }

    if (attempts === 1 && currentTrack.id && wsRef.current?.readyState === WebSocket.OPEN) {
      showUtilityNotice(reason === "silent" ? "Recovering silent audio" : "Refreshing audio signal");
      wsRef.current.send(JSON.stringify({ type: "queue_select", data: { trackId: currentTrack.id, forceRefresh: true } }));
      requestUpcomingPrefetch();
      return;
    }

    showUtilityNotice("Skipping unavailable track");
    requestQueueStep("next", () => playRelativeTrackLocally(1));
  }, [playRelativeTrackLocally, reportClientPlaybackIssue, requestQueueStep, requestUpcomingPrefetch, showUtilityNotice]);

  const onPlayPause = useCallback(() => {
    const a = getActiveMusicAudio();
    if (!a) return;
    const ct = playerStateRef.current.currentTrack;
    if (!ct?.url) return;
    if (a.paused) {
      applyActiveMusicVolume(0);
      void a.play().catch(console.error);
    } else {
      ++playbackAttemptRef.current;
      a.pause();
      finishTrackTransition();
      preloadNextPlaylistTrack();
    }
  }, [applyActiveMusicVolume, finishTrackTransition, getActiveMusicAudio, preloadNextPlaylistTrack]);

  const onSeek = useCallback((time: number) => {
    const active = getActiveMusicAudio();
    const duration = positiveDuration(active?.duration) ?? playerStateRef.current.duration;
    if (!active || duration <= 0 || !Number.isFinite(time)) return;
    active.currentTime = Math.max(0, Math.min(duration, time));
  }, [getActiveMusicAudio]);

  const onVolumeChange = useCallback((vol: number) => {
    userVolumeRef.current = vol;
    applyActiveMusicVolume(80);
    setPlayerState((p) => ({ ...p, volume: vol }));
  }, [applyActiveMusicVolume]);

  const onToggleFavorite = useCallback(async (trackId: string) => {
    const nextFavorited = !favoriteIdsRef.current.includes(trackId);
    const catalogTrack = trackCatalogRef.current.get(trackId) ?? trackCatalogRef.current.get(`url:${trackId}`);
    const currentTrack = playerStateRef.current.currentTrack;
    const feedbackTrack = catalogTrack ?? (
      currentTrack && (currentTrack.id === trackId || currentTrack.url === trackId)
        ? currentTrack
        : null
    );
    setFavoriteIds((prev) => nextFavorited ? [...prev, trackId] : prev.filter((id) => id !== trackId));
    setPlayerState((p) => ({
      ...p,
      currentTrack: p.currentTrack && (p.currentTrack.id === trackId || p.currentTrack.url === trackId)
        ? { ...p.currentTrack, isFavorite: nextFavorited }
        : p.currentTrack,
    }));
    try {
      await fetch(`/api/favorites/${encodeURIComponent(trackId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: feedbackTrack?.title,
          artist: feedbackTrack?.artist,
        }),
      });
    } catch {
      setFavoriteIds((prev) => !nextFavorited ? [...prev, trackId] : prev.filter((id) => id !== trackId));
    }
  }, []);

  const fetchPlaylists = useCallback(async () => {
    try {
      const res = await fetch("/api/playlists");
      if (res.ok) return await res.json();
    } catch {}
    return [];
  }, []);

  const onSelectTrack = useCallback((trackId: string) => {
    const pl = playerStateRef.current.playlist;
    const track = pl.find((t) => t.id === trackId);
    if (!track) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "queue_select", data: { trackId } }));
      return;
    }
    playMusic(track);
  }, [playMusic]);

  const playSavedTrack = useCallback((trackId: string) => {
    const catalogTrack = trackCatalogRef.current.get(trackId) ?? trackCatalogRef.current.get(`url:${trackId}`);
    if (!catalogTrack?.url) {
      showUtilityNotice("Track metadata unavailable yet");
      return;
    }

    playMusic({ ...catalogTrack, id: catalogTrack.id ?? trackId });
  }, [playMusic, showUtilityNotice]);

  const startDjSpeech = useCallback((text?: string) => {
    if (text) showSubtitle(text);
    ttsPlayingRef.current = true;
    applyActiveMusicVolume(160);
    setStatus("speaking");
    setPlayerState((current) => ({ ...current, status: "speaking" }));
  }, [applyActiveMusicVolume, showSubtitle]);

  const finishDjSpeech = useCallback(() => {
    ttsPlayingRef.current = false;
    applyActiveMusicVolume(220);
    hideSubtitle(true);
    const active = getActiveMusicAudio();
    const nextStatus: AppStatus = active && !active.paused && active.currentSrc ? "playing" : "idle";
    setStatus(nextStatus);
    setPlayerState((current) => ({ ...current, status: nextStatus }));
  }, [applyActiveMusicVolume, getActiveMusicAudio, hideSubtitle]);

  const cancelSpeechStream = useCallback(() => {
    const stream = speechStreamRef.current;
    speechStreamRef.current = null;
    stream?.player?.cancel();
    if (stream?.started) finishDjSpeech();
  }, [finishDjSpeech]);

  const playSpeechFile = useCallback((url: string, text?: string) => {
    const audio = ttsAudioRef.current;
    if (!audio) return;
    cancelSpeechStream();
    startDjSpeech(text);
    audio.src = url;
    void audio.play().catch(() => {
      if (!speechStreamRef.current?.started && audio.getAttribute("src") === url) finishDjSpeech();
    });
  }, [cancelSpeechStream, finishDjSpeech, startDjSpeech]);

  const onReplayAudio = useCallback((messageId: string) => {
    const found = messages.find((m) => m.id === messageId);
    if (found?.audioUrl && ttsAudioRef.current) {
      playSpeechFile(found.audioUrl, found.text);
      const currentTrack = playerStateRef.current.currentTrack;
      if (currentTrack) {
        void fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "replay_dj",
            trackId: currentTrack.id,
            title: currentTrack.title,
            artist: currentTrack.artist,
            note: "implicit: replayed DJ audio",
          }),
        }).catch(() => {});
      }
    }
  }, [messages, playSpeechFile]);

  const sendTrigger = useCallback((mode: TriggerMode) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const labels: Record<TriggerMode, string> = { morning_brief: "Morning Brief", mood_pick: "Mood Pick", random_discover: "Discover" };
    const timestamp = Date.now();
    setMessages((p) => [...p, {
      id: crypto.randomUUID(),
      role: "user",
      text: `Triggered: ${labels[mode]}`,
      time: formatClockTime(timestamp),
      timestamp,
      sender: USER_DISPLAY_NAME,
    }]);
    setStatus("thinking");
    setPlayerState((p) => ({ ...p, status: "thinking" }));
    wsRef.current.send(JSON.stringify({ type: "trigger", data: { mode } }));
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      let streamTts = false;
      try {
        const context = audioContextRef.current ?? new AudioContext();
        audioContextRef.current = context;
        streamTts = context.state !== "closed";
        if (streamTts && context.state !== "running") void context.resume().catch(() => {});
      } catch {
        // The saved audio path also works in browsers without Web Audio.
      }
      wsRef.current.send(JSON.stringify({ type: "chat", data: { text, streamTts } }));
    }
  }, []);

  const refreshLibraryData = useCallback(async () => {
    try {
      const [
        favoritesRes,
        historyRes,
        feedbackRes,
        discoveryCandidatesRes,
        tasteRes,
        djTasteRes,
        musicSourcesRes,
        playbackDiagnosticsRes,
        localLibraryRes,
        localLibraryMatchesRes,
        programAuditRes,
        listenChecksRes,
        listenAcceptanceRes,
      ] = await Promise.all([
        fetch("/api/favorites"),
        fetch("/api/history"),
        fetch("/api/feedback?limit=6"),
        fetch("/api/radio/discovery-candidates?limit=6"),
        fetch("/api/taste-profile"),
        fetch("/api/taste"),
        fetch("/api/music-sources"),
        fetch("/api/radio/playback-diagnostics"),
        fetch("/api/music-sources/local-library"),
        fetch("/api/music-sources/local-library/matches"),
        fetch("/api/radio/program-audit"),
        fetch("/api/radio/listen-checks?limit=3"),
        fetch("/api/radio/listen-acceptance"),
      ]);

      if (favoritesRes.ok) {
        const ids = await favoritesRes.json() as string[];
        setFavoriteIds(ids);
      }
      if (historyRes.ok) {
        const history = await historyRes.json() as PlayHistoryEntry[];
        setPlayHistory(history);
      }
      if (feedbackRes.ok) {
        const records = await feedbackRes.json() as UserFeedbackRecord[];
        setUserFeedback(records);
      }
      if (discoveryCandidatesRes.ok) {
        const records = await discoveryCandidatesRes.json() as DiscoveryCandidateRecord[];
        setDiscoveryCandidates(records);
      }
      if (tasteRes.ok) {
        const profile = await tasteRes.json() as TasteProfile | null;
        setTasteProfile(profile);
      }
      if (djTasteRes.ok) {
        const profile = await djTasteRes.json() as DjProfile;
        setDjProfile(profile);
      }
      if (musicSourcesRes.ok) {
        const status = await musicSourcesRes.json() as MusicSourceRuntimeStatus;
        setMusicSourceStatus(status);
      }
      if (playbackDiagnosticsRes.ok) {
        const diagnostics = await playbackDiagnosticsRes.json() as PlaybackDiagnostics;
        setPlaybackDiagnostics(diagnostics);
      }
      if (localLibraryRes.ok) {
        const status = await localLibraryRes.json() as LocalLibraryStatus;
        setLocalLibraryStatus(status);
      }
      if (localLibraryMatchesRes.ok) {
        const summary = await localLibraryMatchesRes.json() as LocalLibraryTasteMatchSummary;
        setLocalLibraryMatchStatus(summary);
      }
      if (programAuditRes.ok) {
        const audit = await programAuditRes.json() as ProgramExperienceAudit;
        setProgramAudit(audit);
      }
      if (listenChecksRes.ok) {
        const records = await listenChecksRes.json() as ListenCheckRecord[];
        setListenCheckRecords(records);
      }
      if (listenAcceptanceRes.ok) {
        const summary = await listenAcceptanceRes.json() as ListenAcceptanceSummary;
        setListenAcceptance(summary);
      }
    } catch {
      // keep best-effort behavior
    }
  }, []);

  const onTrackFeedback = useCallback(async (type: TrackFeedbackType) => {
    const currentTrack = playerStateRef.current.currentTrack;
    if (!currentTrack) {
      showUtilityNotice("No track to tag yet");
      return;
    }

    const labels: Record<TrackFeedbackType, string> = {
      more_like_this: "已记录：多来点这种",
      less_like_this: "已记录：少放这种",
      dislike_track: "已记录：不喜欢这首",
      favorite_track: "已记录：收藏",
      complete_track: "已记录：听完",
      skip_track: "已记录：跳过",
      replay_dj: "已记录：重播",
      ask_about_track: "已记录：追问",
    };
    const djReplies: Partial<Record<TrackFeedbackType, string>> = {
      more_like_this: currentTrack.artist
        ? `收到，后面我会往 ${currentTrack.artist} 这条线靠近一点。`
        : "收到，后面我会多接一点这种方向。",
      less_like_this: "收到，后面我会把这类歌的密度降下来。",
      dislike_track: "明白，这首我会避开，后面换个更合适的方向。",
    };
    showUtilityNotice(labels[type]);

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          trackId: currentTrack.id,
          title: currentTrack.title,
          artist: currentTrack.artist,
        }),
      });
      if (!res.ok) {
        throw new Error(`Feedback failed: ${res.status}`);
      }
      const record = await res.json() as UserFeedbackRecord;
      setUserFeedback((current) => [record, ...current].slice(0, 50));
      const reply = djReplies[type];
      if (reply) {
        const timestamp = Date.now();
        setMessages((current) => [...current, {
          id: crypto.randomUUID(),
          role: "dj",
          text: reply,
          time: formatClockTime(timestamp),
          timestamp,
          sender: DJ_DISPLAY_NAME,
        }]);
      }
      void refreshLibraryData();
    } catch (error) {
      showUtilityNotice(error instanceof Error ? error.message : "Feedback failed");
    }
  }, [refreshLibraryData, showUtilityNotice]);

  const updateVoicePreset = useCallback(async (preset: TtsPreset) => {
    setIsUpdatingVoicePreset(true);
    const previous = djProfile;
    setDjProfile((current) => current
      ? { ...current, voice: preset }
      : { voice: preset, style: "情感电台", name: "Claudio" });

    try {
      const res = await fetch("/api/taste", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: preset }),
      });
      if (!res.ok) {
        throw new Error(`Voice update failed: ${res.status}`);
      }
      const updated = await res.json() as DjProfile;
      setDjProfile(updated);
      showUtilityNotice(`TTS preset: ${normalizeVoicePreset(updated.voice)}`);
    } catch (error) {
      setDjProfile(previous ?? null);
      showUtilityNotice(error instanceof Error ? error.message : "Voice update failed");
    } finally {
      setIsUpdatingVoicePreset(false);
    }
  }, [djProfile, showUtilityNotice]);

  const syncNeteaseLibrary = useCallback(async () => {
    setIsSyncingLibrary(true);
    try {
      const res = await fetch("/api/netease/sync", { method: "POST" });
      if (!res.ok) {
        throw new Error(`Sync failed: ${res.status}`);
      }
      const summary = await res.json() as SyncSummary;
      setLastSyncSummary(summary);
      await refreshLibraryData();
      showUtilityNotice(
        summary.failedPlaylists.length > 0
          ? `Synced ${summary.playlistCount} playlists, ${summary.failedPlaylists.length} failed`
          : `Synced ${summary.playlistCount} playlists`,
      );
    } catch (error) {
      showUtilityNotice(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setIsSyncingLibrary(false);
    }
  }, [refreshLibraryData, showUtilityNotice]);

  const retryFailedLibrarySync = useCallback(async () => {
    setIsSyncingLibrary(true);
    try {
      const res = await fetch("/api/netease/retry-failed", { method: "POST" });
      if (!res.ok) {
        throw new Error(`Retry failed: ${res.status}`);
      }
      await res.json();
      await refreshLibraryData();
      showUtilityNotice("Retry finished");
    } catch (error) {
      showUtilityNotice(error instanceof Error ? error.message : "Retry failed");
    } finally {
      setIsSyncingLibrary(false);
    }
  }, [refreshLibraryData, showUtilityNotice]);

  const rescanLocalLibrary = useCallback(async () => {
    setIsRescanningLocalLibrary(true);
    try {
      const res = await fetch("/api/music-sources/local-library/rescan", { method: "POST" });
      if (!res.ok) {
        throw new Error(`Local rescan failed: ${res.status}`);
      }
      const status = await res.json() as LocalLibraryStatus;
      setLocalLibraryStatus(status);
      await refreshLibraryData();
      showUtilityNotice(
        status.enabled
          ? `Local library: ${status.trackCount} tracks`
          : "Local library disabled",
      );
    } catch (error) {
      showUtilityNotice(error instanceof Error ? error.message : "Local rescan failed");
    } finally {
      setIsRescanningLocalLibrary(false);
    }
  }, [refreshLibraryData, showUtilityNotice]);

  useEffect(() => {
    playerStateRef.current = playerState;
  });

  useEffect(() => {
    userVolumeRef.current = playerState.volume;
  }, [playerState.volume]);

  useEffect(() => {
    if (!playerState.currentTrack || playerState.queueCount < 2) {
      return;
    }

    requestUpcomingPrefetch();
  }, [
    playerState.currentTrack?.id,
    playerState.currentTrack?.url,
    playerState.queueCount,
    requestUpcomingPrefetch,
  ]);

  const playlistPreloadSignature = playerState.playlist
    .map((track) => `${track.id}:${track.url}`)
    .join("|");

  useEffect(() => {
    if (!playerState.currentTrack || playerState.queueCount < 2) {
      return;
    }

    preloadNextPlaylistTrack();
  }, [
    playerState.currentTrack?.id,
    playerState.currentTrack?.url,
    playerState.queueCount,
    playlistPreloadSignature,
    preloadNextPlaylistTrack,
  ]);

  const queueTrackIds = playerState.playlist.map((track) => track.id).sort().join("|");
  useEffect(() => {
    if (!playerStateRef.current.playlist.some((track) => !track.duration)) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/radio/queue-durations", { signal: controller.signal });
        if (!response.ok) return;
        const durations = await response.json() as Record<string, number>;
        if (controller.signal.aborted) return;
        setPlayerState((p) => {
          const playlist = p.playlist.map((track) => {
            const durationMs = positiveDuration(durations[track.id]);
            return track.duration || !durationMs ? track : { ...track, duration: durationMs / 1000 };
          });
          const currentTrack = p.currentTrack;
          const duration = p.duration || playlist.find((track) => track.id === getTrackPlaybackKey(currentTrack))?.duration || 0;
          return {
            ...p,
            playlist,
            duration,
            currentTrack: currentTrack && duration !== p.duration ? { ...currentTrack, duration } : currentTrack,
          };
        });
      } catch {
        // Media metadata remains available when the catalog lookup fails.
      }
    })();
    return () => controller.abort();
  }, [queueTrackIds]);

  useEffect(() => {
    const track = playerState.currentTrack;
    const trackKey = getTrackPlaybackKey(track);
    const signalLevel = playerState.audioSignalLevel;
    const resetSilentRecovery = () => {
      silentAudioRecoveryRef.current = {
        trackKey,
        url: track?.url,
        lastPositionSec: Number.isFinite(playerState.currentTime) ? playerState.currentTime : null,
        silentRunMs: 0,
        lastActionAt: silentAudioRecoveryRef.current.lastActionAt,
      };
    };

    if (
      !track
      || !trackKey
      || !playerState.isPlaying
      || status === "speaking"
      || playerState.volume < AUDIO_SILENCE_RECOVERY_MIN_VOLUME
      || typeof signalLevel !== "number"
    ) {
      resetSilentRecovery();
      return;
    }

    const recovery = silentAudioRecoveryRef.current;
    const samePlayback = recovery.trackKey === trackKey && recovery.url === track.url;
    const previousPositionSec = samePlayback ? recovery.lastPositionSec : null;
    const currentPositionSec = Number.isFinite(playerState.currentTime)
      ? playerState.currentTime
      : previousPositionSec;
    const positionDeltaMs = previousPositionSec !== null && currentPositionSec !== null
      ? Math.max(0, (currentPositionSec - previousPositionSec) * 1000)
      : 0;
    const progressedMs = positionDeltaMs > 0 ? Math.min(positionDeltaMs, 1_500) : 0;
    const nextSilentRunMs = signalLevel <= AUDIO_SILENCE_RECOVERY_LEVEL
      ? (samePlayback ? recovery.silentRunMs : 0) + progressedMs
      : 0;

    silentAudioRecoveryRef.current = {
      trackKey,
      url: track.url,
      lastPositionSec: currentPositionSec,
      silentRunMs: nextSilentRunMs,
      lastActionAt: recovery.lastActionAt,
    };

    const now = performance.now();
    if (
      nextSilentRunMs >= AUDIO_SILENCE_RECOVERY_MS
      && now - recovery.lastActionAt >= AUDIO_SILENCE_RECOVERY_COOLDOWN_MS
    ) {
      silentAudioRecoveryRef.current = {
        trackKey,
        url: track.url,
        lastPositionSec: currentPositionSec,
        silentRunMs: 0,
        lastActionAt: now,
      };
      handleActiveAudioFailure("silent");
    }
  }, [
    handleActiveAudioFailure,
    playerState.audioSignalLevel,
    playerState.currentTime,
    playerState.currentTrack,
    playerState.isPlaying,
    playerState.volume,
    status,
  ]);

  useEffect(() => {
    favoriteIdsRef.current = favoriteIds;
    setPlayerState((prev) => {
      if (!prev.currentTrack) return prev;
      const targetKey = prev.currentTrack.id ?? prev.currentTrack.url;
      return {
        ...prev,
        currentTrack: {
          ...prev.currentTrack,
          isFavorite: favoriteIds.includes(targetKey),
        },
      };
    });
  }, [favoriteIds]);

  useEffect(() => {
    void refreshLibraryData();
  }, [refreshLibraryData]);

  useEffect(() => () => {
    clearSubtitleFadeTimer();
  }, [clearSubtitleFadeTimer]);

  useEffect(() => {
    if (status !== "playing" && status !== "speaking") {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshLibraryData();
    }, 30_000);

    return () => window.clearInterval(timer);
  }, [refreshLibraryData, status]);

  useEffect(() => {
    const primary = audioRef.current;
    const secondary = nextAudioRef.current;
    if (!primary || !secondary) return;

    activeMusicAudioRef.current = activeMusicAudioRef.current ?? primary;
    primary.volume = getEffectiveMusicVolume();
    secondary.volume = 0;

    const isActiveAudio = (audio: HTMLAudioElement) => audio === getActiveMusicAudio();

    const onTimeUpdate = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (!isActiveAudio(a)) return;
      const time = a.currentTime;
      setPlayerState((p) => {
        if (getTrackPlaybackKey(p.currentTrack) !== a.dataset.playbackKey
          || (event.type !== "seeked" && Math.abs(p.currentTime - time) < 0.2)) return p;
        return { ...p, currentTime: time };
      });

      const duration = positiveDuration(a.duration) ?? playerStateRef.current.duration;
      if (duration <= 0) return;

      const remaining = duration - time;
      const prefetchThreshold = Math.min(90, Math.max(35, duration * 0.5));
      if (remaining <= prefetchThreshold) {
        requestUpcomingPrefetch();
      }
    };
    const onDurationChange = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      const active = isActiveAudio(a);
      const key = active ? a.dataset.playbackKey : a.dataset.preloadKey;
      const url = a.dataset.loadedUrl;
      const duration = positiveDuration(a.duration);
      if (!key || !url || !duration) return;

      setPlayerState((p) => {
        const playlist = p.playlist.map((track) => track.id === key && track.url === url && track.duration !== duration
          ? { ...track, duration }
          : track);
        const currentTrack = p.currentTrack;
        if (active && currentTrack && getTrackPlaybackKey(currentTrack) === key && currentTrack.url === url) {
          return { ...p, playlist, duration, currentTrack: { ...currentTrack, duration } };
        }
        return { ...p, playlist };
      });
    };
    const onEnd = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (!isActiveAudio(a)) return;
      prefetchedTrackKeyRef.current = null;
      requestQueueStep("next", () => playRelativeTrackLocally(1), buildQueueStepPayload("track_complete", a));
    };
    const onPlaying = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (!isActiveAudio(a) || a.paused) return;
      setPlayerState((p) => ({ ...p, isPlaying: true, status: ttsPlayingRef.current ? "speaking" : "playing" }));
      if (!ttsPlayingRef.current) {
        setStatus("playing");
      }
    };
    const onPs = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (!isActiveAudio(a) || !a.paused) return;
      setPlayerState((p) => ({ ...p, isPlaying: false }));
    };
    const onWaiting = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (isActiveAudio(a)) {
        handleActiveAudioFailure("waiting");
      }
    };
    const onStalled = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (isActiveAudio(a)) {
        handleActiveAudioFailure("stalled");
      }
    };
    const onError = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (isActiveAudio(a)) {
        if (!outgoingMusicAudioRef.current) handleActiveAudioFailure("error");
        return;
      }

      if (a.dataset.preloadKey) requestUpcomingPrefetch();
    };

    const audioElements = [primary, secondary];
    audioElements.forEach((audio) => {
      audio.addEventListener("timeupdate", onTimeUpdate);
      audio.addEventListener("seeked", onTimeUpdate);
      audio.addEventListener("loadedmetadata", onDurationChange);
      audio.addEventListener("durationchange", onDurationChange);
      audio.addEventListener("ended", onEnd);
      audio.addEventListener("playing", onPlaying);
      audio.addEventListener("pause", onPs);
      audio.addEventListener("waiting", onWaiting);
      audio.addEventListener("stalled", onStalled);
      audio.addEventListener("error", onError);
    });

    return () => {
      audioElements.forEach((audio) => {
        audio.removeEventListener("timeupdate", onTimeUpdate);
        audio.removeEventListener("seeked", onTimeUpdate);
        audio.removeEventListener("loadedmetadata", onDurationChange);
        audio.removeEventListener("durationchange", onDurationChange);
        audio.removeEventListener("ended", onEnd);
        audio.removeEventListener("playing", onPlaying);
        audio.removeEventListener("pause", onPs);
        audio.removeEventListener("waiting", onWaiting);
        audio.removeEventListener("stalled", onStalled);
        audio.removeEventListener("error", onError);
      });
    };
  }, [
    getActiveMusicAudio,
    getEffectiveMusicVolume,
    buildQueueStepPayload,
    handleActiveAudioFailure,
    playRelativeTrackLocally,
    requestQueueStep,
    requestUpcomingPrefetch,
  ]);

  useEffect(() => {
    const primary = audioRef.current;
    const secondary = nextAudioRef.current;
    if (!primary || !secondary) return;

    const ensureAnalyser = async (audio: HTMLAudioElement) => {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch {
          return null;
        }
      }

      let source = mediaSourcesRef.current.get(audio);
      if (!source) {
        source = ctx.createMediaElementSource(audio);
        mediaSourcesRef.current.set(audio, source);
      }

      let analyser = analyserNodesRef.current.get(audio);
      if (!analyser) {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.82;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        analyserNodesRef.current.set(audio, analyser);
      }

      analyserRef.current = analyser;
      return analyser;
    };

    const stopVisualizer = () => {
      if (visualizerFrameRef.current !== null) {
        window.cancelAnimationFrame(visualizerFrameRef.current);
        visualizerFrameRef.current = null;
      }
      setVisualizerBars((prev) => prev.map((_, index) => 0.04 + ((index % 5) * 0.01)));
      setPlayerState((prev) => (
        prev.audioSignalLevel === null ? prev : { ...prev, audioSignalLevel: null }
      ));
    };

    const startVisualizer = async (audio: HTMLAudioElement) => {
      const analyser = await ensureAnalyser(audio);
      if (!analyser) return;

      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const barCount = 20;

      const tick = () => {
        analyser.getByteFrequencyData(buffer);
        const chunkSize = Math.max(1, Math.floor(buffer.length / barCount));
        const nextBars = Array.from({ length: barCount }, (_, barIndex) => {
          const start = barIndex * chunkSize;
          const end = Math.min(buffer.length, start + chunkSize);
          let total = 0;
          for (let i = start; i < end; i++) total += buffer[i];
          const average = total / Math.max(1, end - start);
          const normalized = Math.max(0.06, average / 255);
          return Number(normalized.toFixed(3));
        });
        setVisualizerBars(nextBars);
        const rawAverage = buffer.reduce((total, value) => total + value, 0) / Math.max(1, buffer.length);
        const signalLevel = Number((rawAverage / 255).toFixed(4));
        const now = performance.now();
        if (now - lastAudioSignalStateAtRef.current >= AUDIO_SIGNAL_STATE_INTERVAL_MS) {
          lastAudioSignalStateAtRef.current = now;
          setPlayerState((prev) => (
            prev.audioSignalLevel === signalLevel ? prev : { ...prev, audioSignalLevel: signalLevel }
          ));
        }
        visualizerFrameRef.current = window.requestAnimationFrame(tick);
      };

      if (visualizerFrameRef.current !== null) {
        window.cancelAnimationFrame(visualizerFrameRef.current);
      }
      visualizerFrameRef.current = window.requestAnimationFrame(tick);
    };

    const handlePlay = (event: Event) => {
      const audio = event.currentTarget as HTMLAudioElement;
      if (audio === getActiveMusicAudio()) {
        void startVisualizer(audio);
      }
    };
    const handleStop = (event: Event) => {
      const audio = event.currentTarget as HTMLAudioElement;
      if (audio === getActiveMusicAudio()) {
        stopVisualizer();
      }
    };

    const audioElements = [primary, secondary];
    audioElements.forEach((audio) => {
      audio.addEventListener("play", handlePlay);
      audio.addEventListener("pause", handleStop);
      audio.addEventListener("ended", handleStop);
    });

    const active = getActiveMusicAudio();
    if (active && !active.paused && active.currentSrc) {
      void startVisualizer(active);
    }

    return () => {
      audioElements.forEach((audio) => {
        audio.removeEventListener("play", handlePlay);
        audio.removeEventListener("pause", handleStop);
        audio.removeEventListener("ended", handleStop);
      });
      stopVisualizer();
    };
  }, [getActiveMusicAudio]);

  useEffect(() => {
    const t = ttsAudioRef.current;
    if (!t) return;
    const onFinish = () => {
      if (!speechStreamRef.current?.started) finishDjSpeech();
    };
    t.addEventListener("ended", onFinish);
    t.addEventListener("error", onFinish);
    return () => {
      t.removeEventListener("ended", onFinish);
      t.removeEventListener("error", onFinish);
    };
  }, [finishDjSpeech]);

  useEffect(() => {
    let disposed = false;
    let awaitingInitialState = true;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;

    const buildWsUrl = () => {
      if (import.meta.env.DEV) {
        return "ws://localhost:3000/ws";
      }

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${window.location.host}/ws`;
    };

    const clearPingTimer = () => {
      if (pingTimer !== null) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const handleMessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data) as WSMessage;
        switch (msg.type) {
          case "state": {
            const d = msg.data as {
              status: AppStatus;
              currentTrack: WSTrackPayload | null;
              chatHistory?: Array<{ role: "user" | "dj"; text: string; timestamp: number }>;
              radioQueue?: Array<WSTrackPayload | null>;
              djProfile?: DjProfile;
            };
            const shouldRestorePlayback = awaitingInitialState;
            awaitingInitialState = false;
            setHasHydratedState(true);
            setStatus(d.status ?? "idle");
            if (d.djProfile) {
              setDjProfile(d.djProfile);
            }
            if (Array.isArray(d.chatHistory)) {
              const history = d.chatHistory.slice().sort((a, b) => a.timestamp - b.timestamp);
              setMessages((current) => {
                const visible = new Map(current.map((message) => [chatEntryKey(message), message]));
                const merged = history.map((entry, index) => visible.get(chatEntryKey(entry)) ?? {
                  id: `history_${entry.timestamp}_${index}`,
                  role: entry.role,
                  text: entry.text,
                  time: formatClockTime(entry.timestamp),
                  timestamp: entry.timestamp,
                  sender: entry.role === "dj" ? DJ_DISPLAY_NAME : USER_DISPLAY_NAME,
                });
                const activeStream = current.find((message) => message.id === speechStreamRef.current?.id);
                if (activeStream && !merged.includes(activeStream)) merged.push(activeStream);
                return merged;
              });
            }
            const normalizedTrack = d.currentTrack?.url ? normalizeTrack(d.currentTrack) : null;
            const queue = Array.isArray(d.radioQueue)
              ? d.radioQueue
                .filter((track): track is NonNullable<typeof track> => Boolean(track?.url && track?.artist))
                .map(normalizeTrack)
              : null;
            setPlayerState((p) => {
              const key = getTrackPlaybackKey(p.currentTrack);
              const previousDurations = new Map(p.playlist.map((track) => [track.id, track.duration]));
              const playlist = queue?.map((track) => ({
                ...track,
                duration: previousDurations.get(track.id) ?? track.duration,
                isPlaying: track.id === (key || normalizedTrack?.id),
              })) ?? p.playlist;
              const duration = p.duration
                || playlist.find((track) => track.id === key)?.duration
                || (normalizedTrack?.id === key ? normalizedTrack.duration : undefined)
                || 0;
              return {
                ...p,
                currentTrack: p.currentTrack && duration !== p.duration ? { ...p.currentTrack, duration } : p.currentTrack,
                duration,
                playlist,
                queueCount: playlist.length,
                status: d.status ?? "idle",
              };
            });
            // The server sends a state snapshot before each explicit track message.
            // Only restore playback from the connection snapshot.
            if (shouldRestorePlayback && normalizedTrack) {
              const active = getActiveMusicAudio();
              if (active?.dataset.playbackKey !== normalizedTrack.id || active.error || active.ended) {
                playMusic(normalizedTrack, d.status === "playing");
              }
            }
            break;
          }
          case "status": {
            const d = msg.data as WSStatusPayload;
            const nextStatus = typeof d === "string" ? d : d.status;
            if (!nextStatus) break;
            setStatus(nextStatus);
            setPlayerState((p) => ({ ...p, status: nextStatus }));
            break;
          }
          case "dj_message": {
            const d = msg.data as WSDJMessagePayload;
            const timestamp = d.timestamp ?? Date.now();
            const audioUrl = resolveSpeechUrl(d.ttsAudioPath);
            const entry: ChatEntry = {
              id: d.ttsStreamId ?? crypto.randomUUID(),
              role: "dj",
              text: d.text,
              time: formatClockTime(timestamp),
              timestamp,
              sender: DJ_DISPLAY_NAME,
              audioUrl,
            };
            const entryKey = chatEntryKey(entry);
            setMessages((current) => [...current.filter((message) => chatEntryKey(message) !== entryKey), entry]);
            if (d.ttsStreamId) {
              cancelSpeechStream();
              const stream: SpeechStream = { id: d.ttsStreamId, text: d.text, started: false };
              const context = audioContextRef.current;
              if (context) {
                stream.player = new PcmSpeechPlayer(context, () => {
                  if (speechStreamRef.current !== stream) return;
                  speechStreamRef.current = null;
                  if (stream.started) finishDjSpeech();
                });
              }
              speechStreamRef.current = stream;
            } else if (audioUrl) {
              playSpeechFile(audioUrl, d.text);
            } else if (!speechStreamRef.current?.started) {
              hideSubtitle(false);
            }
            break;
          }
          case "tts_chunk": {
            const d = msg.data as WSTtsChunkPayload;
            const stream = speechStreamRef.current;
            if (!stream || stream.id !== d.streamId || !stream.player?.append(d.pcm)) break;
            if (!stream.started) {
              ttsAudioRef.current?.pause();
              stream.started = true;
              startDjSpeech(stream.text);
            }
            break;
          }
          case "tts_complete": {
            const d = msg.data as WSTtsCompletePayload;
            const audioUrl = resolveSpeechUrl(d.ttsAudioPath);
            if (audioUrl) {
              setMessages((p) => p.map((message) => message.id === d.streamId ? { ...message, audioUrl } : message));
            }
            const stream = speechStreamRef.current;
            if (!stream || stream.id !== d.streamId) break;
            if (stream.started) {
              stream.player?.finish();
            } else {
              cancelSpeechStream();
              if (audioUrl) playSpeechFile(audioUrl, stream.text);
            }
            break;
          }
          case "track": {
            playMusic(normalizeTrack(msg.data as WSTrackPayload));
            break;
          }
          case "chat": {
            const d = msg.data as WSChatPayload;
            const timestamp = d.timestamp ?? Date.now();
            setMessages((p) => [...p, {
              id: crypto.randomUUID(),
              role: d.role,
              text: d.text,
              time: formatClockTime(timestamp),
              timestamp,
              sender: d.role === "dj" ? DJ_DISPLAY_NAME : USER_DISPLAY_NAME,
            }]);
            break;
          }
          case "segue": {
            const d = msg.data as WSSeguePayload;
            if (d.audioPath) playSpeechFile(d.audioPath);
            break;
          }
          case "error":
            console.error("WS Error:", msg.data);
            setStatus("error");
            setPlayerState((p) => ({ ...p, status: "error" }));
            break;
        }
      } catch (_) {}
    };

    const connect = () => {
      if (disposed) return;

      const ws = new WebSocket(buildWsUrl());
      wsRef.current = ws;
      awaitingInitialState = true;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) {
          ws.close();
          return;
        }

        setIsConnected(true);
        setReconnecting(false);
        void refreshLibraryData();
        clearPingTimer();
        pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30000);
      };

      ws.onmessage = (event) => {
        if (wsRef.current === ws) handleMessage(event);
      };

      ws.onclose = () => {
        clearPingTimer();
        if (disposed || wsRef.current !== ws) {
          return;
        }

        cancelSpeechStream();
        wsRef.current = null;
        setIsConnected(false);
        setReconnecting(true);
        reconnectTimer = window.setTimeout(() => {
          connect();
        }, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      cancelSpeechStream();
      clearPingTimer();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [
    cancelSpeechStream,
    finishDjSpeech,
    getActiveMusicAudio,
    hideSubtitle,
    normalizeTrack,
    playMusic,
    playSpeechFile,
    refreshLibraryData,
    startDjSpeech,
  ]);

  const statusText =
    status === "thinking" ? "AI is thinking..."
    : status === "speaking" ? "DJ is speaking..."
    : status === "playing" && playerState.currentTrack
      ? `Now playing: ${playerState.currentTrack.title} - ${playerState.currentTrack.artist}`
    : status === "error" ? "Error occurred"
    : "Ready";

  const isTriggerBusy = status === "thinking" || status === "speaking";

  const favoriteTracks = favoriteIds.map((favoriteId) => {
    const catalogTrack = trackCatalogRef.current.get(favoriteId) ?? trackCatalogRef.current.get(`url:${favoriteId}`);
    return {
      id: favoriteId,
      title: catalogTrack?.title ?? favoriteId,
      artist: catalogTrack?.artist ?? "Saved favorite",
      album: catalogTrack?.album,
      url: catalogTrack?.url,
      isResolved: Boolean(catalogTrack?.url),
    };
  });

  return {
    hasHydratedState,
    voicePreset: normalizeVoicePreset(djProfile?.voice),
    isUpdatingVoicePreset,
    userAvatarUrl,
    status, messages, djMessages, currentTrack: playerState.currentTrack,
    isConnected, reconnecting, playerState, audioRef, nextAudioRef, ttsAudioRef,
    statusText, isTriggerBusy, subtitle, subtitleFading,
    visualizerBars,
    favoriteIds, favoriteTracks, playHistory, userFeedback, discoveryCandidates, tasteProfile,
    isSyncingLibrary, lastSyncSummary, musicSourceStatus, playbackDiagnostics, localLibraryStatus, localLibraryMatchStatus, programAudit, listenCheckRecords, listenAcceptance, isRescanningLocalLibrary, utilityNotice,
    sendTrigger, sendMessage,
    onPlayPause, onNext, onPrevious, onSeek, onVolumeChange,
    onToggleFavorite, onTrackFeedback, onSelectTrack, onReplayAudio, updateVoicePreset,
    setUserAvatarUrl: async (file: File) => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Avatar read failed"));
        reader.onerror = () => reject(reader.error ?? new Error("Avatar read failed"));
        reader.readAsDataURL(file);
      });
      window.localStorage.setItem(USER_AVATAR_STORAGE_KEY, dataUrl);
      setUserAvatarUrl(dataUrl);
    },
    fetchPlaylists, syncNeteaseLibrary, retryFailedLibrarySync, rescanLocalLibrary, showUtilityNotice, playSavedTrack,
    refreshLibraryData,
  };
}
