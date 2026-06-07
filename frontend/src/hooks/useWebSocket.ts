import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AppStatus,
  ChatEntry,
  DjProfile,
  DJMessage,
  ListenAcceptanceSummary,
  ListenCheckRecord,
  LocalLibraryStatus,
  LocalLibraryTasteMatchSummary,
  MusicSourceRuntimeStatus,
  PlayHistoryEntry,
  ProgramExperienceAudit,
  SyncSummary,
  TasteProfile,
  TtsPreset,
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
} from "../types";

const normalizeVoicePreset = (value?: string): TtsPreset => value === "Dean" ? "Dean" : "冰糖";
const USER_DISPLAY_NAME = "xian";
const DJ_DISPLAY_NAME = "CLAUDIO";
const USER_AVATAR_STORAGE_KEY = "claudio-user-avatar";
const MUSIC_FADE_MS = 420;
const TTS_DUCK_RATIO = 0.34;
const PRELOAD_READY_STATE = 2;

type PlayableTrackInfo = TrackInfo & {
  id?: string;
};

type PreloadedTrack = {
  key: string;
  url: string;
  ready: boolean;
};

const getTrackPlaybackKey = (track?: Pick<TrackInfo, "id" | "url"> | Pick<PlaylistTrack, "id" | "url"> | null) =>
  track?.id || track?.url || "";

export function useWebSocket() {
  const [hasHydratedState, setHasHydratedState] = useState(false);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [djMessages, setDjMessages] = useState<DJMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [subtitle, setSubtitle] = useState("");
  const [visualizerBars, setVisualizerBars] = useState<number[]>(Array.from({ length: 20 }, () => 0.08));
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [playHistory, setPlayHistory] = useState<PlayHistoryEntry[]>([]);
  const [tasteProfile, setTasteProfile] = useState<TasteProfile | null>(null);
  const [isSyncingLibrary, setIsSyncingLibrary] = useState(false);
  const [isUpdatingVoicePreset, setIsUpdatingVoicePreset] = useState(false);
  const [lastSyncSummary, setLastSyncSummary] = useState<SyncSummary | null>(null);
  const [musicSourceStatus, setMusicSourceStatus] = useState<MusicSourceRuntimeStatus | null>(null);
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
    playlist: [],
    queueCount: 0,
    status: "idle",
    isOnAir: false,
  });

  const audioRef = useRef<HTMLAudioElement>(null);
  const nextAudioRef = useRef<HTMLAudioElement>(null);
  const ttsAudioRef = useRef<HTMLAudioElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ttsPlayingRef = useRef(false);
  const prefetchedTrackKeyRef = useRef<string | null>(null);
  const preloadedTrackRef = useRef<PreloadedTrack | null>(null);
  const activeMusicAudioRef = useRef<HTMLAudioElement | null>(null);
  const standbyMusicAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioRecoveryRef = useRef<{ trackKey?: string; url?: string; attempts: number }>({ attempts: 0 });
  const userVolumeRef = useRef(0.8);
  const fadeFramesRef = useRef<WeakMap<HTMLAudioElement, number>>(new WeakMap());
  const playerStateRef = useRef(playerState);
  const favoriteIdsRef = useRef<string[]>([]);
  const trackCatalogRef = useRef<Map<string, TrackInfo>>(new Map());
  const utilityNoticeTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaSourcesRef = useRef<WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>>(new WeakMap());
  const visualizerFrameRef = useRef<number | null>(null);
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

  const getActiveMusicAudio = useCallback(() => {
    if (!activeMusicAudioRef.current && audioRef.current) {
      activeMusicAudioRef.current = audioRef.current;
    }
    return activeMusicAudioRef.current ?? audioRef.current;
  }, []);

  const getStandbyMusicAudio = useCallback(() => {
    const primary = audioRef.current;
    const secondary = nextAudioRef.current;
    const active = getActiveMusicAudio();
    const standby = active === primary ? secondary : primary;
    standbyMusicAudioRef.current = standby ?? null;
    return standby ?? null;
  }, [getActiveMusicAudio]);

  const getEffectiveMusicVolume = useCallback(() => (
    userVolumeRef.current * (ttsPlayingRef.current ? TTS_DUCK_RATIO : 1)
  ), []);

  const fadeAudioVolume = useCallback((audio: HTMLAudioElement, targetVolume: number, duration = MUSIC_FADE_MS) => {
    const frame = fadeFramesRef.current.get(audio);
    if (frame !== undefined) {
      window.cancelAnimationFrame(frame);
      fadeFramesRef.current.delete(audio);
    }

    const boundedTarget = Math.min(1, Math.max(0, targetVolume));
    if (duration <= 0) {
      audio.volume = boundedTarget;
      return;
    }

    const startVolume = audio.volume;
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      audio.volume = startVolume + ((boundedTarget - startVolume) * progress);
      if (progress < 1) {
        const nextFrame = window.requestAnimationFrame(step);
        fadeFramesRef.current.set(audio, nextFrame);
      } else {
        fadeFramesRef.current.delete(audio);
      }
    };

    const nextFrame = window.requestAnimationFrame(step);
    fadeFramesRef.current.set(audio, nextFrame);
  }, []);

  const applyActiveMusicVolume = useCallback((duration = 180) => {
    const active = getActiveMusicAudio();
    if (active) {
      fadeAudioVolume(active, getEffectiveMusicVolume(), duration);
    }
  }, [fadeAudioVolume, getActiveMusicAudio, getEffectiveMusicVolume]);

  const findNextPlaylistTrack = useCallback((): PlaylistTrack | null => {
    const state = playerStateRef.current;
    const playlist = state.playlist;
    if (!state.currentTrack || playlist.length <= 1) {
      return null;
    }

    const currentKey = getTrackPlaybackKey(state.currentTrack);
    const currentIndex = playlist.findIndex((track) =>
      track.isPlaying || track.id === currentKey || track.url === state.currentTrack?.url,
    );
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
    const standby = getStandbyMusicAudio();
    const nextTrack = findNextPlaylistTrack();
    if (!standby || !nextTrack?.url) {
      return;
    }

    const key = getTrackPlaybackKey(nextTrack);
    const existing = preloadedTrackRef.current;
    if (
      existing
      && existing.key === key
      && existing.url === nextTrack.url
      && standby.dataset.preloadKey === key
    ) {
      return;
    }

    standby.pause();
    standby.volume = 0;
    standby.preload = "auto";
    standby.dataset.preloadKey = key;
    standby.dataset.playbackUrl = nextTrack.url;
    if (standby.dataset.loadedUrl !== nextTrack.url) {
      standby.src = nextTrack.url;
      standby.dataset.loadedUrl = nextTrack.url;
    }
    preloadedTrackRef.current = {
      key,
      url: nextTrack.url,
      ready: standby.readyState >= PRELOAD_READY_STATE,
    };
    try {
      standby.load();
    } catch {
      // Some browsers throw if load is called while the media element is being torn down.
    }
  }, [findNextPlaylistTrack, getStandbyMusicAudio]);

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
      duration: data.duration,
    };
  }, [toPlayableUrl]);

  const startPreloadedTrack = useCallback((track: PlayableTrackInfo) => {
    const incoming = getStandbyMusicAudio();
    const outgoing = getActiveMusicAudio();
    const key = getTrackPlaybackKey(track);
    const preloaded = preloadedTrackRef.current;
    if (
      !incoming
      || !outgoing
      || !preloaded
      || preloaded.key !== key
      || preloaded.url !== track.url
      || incoming.dataset.preloadKey !== key
      || (!preloaded.ready && incoming.readyState < PRELOAD_READY_STATE)
    ) {
      return false;
    }

    activeMusicAudioRef.current = incoming;
    standbyMusicAudioRef.current = outgoing;
    preloadedTrackRef.current = null;
    incoming.dataset.playbackKey = key;
    incoming.dataset.playbackUrl = track.url;
    incoming.volume = 0;

    incoming.play()
      .then(() => {
        fadeAudioVolume(incoming, getEffectiveMusicVolume(), MUSIC_FADE_MS);
        fadeAudioVolume(outgoing, 0, MUSIC_FADE_MS);
        window.setTimeout(() => {
          if (standbyMusicAudioRef.current === outgoing) {
            outgoing.pause();
            outgoing.removeAttribute("src");
            delete outgoing.dataset.loadedUrl;
            delete outgoing.dataset.preloadKey;
            try {
              outgoing.load();
            } catch {}
          }
        }, MUSIC_FADE_MS + 80);
      })
      .catch((error) => {
        console.error(error);
        activeMusicAudioRef.current = outgoing;
        standbyMusicAudioRef.current = incoming;
        incoming.pause();
        preloadedTrackRef.current = null;
        if (outgoing.dataset.loadedUrl !== track.url) {
          outgoing.src = track.url;
          outgoing.dataset.loadedUrl = track.url;
        }
        outgoing.play().catch(console.error);
        fadeAudioVolume(outgoing, getEffectiveMusicVolume(), MUSIC_FADE_MS);
      });

    return true;
  }, [fadeAudioVolume, getActiveMusicAudio, getEffectiveMusicVolume, getStandbyMusicAudio]);

  const playMusic = useCallback((url: string, title: string, artist: string, album?: string, id?: string, duration?: number) => {
    const a = getActiveMusicAudio();
    if (!a) return;
    const track: PlayableTrackInfo = { id, url, title, artist, album, duration };
    const trackKey = getTrackPlaybackKey(track);
    const recovery = audioRecoveryRef.current;
    if (recovery.trackKey !== trackKey || recovery.url !== url) {
      audioRecoveryRef.current = { trackKey, url, attempts: 0 };
    }

    prefetchedTrackKeyRef.current = null;
    const usedPreloadedAudio = startPreloadedTrack(track);
    if (!usedPreloadedAudio) {
      a.pause();
      a.volume = 0;
      a.dataset.playbackKey = trackKey;
      a.dataset.playbackUrl = url;
      if (a.dataset.loadedUrl !== url) {
        a.src = url;
        a.dataset.loadedUrl = url;
      }
      a.currentTime = 0;
      a.play().catch(console.error);
      fadeAudioVolume(a, getEffectiveMusicVolume(), MUSIC_FADE_MS);
    }

    const isFavorite = id ? favoriteIdsRef.current.includes(id) : false;
    setPlayerState((p) => ({
      ...p,
      currentTrack: { id, url, title, artist, album, duration, isFavorite },
      isPlaying: true,
      currentTime: 0,
      duration: duration ?? 0,
    }));
    setStatus("playing");
    rememberTrack({ id, url, title, artist, album, duration, isFavorite });
    window.setTimeout(() => {
      preloadNextPlaylistTrack();
    }, 0);
  }, [
    fadeAudioVolume,
    getActiveMusicAudio,
    getEffectiveMusicVolume,
    preloadNextPlaylistTrack,
    rememberTrack,
    startPreloadedTrack,
  ]);

  const resolveAndPlayTrack = useCallback((data: WSTrackPayload) => {
    const normalized = normalizeTrack(data);
    const id = normalized.id;
    rememberTrack({
      id,
      url: normalized.url,
      title: normalized.title,
      artist: normalized.artist,
      album: normalized.album,
      duration: normalized.duration,
      isFavorite: favoriteIdsRef.current.includes(id),
    });
    setPlayerState((p) => {
      const exists = p.playlist.some((t) => t.id === id);
      const pl: PlaylistTrack[] = exists
        ? p.playlist
        : [...p.playlist, { id, title: normalized.title, artist: normalized.artist, album: normalized.album, duration: normalized.duration, isPlaying: false, url: normalized.url }];
      const finalPl = pl.map((t) => ({ ...t, isPlaying: t.id === id }));
      return { ...p, playlist: finalPl, queueCount: finalPl.length, status: "playing" as AppStatus };
    });
    playMusic(normalized.url, normalized.title, normalized.artist, normalized.album, id, normalized.duration);
  }, [normalizeTrack, playMusic, rememberTrack]);

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

  const requestQueueStep = useCallback((direction: "next" | "previous", fallback: () => void) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: direction === "next" ? "queue_next" : "queue_previous" }));
      return;
    }
    fallback();
  }, []);

  const playRelativeTrackLocally = useCallback((step: number) => {
    const pl = playerStateRef.current.playlist;
    if (pl.length === 0) return;
    const idx = pl.findIndex((t) => t.isPlaying);
    const target = pl[(idx + step + pl.length) % pl.length];
    setPlayerState((p) => ({ ...p, playlist: p.playlist.map((t) => ({ ...t, isPlaying: t.id === target.id })) }));
    playMusic(target.url, target.title, target.artist, target.album, target.id);
  }, [playMusic]);

  const onNext = useCallback(() => {
    const pl = playerStateRef.current.playlist;
    if (pl.length === 0) return;
    requestQueueStep("next", () => playRelativeTrackLocally(1));
  }, [playRelativeTrackLocally, requestQueueStep]);

  const onPrevious = useCallback(() => {
    const pl = playerStateRef.current.playlist;
    if (pl.length === 0) return;
    requestQueueStep("previous", () => playRelativeTrackLocally(-1));
  }, [playRelativeTrackLocally, requestQueueStep]);

  const handleActiveAudioFailure = useCallback((reason: "error" | "stalled" | "waiting") => {
    const currentTrack = playerStateRef.current.currentTrack;
    const trackKey = getTrackPlaybackKey(currentTrack);
    if (!currentTrack || !trackKey) {
      return;
    }

    if (reason !== "error") {
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

    if (attempts === 1 && currentTrack.id && wsRef.current?.readyState === WebSocket.OPEN) {
      showUtilityNotice("Refreshing audio signal");
      wsRef.current.send(JSON.stringify({ type: "queue_select", data: { trackId: currentTrack.id } }));
      requestUpcomingPrefetch();
      return;
    }

    showUtilityNotice("Skipping unavailable track");
    requestQueueStep("next", () => playRelativeTrackLocally(1));
  }, [playRelativeTrackLocally, requestQueueStep, requestUpcomingPrefetch, showUtilityNotice]);

  const onPlayPause = useCallback(() => {
    const a = getActiveMusicAudio();
    if (!a) return;
    const ct = playerStateRef.current.currentTrack;
    if (!ct?.url) return;
    a.paused ? a.play().catch(console.error) : a.pause();
  }, [getActiveMusicAudio]);

  const onSeek = useCallback((time: number) => {
    const active = getActiveMusicAudio();
    if (active) active.currentTime = time;
  }, [getActiveMusicAudio]);

  const onVolumeChange = useCallback((vol: number) => {
    userVolumeRef.current = vol;
    applyActiveMusicVolume(80);
    setPlayerState((p) => ({ ...p, volume: vol }));
  }, [applyActiveMusicVolume]);

  const onToggleFavorite = useCallback(async (trackId: string) => {
    const nextFavorited = !favoriteIdsRef.current.includes(trackId);
    setFavoriteIds((prev) => nextFavorited ? [...prev, trackId] : prev.filter((id) => id !== trackId));
    setPlayerState((p) => ({
      ...p,
      currentTrack: p.currentTrack && (p.currentTrack.id === trackId || p.currentTrack.url === trackId)
        ? { ...p.currentTrack, isFavorite: nextFavorited }
        : p.currentTrack,
    }));
    try {
      await fetch(`/api/favorites/${encodeURIComponent(trackId)}`, { method: "POST" });
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
    setPlayerState((p) => ({ ...p, playlist: p.playlist.map((t) => ({ ...t, isPlaying: t.id === trackId })) }));
    const catalogTrack = trackCatalogRef.current.get(trackId);
    playMusic(track.url, track.title, track.artist, track.album, track.id, catalogTrack?.duration);
  }, [playMusic]);

  const playSavedTrack = useCallback((trackId: string) => {
    const catalogTrack = trackCatalogRef.current.get(trackId) ?? trackCatalogRef.current.get(`url:${trackId}`);
    if (!catalogTrack?.url) {
      showUtilityNotice("Track metadata unavailable yet");
      return;
    }

    setPlayerState((p) => {
      const targetId = catalogTrack.id ?? trackId;
      const exists = p.playlist.some((track) => track.id === targetId);
      const playlist = exists
        ? p.playlist.map((track) => ({ ...track, isPlaying: track.id === targetId }))
        : [
            ...p.playlist.map((track) => ({ ...track, isPlaying: false })),
            {
              id: targetId,
              title: catalogTrack.title,
              artist: catalogTrack.artist,
              album: catalogTrack.album,
              duration: catalogTrack.duration,
              isPlaying: true,
              url: catalogTrack.url,
            },
          ];
      return {
        ...p,
        playlist,
        queueCount: playlist.length,
      };
    });

    playMusic(
      catalogTrack.url,
      catalogTrack.title,
      catalogTrack.artist,
      catalogTrack.album,
      catalogTrack.id ?? trackId,
      catalogTrack.duration,
    );
  }, [playMusic, showUtilityNotice]);

  const onReplayAudio = useCallback((messageId: string) => {
    const found = messages.find((m) => m.id === messageId);
    if (found?.audioUrl && ttsAudioRef.current) {
      ttsPlayingRef.current = true;
      applyActiveMusicVolume(160);
      ttsAudioRef.current.src = found.audioUrl;
      ttsAudioRef.current.play().catch(console.error);
    }
  }, [applyActiveMusicVolume, messages]);

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
      wsRef.current.send(JSON.stringify({ type: "chat", data: { text } }));
    }
  }, []);

  const refreshLibraryData = useCallback(async () => {
    try {
      const [
        favoritesRes,
        historyRes,
        tasteRes,
        djTasteRes,
        musicSourcesRes,
        localLibraryRes,
        localLibraryMatchesRes,
        programAuditRes,
        listenChecksRes,
        listenAcceptanceRes,
      ] = await Promise.all([
        fetch("/api/favorites"),
        fetch("/api/history"),
        fetch("/api/taste-profile"),
        fetch("/api/taste"),
        fetch("/api/music-sources"),
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
    standbyMusicAudioRef.current = standbyMusicAudioRef.current ?? secondary;
    primary.volume = getEffectiveMusicVolume();
    secondary.volume = 0;

    const isActiveAudio = (audio: HTMLAudioElement) => audio === getActiveMusicAudio();

    const onTU = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (!isActiveAudio(a)) return;
      setPlayerState((p) => {
        if (Math.abs(p.currentTime - a.currentTime) < 0.3) return p;
        return { ...p, currentTime: a.currentTime };
      });

      if (!Number.isFinite(a.duration) || a.duration <= 0) {
        return;
      }

      const remaining = a.duration - a.currentTime;
      const prefetchThreshold = Math.min(90, Math.max(35, a.duration * 0.5));
      if (remaining <= prefetchThreshold) {
        requestUpcomingPrefetch();
      }
    };
    const onLM = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (!isActiveAudio(a)) return;
      setPlayerState((p) => ({ ...p, duration: a.duration || p.duration }));
    };
    const onEnd = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (!isActiveAudio(a)) return;
      prefetchedTrackKeyRef.current = null;
      requestQueueStep("next", () => playRelativeTrackLocally(1));
    };
    const onPl = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (!isActiveAudio(a)) return;
      setPlayerState((p) => ({ ...p, isPlaying: true }));
      if (!ttsPlayingRef.current) {
        setStatus("playing");
      }
    };
    const onPs = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      if (!isActiveAudio(a)) return;
      setPlayerState((p) => ({ ...p, isPlaying: false }));
    };
    const onCanPlay = (event: Event) => {
      const a = event.currentTarget as HTMLAudioElement;
      const preloaded = preloadedTrackRef.current;
      if (preloaded && a.dataset.preloadKey === preloaded.key) {
        preloadedTrackRef.current = {
          ...preloaded,
          ready: true,
        };
      }
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
        handleActiveAudioFailure("error");
        return;
      }

      preloadedTrackRef.current = null;
      delete a.dataset.preloadKey;
      requestUpcomingPrefetch();
    };

    const audioElements = [primary, secondary];
    audioElements.forEach((audio) => {
      audio.addEventListener("timeupdate", onTU);
      audio.addEventListener("loadedmetadata", onLM);
      audio.addEventListener("ended", onEnd);
      audio.addEventListener("play", onPl);
      audio.addEventListener("pause", onPs);
      audio.addEventListener("canplay", onCanPlay);
      audio.addEventListener("canplaythrough", onCanPlay);
      audio.addEventListener("waiting", onWaiting);
      audio.addEventListener("stalled", onStalled);
      audio.addEventListener("error", onError);
    });

    return () => {
      audioElements.forEach((audio) => {
        audio.removeEventListener("timeupdate", onTU);
        audio.removeEventListener("loadedmetadata", onLM);
        audio.removeEventListener("ended", onEnd);
        audio.removeEventListener("play", onPl);
        audio.removeEventListener("pause", onPs);
        audio.removeEventListener("canplay", onCanPlay);
        audio.removeEventListener("canplaythrough", onCanPlay);
        audio.removeEventListener("waiting", onWaiting);
        audio.removeEventListener("stalled", onStalled);
        audio.removeEventListener("error", onError);
      });
    };
  }, [
    getActiveMusicAudio,
    getEffectiveMusicVolume,
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

      if (!mediaSourcesRef.current.get(audio)) {
        const source = ctx.createMediaElementSource(audio);
        mediaSourcesRef.current.set(audio, source);
        analyserRef.current = ctx.createAnalyser();
        analyserRef.current.fftSize = 128;
        analyserRef.current.smoothingTimeConstant = 0.82;
        source.connect(analyserRef.current);
        analyserRef.current.connect(ctx.destination);
      } else if (!analyserRef.current) {
        analyserRef.current = ctx.createAnalyser();
        analyserRef.current.fftSize = 128;
        analyserRef.current.smoothingTimeConstant = 0.82;
        mediaSourcesRef.current.get(audio)?.connect(analyserRef.current);
        analyserRef.current.connect(ctx.destination);
      }

      return analyserRef.current;
    };

    const stopVisualizer = () => {
      if (visualizerFrameRef.current !== null) {
        window.cancelAnimationFrame(visualizerFrameRef.current);
        visualizerFrameRef.current = null;
      }
      setVisualizerBars((prev) => prev.map((_, index) => 0.04 + ((index % 5) * 0.01)));
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
    const onPlay = () => {
      ttsPlayingRef.current = true;
      applyActiveMusicVolume(160);
    };
    const onEnd = () => {
      ttsPlayingRef.current = false;
      applyActiveMusicVolume(220);
      const active = getActiveMusicAudio();
      const isMusicPlaying = Boolean(active && !active.paused && active.currentSrc);
      const nextStatus: AppStatus = isMusicPlaying ? "playing" : "idle";
      setStatus(nextStatus);
      setPlayerState((p) => ({ ...p, status: nextStatus }));
    };
    const onError = () => {
      ttsPlayingRef.current = false;
      applyActiveMusicVolume(220);
      const active = getActiveMusicAudio();
      if (active && !active.paused && active.currentSrc) {
        setStatus("playing");
        setPlayerState((p) => ({ ...p, status: "playing" }));
      }
    };
    t.addEventListener("play", onPlay);
    t.addEventListener("ended", onEnd);
    t.addEventListener("error", onError);
    return () => {
      t.removeEventListener("play", onPlay);
      t.removeEventListener("ended", onEnd);
      t.removeEventListener("error", onError);
    };
  }, [applyActiveMusicVolume, getActiveMusicAudio]);

  useEffect(() => {
    let disposed = false;
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
              currentTrack: (TrackInfo & { name?: string }) | null;
              chatHistory?: Array<{ role: "user" | "dj"; text: string; timestamp: number }>;
              radioQueue?: Array<(TrackInfo & { name?: string }) | null>;
              djProfile?: DjProfile;
            };
            setHasHydratedState(true);
            setStatus(d.status ?? "idle");
            if (d.djProfile) {
              setDjProfile(d.djProfile);
            }
            if (Array.isArray(d.chatHistory)) {
              const historyMessages = d.chatHistory
                .slice()
                .sort((a, b) => a.timestamp - b.timestamp)
                .map((entry, index) => ({
                  id: `history_${entry.timestamp}_${index}`,
                  role: entry.role,
                  text: entry.text,
                  time: formatClockTime(entry.timestamp),
                  timestamp: entry.timestamp,
                  sender: entry.role === "dj" ? DJ_DISPLAY_NAME : USER_DISPLAY_NAME,
                }));
              setMessages(historyMessages);
            }
            if (Array.isArray(d.radioQueue)) {
              const playlist = d.radioQueue
                .filter((track): track is NonNullable<typeof track> => Boolean(track?.url && track?.artist))
                .map((track) => {
                  const id = track.id ? String(track.id) : `${track.title ?? track.name ?? "Unknown Title"}_${track.artist}`;
                  return {
                    id,
                    title: track.title ?? track.name ?? "Unknown Title",
                    artist: track.artist,
                    album: track.album,
                    duration: track.duration,
                    isPlaying: d.currentTrack?.id ? String(d.currentTrack.id) === id : false,
                    url: toPlayableUrl(track.url),
                  };
                });
              setPlayerState((p) => ({
                ...p,
                playlist,
                queueCount: playlist.length,
              }));
            }
            if (d.currentTrack) {
              const normalizedTrack = {
                ...d.currentTrack,
                id: d.currentTrack.id ? String(d.currentTrack.id) : undefined,
                url: toPlayableUrl(d.currentTrack.url),
                title: d.currentTrack.title ?? d.currentTrack.name ?? "Unknown Title",
                isFavorite: d.currentTrack.id ? favoriteIdsRef.current.includes(String(d.currentTrack.id)) : false,
              };
              rememberTrack(normalizedTrack);
              setPlayerState((p) => ({ ...p, currentTrack: normalizedTrack, duration: normalizedTrack.duration ?? 0, status: d.status ?? "idle" }));
              const activeTrack = playerStateRef.current.currentTrack;
              const isSameTrack = Boolean(
                activeTrack
                && (
                  (activeTrack.id && normalizedTrack.id && activeTrack.id === normalizedTrack.id)
                  || activeTrack.url === normalizedTrack.url
                ),
              );
              const active = getActiveMusicAudio();
              if (active && normalizedTrack.url && (!active.currentSrc || !isSameTrack)) {
                active.dataset.playbackKey = getTrackPlaybackKey(normalizedTrack);
                active.dataset.playbackUrl = normalizedTrack.url;
                active.src = normalizedTrack.url;
                active.dataset.loadedUrl = normalizedTrack.url;
                if ((d.status ?? "idle") === "playing") {
                  active.play().catch(console.error);
                  fadeAudioVolume(active, getEffectiveMusicVolume(), MUSIC_FADE_MS);
                }
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
            setSubtitle(d.text);
            const fn = d.ttsAudioPath?.split(/[/\\]/).pop() ?? "";
            const audioUrl = fn ? `/api/audio/tts/${fn}` : undefined;
            setMessages((p) => [...p, {
              id: crypto.randomUUID(),
              role: "dj",
              text: d.text,
              time: formatClockTime(timestamp),
              timestamp,
              sender: DJ_DISPLAY_NAME,
              audioUrl,
            }]);
            if (d.ttsAudioPath) {
              ttsPlayingRef.current = true;
              applyActiveMusicVolume(160);
              setStatus("speaking");
              setPlayerState((p) => ({ ...p, status: "speaking" }));
              if (ttsAudioRef.current) {
                ttsAudioRef.current.src = audioUrl ?? "";
                ttsAudioRef.current.play().catch(() => {
                  ttsPlayingRef.current = false;
                  applyActiveMusicVolume(220);
                  const active = getActiveMusicAudio();
                  if (active && !active.paused && active.currentSrc) {
                    setStatus("playing");
                    setPlayerState((p) => ({ ...p, status: "playing" }));
                  }
                });
              }
            }
            break;
          }
          case "track": {
            const d = msg.data as WSTrackPayload;
            resolveAndPlayTrack(d);
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
            if (d.audioPath && ttsAudioRef.current) {
              ttsPlayingRef.current = true;
              applyActiveMusicVolume(160);
              ttsAudioRef.current.src = d.audioPath;
              ttsAudioRef.current.play().catch(console.error);
            }
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

      ws.onmessage = handleMessage;

      ws.onclose = () => {
        clearPingTimer();
        if (disposed || wsRef.current !== ws) {
          return;
        }

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
      clearPingTimer();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [
    applyActiveMusicVolume,
    fadeAudioVolume,
    getActiveMusicAudio,
    getEffectiveMusicVolume,
    refreshLibraryData,
    rememberTrack,
    resolveAndPlayTrack,
    toPlayableUrl,
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
    statusText, isTriggerBusy, subtitle,
    visualizerBars,
    favoriteIds, favoriteTracks, playHistory, tasteProfile,
    isSyncingLibrary, lastSyncSummary, musicSourceStatus, localLibraryStatus, localLibraryMatchStatus, programAudit, listenCheckRecords, listenAcceptance, isRescanningLocalLibrary, utilityNotice,
    sendTrigger, sendMessage,
    onPlayPause, onNext, onPrevious, onSeek, onVolumeChange,
    onToggleFavorite, onSelectTrack, onReplayAudio, updateVoicePreset,
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
