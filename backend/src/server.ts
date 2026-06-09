import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { Readable } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import * as db from "./db.js";
import * as pipeline from "./pipeline.js";
import * as claude from "./claude.js";
import * as djLanguage from "./dj-language.js";
import * as musicSources from "./music-sources/index.js";
import * as netease from "./netease.js";
import { auditProgramExperience } from "./program-audit.js";
import { summarizeListenAcceptance } from "./listen-acceptance.js";
import * as radioSession from "./radio-session.js";
import * as radioStyle from "./radio-style.js";
import * as tasteProfile from "./taste-profile.js";
import * as tts from "./tts.js";
import * as weather from "./weather.js";
import { routeChatIntent, type ChatRoute } from "./agent-router.js";
import { audioDir, frontendDistDir } from "./runtime.js";

interface ChatReplyPayload {
  action?: "reply_only" | "answer_weather";
  say: string;
  ttsText?: string;
}

interface TransitionReplyPayload {
  say: string;
  ttsText?: string;
}

interface PreparedQueueTransition {
  key: string;
  step: number;
  sourceTrackId: string;
  sourceQueueIndex: number;
  nextTrackId: string;
  nextQueueIndex: number;
  nextTrack: db.Track;
  text?: string;
  ttsAudioPath?: string;
  preparedAt: number;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PREFETCH_LOOKAHEAD_COUNT = 3;
const CURRENT_URL_REFRESH_THRESHOLD_MS = 2 * 60 * 1000;
const UPCOMING_URL_REFRESH_THRESHOLD_MS = 3 * 60 * 1000;
const PLAYBACK_LEASE_MAINTENANCE_INTERVAL_MS = 45 * 1000;
const preparedQueueTransitions = new Map<string, PreparedQueueTransition>();
const preparedQueueTransitionInFlight = new Map<string, Promise<PreparedQueueTransition | null>>();
let playbackLeaseMaintenanceTimer: ReturnType<typeof setInterval> | null = null;

type PlaybackLeaseStatus = "ready" | "expiring" | "expired" | "unknown" | "missing" | "failed";
type PlaybackHealth = NonNullable<db.Track["playbackHealth"]>;

interface PlaybackDiagnosticTrack {
  queueIndex: number;
  id: string;
  name: string;
  artist: string;
  source?: string;
  sourceTrackId?: string;
  urlSource?: string;
  urlExpiresAt?: number;
  urlRefreshedAt?: number;
  urlTtlMs: number | null;
  leaseStatus: PlaybackLeaseStatus;
  health: PlaybackHealth;
  shouldRefresh: boolean;
  lastResolveError?: db.Track["lastResolveError"];
  lastPlaybackIssue?: db.Track["lastPlaybackIssue"];
}

interface PlaybackDiagnostics {
  generatedAt: number;
  queueLength: number;
  currentQueueIndex: number;
  thresholds: {
    currentRefreshMs: number;
    upcomingRefreshMs: number;
  };
  current: PlaybackDiagnosticTrack | null;
  upcoming: PlaybackDiagnosticTrack[];
  fallbacks: musicSources.MusicSourceRuntimeStatus["playableUrlFallbacks"];
  sources: musicSources.MusicSourceRuntimeStatus["sources"];
  recentIssue?: db.Track["lastResolveError"] | db.Track["lastPlaybackIssue"];
}

const CLIENT_PLAYBACK_ISSUE_CODES = new Set([
  "client_silent_audio",
  "audio_error",
  "audio_waiting",
  "audio_stalled",
]);

app.use(cors());
app.use(express.json());

const VALID_TRIGGER_MODES = ["morning_brief", "mood_pick", "random_discover"] as const;
type TriggerMode = typeof VALID_TRIGGER_MODES[number];

function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function parseTriggerMode(mode: unknown): TriggerMode | null {
  return typeof mode === "string" && VALID_TRIGGER_MODES.includes(mode as TriggerMode)
    ? mode as TriggerMode
    : null;
}

function parseWsTriggerMode(payload: any): TriggerMode | null {
  return parseTriggerMode(payload?.data?.mode ?? payload?.mode);
}

function toClientTrack(track: {
  id: number | string;
  name: string;
  artist: string;
  url: string;
  picUrl: string;
  duration: number;
  source?: string;
  sourceTrackId?: string;
  urlSource?: string;
  urlExpiresAt?: number;
}) {
  return {
    ...track,
    title: track.name,
  };
}

function toClientStoredTrack(track: db.Track) {
  return {
    id: track.id,
    name: track.name,
    title: track.name,
    artist: track.artist,
    url: track.url,
    picUrl: track.picUrl ?? "",
    duration: track.duration ?? 0,
    album: track.album,
    source: track.source,
    sourceTrackId: track.sourceTrackId,
    urlSource: track.urlSource,
    urlExpiresAt: track.urlExpiresAt,
    urlRefreshedAt: track.urlRefreshedAt,
    playbackHealth: track.playbackHealth,
    lastPlaybackIssue: track.lastPlaybackIssue,
    lastResolveError: track.lastResolveError,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectFailedSnapshotPlaylists(playlists: Array<db.NeteaseSnapshotPlaylist>) {
  return playlists.filter((playlist) => playlist.trackCount > 0 && playlist.tracks.length === 0);
}

function getFirstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }

  return undefined;
}

function parseQueryNumber(value: unknown): number | undefined | null {
  const raw = getFirstQueryValue(value)?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveWeatherStatusCode(error: unknown): number {
  if (error instanceof weather.WeatherInputError) {
    return 400;
  }

  if (error instanceof weather.WeatherConfigError) {
    return 500;
  }

  if (error instanceof weather.WeatherUpstreamError) {
    return 502;
  }

  return 500;
}

app.use((req, res, next) => {
  const rawPath = (req.originalUrl || "").split("?")[0];
  if (rawPath.startsWith("/api/audio/tts/") && rawPath.includes("..")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
});

app.use(express.static(frontendDistDir));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

app.get("/api/weather/current", async (req, res) => {
  const city = getFirstQueryValue(req.query.city)?.trim() || undefined;
  const country = getFirstQueryValue(req.query.country)?.trim() || undefined;
  const lat = parseQueryNumber(req.query.lat);
  const lon = parseQueryNumber(req.query.lon);
  const units = getFirstQueryValue(req.query.units) as weather.WeatherUnits | undefined;
  const lang = getFirstQueryValue(req.query.lang)?.trim() || undefined;

  if (lat === null || lon === null) {
    res.status(400).json({ error: "lat and lon must be valid numbers" });
    return;
  }

  try {
    const hasCustomLocation = Boolean(city || country || lat !== undefined || lon !== undefined || units || lang);
    const currentWeather = hasCustomLocation
      ? await weather.getCurrentWeather({
        city,
        country,
        lat: lat ?? undefined,
        lon: lon ?? undefined,
        units,
        lang,
      })
      : (await weather.getDefaultWeatherSnapshot())?.weather ?? await weather.getCurrentWeather();

    res.setHeader("Cache-Control", "no-store");
    res.json(currentWeather);
  } catch (error) {
    res.status(resolveWeatherStatusCode(error)).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/state", async (req, res) => {
  const state = await ensurePlayableQueueState({ refreshCurrentTrack: true });
  res.json(state);
});

app.post("/api/pipeline/trigger", async (req, res) => {
  const mode = parseTriggerMode(req.body?.mode);
  if (!mode) {
    return res.status(400).json({ error: "Invalid mode" });
  }

  try {
    const result = await pipeline.runPipeline(mode);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/audio/tts/:filename", (req, res) => {
  const { filename } = req.params;
  const safe = path.basename(filename);
  if (safe !== filename || filename.includes("..")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const filePath = path.join(audioDir, safe);
  const resolved = path.resolve(filePath);
  const allowedDir = path.resolve(audioDir);
  if (!resolved.startsWith(allowedDir + path.sep) && resolved !== allowedDir) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.sendFile(resolved);
});

app.get("/api/audio/local/:sourceTrackId", async (req, res) => {
  const sourceTrackId = String(req.params.sourceTrackId ?? "").trim();
  if (!sourceTrackId) {
    res.status(400).json({ error: "sourceTrackId required" });
    return;
  }

  try {
    const file = await musicSources.getLocalLibraryFileForPlayback(sourceTrackId);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", file.contentType);
    res.sendFile(file.filePath);
  } catch (error) {
    const normalized = musicSources.normalizeMusicSourceError(
      musicSources.LOCAL_LIBRARY_SOURCE_ID,
      error,
    );
    const status = normalized.code === "not_found" ? 404 : 500;
    res.status(status).json({ error: normalized.message });
  }
});

app.get("/api/audio/music", (req, res) => {
  const { url } = req.query;
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    void (async () => {
      try {
        const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : undefined;
        const upstream = await fetch(url, {
          headers: {
            // Some providers are stricter when the request looks like a generic server fetch.
            "User-Agent": "Mozilla/5.0 Claudio/1.0",
            "Accept": "audio/*,*/*;q=0.9",
            ...(rangeHeader ? { Range: rangeHeader } : {}),
          },
        });

        if (!upstream.ok || !upstream.body) {
          res.status(502).json({ error: `Upstream audio request failed: ${upstream.status}` });
          return;
        }

        const contentType = upstream.headers.get("content-type");
        const contentLength = upstream.headers.get("content-length");
        const acceptRanges = upstream.headers.get("accept-ranges");
        const contentRange = upstream.headers.get("content-range");

        res.status(upstream.status);
        if (contentType) res.setHeader("Content-Type", contentType);
        if (contentLength) res.setHeader("Content-Length", contentLength);
        if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);
        if (contentRange) res.setHeader("Content-Range", contentRange);
        res.setHeader("Cache-Control", "no-store");

        Readable.fromWeb(upstream.body as any).pipe(res);
      } catch (error) {
        res.status(502).json({ error: getErrorMessage(error) });
      }
    })();
    return;
  }
  res.status(400).json({ error: "Invalid music URL" });
});

// Playlist management
app.get("/api/playlists", async (_req, res) => {
  const playlists = await db.getPlaylists();
  res.json(playlists);
});

app.get("/api/netease/snapshot", async (_req, res) => {
  const snapshot = await db.getNeteaseSnapshot();
  res.json(snapshot);
});

app.get("/api/taste-profile", async (_req, res) => {
  const [profile, state] = await Promise.all([
    tasteProfile.getTasteProfile(),
    db.getState(),
  ]);
  res.json(profile
    ? {
        ...profile,
        runtimeTaste: tasteProfile.buildRuntimeTasteProfile(
          Array.isArray(state.userFeedback) ? state.userFeedback : [],
        ),
      }
    : null);
});

app.get("/api/music-sources", async (_req, res) => {
  try {
    const status = await musicSources.getMusicSourceRuntimeStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/music-sources/local-library", async (_req, res) => {
  try {
    const status = await musicSources.getLocalLibraryStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/music-sources/local-library/matches", async (_req, res) => {
  try {
    const profile = await tasteProfile.getTasteProfile();
    const summary = await musicSources.getLocalLibraryTasteMatchSummary(profile);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/music-sources/local-library/rescan", async (_req, res) => {
  try {
    const status = await musicSources.getLocalLibraryStatus({
      forceRefresh: true,
    });
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/netease/sync", async (_req, res) => {
  try {
    const account = await netease.getUserAccount();
    const playlists = await netease.getUserPlaylists(account.userId);
    const playlistsWithTracks = [];
    const failedPlaylists: Array<{ id: number; name: string; error: string }> = [];

    for (const playlist of playlists) {
      let tracks = playlist.tracks;
      try {
        tracks = await netease.getPlaylistTracks(playlist.id, playlist.trackCount);
      } catch (error) {
        failedPlaylists.push({
          id: playlist.id,
          name: playlist.name,
          error: getErrorMessage(error),
        });
      }
      playlistsWithTracks.push({
        ...playlist,
        tracks,
      });
    }

    const snapshot = {
      account,
      playlists: playlistsWithTracks,
      syncedAt: Date.now(),
    };

    await db.setNeteaseSnapshot(snapshot);
    const profile = await tasteProfile.rebuildTasteProfileFromSnapshot(snapshot);
    res.json({
      ok: true,
      playlistCount: playlistsWithTracks.length,
      syncedAt: snapshot.syncedAt,
      totalTrackCount: playlistsWithTracks.reduce((sum, playlist) => sum + playlist.tracks.length, 0),
      failedPlaylists,
      tasteProfile: {
        generatedAt: profile.generatedAt,
        totalTrackCount: profile.totalTrackCount,
        uniqueArtistCount: profile.uniqueArtistCount,
      },
      topPlaylists: playlistsWithTracks.slice(0, 5).map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        trackCount: playlist.trackCount,
        storedTracks: playlist.tracks.length,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/netease/retry-failed", async (_req, res) => {
  try {
    const snapshot = await db.getNeteaseSnapshot();
    if (!snapshot) {
      return res.status(404).json({ error: "No Netease snapshot found" });
    }

    const failedPlaylists = collectFailedSnapshotPlaylists(snapshot.playlists);
    const retriedPlaylists = [];
    const stillFailed = [];

    const updatedPlaylists = [];
    for (const playlist of snapshot.playlists) {
      if (!failedPlaylists.some((item) => item.id === playlist.id)) {
        updatedPlaylists.push(playlist);
        continue;
      }

      try {
        const tracks = await netease.getPlaylistTracks(playlist.id, playlist.trackCount);
        updatedPlaylists.push({
          ...playlist,
          tracks,
        });
        retriedPlaylists.push({
          id: playlist.id,
          name: playlist.name,
          storedTracks: tracks.length,
        });
      } catch (error) {
        updatedPlaylists.push(playlist);
        stillFailed.push({
          id: playlist.id,
          name: playlist.name,
          error: getErrorMessage(error),
        });
      }
    }

    const nextSnapshot = {
      ...snapshot,
      playlists: updatedPlaylists,
      syncedAt: Date.now(),
    };

    await db.setNeteaseSnapshot(nextSnapshot);
    const profile = await tasteProfile.rebuildTasteProfileFromSnapshot(nextSnapshot);
    res.json({
      ok: true,
      retriedCount: failedPlaylists.length,
      recoveredCount: retriedPlaylists.length,
      retriedPlaylists,
      stillFailed,
      tasteProfile: {
        generatedAt: profile.generatedAt,
        totalTrackCount: profile.totalTrackCount,
        uniqueArtistCount: profile.uniqueArtistCount,
      },
    });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/taste-profile/rebuild", async (_req, res) => {
  try {
    const snapshot = await db.getNeteaseSnapshot();
    if (!snapshot) {
      return res.status(404).json({ error: "No Netease snapshot found" });
    }

    const profile = await tasteProfile.rebuildTasteProfileFromSnapshot(snapshot);
    res.json({
      ok: true,
      generatedAt: profile.generatedAt,
      totalTrackCount: profile.totalTrackCount,
      uniqueArtistCount: profile.uniqueArtistCount,
      uniqueAlbumCount: profile.uniqueAlbumCount,
    });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/playlists", async (req, res) => {
  const { name, tracks } = req.body as { name?: string; tracks?: Array<{ name: string; artist: string; album?: string }> };
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "歌单名称不能为空" });
    return;
  }
  if (!Array.isArray(tracks) || tracks.length === 0) {
    res.status(400).json({ error: "歌单曲目不能为空" });
    return;
  }

  const items = tracks.map((t) => ({
    name: t.name,
    artist: t.artist || "未知",
    album: t.album,
  }));

  const playlist = await db.addPlaylist(name.trim(), items);
  res.status(201).json(playlist);
});

app.delete("/api/playlists/:id", async (req, res) => {
  const { id } = req.params;
  const removed = await db.removePlaylist(id);
  if (!removed) {
    res.status(404).json({ error: "歌单不存在" });
    return;
  }
  res.json({ success: true });
});

app.get("/api/favorites", async (_req, res) => {
  const favorites = await db.getFavorites();
  res.json(favorites);
});

app.post("/api/favorites/:trackId", async (req, res) => {
  const { trackId } = req.params;
  const state = await db.getState();
  const result = await db.toggleFavorite(trackId);
  if (result.favorited) {
    const title = getBoundedString(req.body?.title, 160);
    const artist = getBoundedString(req.body?.artist, 160);
    const fallbackTrack = findFeedbackTrack(state, trackId, title, artist);
    if (fallbackTrack) {
      await addTrackFeedbackFromState(state, fallbackTrack, "favorite_track", "implicit: favorite");
    }
  }
  res.json(result);
});

function parseUserFeedbackType(value: unknown): db.UserFeedbackType | null {
  return value === "more_like_this"
    || value === "less_like_this"
    || value === "dislike_track"
    || value === "favorite_track"
    || value === "complete_track"
    || value === "skip_track"
    || value === "replay_dj"
    || value === "ask_about_track"
    ? value
    : null;
}

function findFeedbackTrack(
  state: db.AppState,
  trackId?: string,
  fallbackTitle?: string,
  fallbackArtist?: string,
): db.Track | null {
  const normalizedTrackId = trackId?.trim();
  const matchingTrack = normalizedTrackId
    ? [
        state.currentTrack,
        ...state.radioQueue,
      ].find((track) => track?.id === normalizedTrackId || track?.sourceTrackId === normalizedTrackId)
    : state.currentTrack;
  if (matchingTrack) return matchingTrack;
  if (fallbackTitle && fallbackArtist) {
    return {
      id: normalizedTrackId || `${fallbackTitle}::${fallbackArtist}`,
      name: fallbackTitle,
      artist: fallbackArtist,
      url: "",
    };
  }
  return null;
}

async function addTrackFeedbackFromState(
  state: db.AppState,
  track: db.Track,
  type: db.UserFeedbackType,
  note?: string,
): Promise<void> {
  await db.addUserFeedback({
    type,
    trackId: track.id,
    title: track.name,
    artist: track.artist,
    source: track.source,
    sourceTrackId: track.sourceTrackId,
    urlSource: track.urlSource,
    programSessionId: state.currentProgram?.sessionId,
    queueIndex: state.currentQueueIndex,
    note,
  });
}

app.get("/api/feedback", async (req, res) => {
  const parsedLimit = parseQueryNumber(req.query.limit);
  const limit = parsedLimit && parsedLimit > 0
    ? Math.min(Math.round(parsedLimit), 100)
    : 50;
  res.json(await db.getUserFeedback(limit));
});

app.post("/api/feedback", async (req, res) => {
  const feedbackType = parseUserFeedbackType(req.body?.type);
  if (!feedbackType) {
    res.status(400).json({ error: "Invalid feedback type" });
    return;
  }

  const state = await db.getState();
  const currentTrack = state.currentTrack;
  const title = getBoundedString(req.body?.title, 160) ?? currentTrack?.name;
  const artist = getBoundedString(req.body?.artist, 160) ?? currentTrack?.artist;
  if (!title || !artist) {
    res.status(400).json({ error: "No track available for feedback" });
    return;
  }

  const record = await db.addUserFeedback({
    type: feedbackType,
    trackId: getBoundedString(req.body?.trackId, 160) ?? currentTrack?.id,
    title,
    artist,
    source: getBoundedString(req.body?.source, 80) ?? currentTrack?.source,
    sourceTrackId: getBoundedString(req.body?.sourceTrackId, 160) ?? currentTrack?.sourceTrackId,
    urlSource: getBoundedString(req.body?.urlSource, 80) ?? currentTrack?.urlSource,
    programSessionId: state.currentProgram?.sessionId,
    queueIndex: state.currentQueueIndex,
    note: getBoundedString(req.body?.note, 240),
  });
  res.status(201).json(record);
});

app.get("/api/plan/today", async (_req, res) => {
  const state = await db.getState();
  res.json({
    date: new Date().toISOString().slice(0, 10),
    status: state.status,
    currentTrack: state.currentTrack,
    queueLength: state.chatHistory.length,
    lastInteraction: state.lastInteraction,
  });
});

app.get("/api/radio/program-audit", async (_req, res) => {
  const state = await db.getState();
  res.json(auditProgramExperience(state));
});

app.get("/api/radio/listen-checks", async (req, res) => {
  const parsedLimit = parseQueryNumber(req.query.limit);
  const limit = parsedLimit && parsedLimit > 0
    ? Math.min(Math.round(parsedLimit), 20)
    : 10;
  res.json(await db.getListenCheckRecords(limit));
});

app.get("/api/radio/listen-acceptance", async (_req, res) => {
  const records = await db.getListenCheckRecords(20);
  res.json(summarizeListenAcceptance(records));
});

app.get("/api/radio/playback-diagnostics", async (_req, res) => {
  try {
    const state = await db.getState();
    res.json(await buildPlaybackDiagnostics(state));
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/radio/discovery-candidates", async (req, res) => {
  const parsedLimit = parseQueryNumber(req.query.limit);
  const limit = parsedLimit && parsedLimit > 0
    ? Math.min(Math.round(parsedLimit), 100)
    : 30;
  res.json(await db.getDiscoveryCandidates(limit));
});

function buildListenProgramSnapshot(state: db.AppState): db.ListenCheckRecord["programSnapshot"] {
  return {
    sessionId: state.currentProgram?.sessionId,
    title: state.currentProgram?.title,
    mood: state.currentProgram?.mood,
    source: state.currentProgram?.source,
    generatedAt: state.currentProgram?.generatedAt,
    currentQueueIndex: state.currentQueueIndex,
    tracks: state.radioQueue.slice(0, 10).map((track) => ({
      id: track.id,
      name: track.name,
      artist: track.artist,
      source: track.source,
      urlSource: track.urlSource,
      duration: track.duration,
    })),
  };
}

function getBoundedString(value: unknown, maxLength = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function getOptionalFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildListenProgramContinuity(
  state: db.AppState,
  startedProgram: unknown,
): db.ListenCheckRecord["programContinuity"] {
  const started = startedProgram && typeof startedProgram === "object"
    ? startedProgram as Record<string, unknown>
    : {};
  const startedSessionId = getBoundedString(started.sessionId);
  const completedSessionId = state.currentProgram?.sessionId;
  const startedGeneratedAt = getOptionalFiniteNumber(started.generatedAt);
  const completedGeneratedAt = state.currentProgram?.generatedAt;
  const sessionMatches = Boolean(
    startedSessionId
      && completedSessionId
      && startedSessionId === completedSessionId,
  );
  const generatedAtMatches = Boolean(
    startedGeneratedAt !== undefined
      && completedGeneratedAt !== undefined
      && startedGeneratedAt === completedGeneratedAt,
  );

  return {
    ok: sessionMatches || generatedAtMatches,
    startedSessionId,
    completedSessionId,
    startedGeneratedAt,
    completedGeneratedAt,
  };
}

function normalizeEvidenceTrackKey(title?: string, artist?: string): string {
  return `${(title ?? "").trim().toLowerCase()}::${(artist ?? "").trim().toLowerCase()}`;
}

function normalizeClientPlaybackIssueCode(value: unknown): string {
  if (typeof value !== "string") return "client_playback_issue";
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 48);
  return CLIENT_PLAYBACK_ISSUE_CODES.has(normalized) ? normalized : "client_playback_issue";
}

async function recordClientPlaybackIssue(payload: unknown): Promise<db.AppState> {
  const raw = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const data = raw.data && typeof raw.data === "object"
    ? raw.data as Record<string, unknown>
    : raw;
  const state = await db.getState();
  const queue = Array.isArray(state.radioQueue) ? state.radioQueue : [];
  const currentIndex = clampQueueIndex(queue.length, state.currentQueueIndex);
  const currentTrack = state.currentTrack ?? queue[currentIndex] ?? null;

  if (!currentTrack) {
    return state;
  }

  const trackId = getBoundedString(data.trackId, 160);
  if (
    trackId
    && currentTrack.id !== trackId
    && currentTrack.url !== trackId
  ) {
    return state;
  }

  const code = normalizeClientPlaybackIssueCode(data.code);
  const fallbackMessage = code === "client_silent_audio"
    ? "Browser detected progressing playback with very low audio signal"
    : "Browser reported a playback issue";
  const message = getBoundedString(data.message, 180) ?? fallbackMessage;
  const issue = {
    code,
    message,
    at: Date.now(),
  };
  const updatedCurrentTrack: db.Track = {
    ...currentTrack,
    playbackHealth: "failed",
    lastPlaybackIssue: issue,
  };
  const updatedQueue = queue.map((track, index) => {
    const isCurrentQueueTrack = index === currentIndex;
    const matchesCurrent = track.id === currentTrack.id || track.url === currentTrack.url;
    const matchesPayload = Boolean(trackId && (track.id === trackId || track.url === trackId));
    return isCurrentQueueTrack || matchesCurrent || matchesPayload
      ? {
          ...track,
          playbackHealth: "failed" as const,
          lastPlaybackIssue: issue,
        }
      : track;
  });

  return updatePlaybackState({
    radioQueue: updatedQueue,
    currentTrack: updatedCurrentTrack,
    lastInteraction: Date.now(),
  }, state);
}

function buildListenEvidence(
  state: db.AppState,
  startedAt: number,
  completedAt: number,
  playbackSegments?: db.ListenCheckRecord["playbackSegments"],
  clientAudioEvidence?: {
    signalSampleCount: number;
    lowSignalSampleCount: number;
    silentMs: number;
    maxSilentRunMs: number;
  },
): db.ListenCheckEvidence {
  const queue = Array.isArray(state.radioQueue) ? state.radioQueue : [];
  const discoveryCandidates = Array.isArray(state.discoveryCandidates) ? state.discoveryCandidates : [];
  const discoveryByTrackKey = new Map(
    discoveryCandidates.map((candidate) => [
      normalizeEvidenceTrackKey(candidate.title, candidate.artist),
      candidate,
    ]),
  );
  const discoveryTracks = queue
    .flatMap((track) => {
      const candidate = discoveryByTrackKey.get(normalizeEvidenceTrackKey(track.name, track.artist));
      return candidate
        ? [{
            title: track.name,
            artist: track.artist,
            risk: candidate.risk,
          }]
        : [];
    })
    .slice(0, 10);
  const feedbackCount = Array.isArray(state.userFeedback)
    ? state.userFeedback.filter((feedback) =>
        feedback.createdAt >= startedAt && feedback.createdAt <= completedAt
      ).length
    : 0;
  const djLineCount = Array.isArray(state.chatHistory)
    ? state.chatHistory.filter((message) =>
        message.role === "dj"
        && message.timestamp >= startedAt
        && message.timestamp <= completedAt
      ).length
    : 0;
  const recentIssues = queue
    .flatMap((track) => [track.lastPlaybackIssue, track.lastResolveError]
      .flatMap((issue) => issue
        ? [{
            code: issue.code,
            message: issue.message,
            at: issue.at,
            trackTitle: track.name,
          }]
        : []))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, 6);
  const fallbackCount = queue.filter((track) =>
    track.playbackHealth === "fallback"
    || (Boolean(track.source) && Boolean(track.urlSource) && track.source !== track.urlSource)
  ).length;
  const playedTrackCount = playbackSegments?.length ?? 0;

  return {
    playbackIssueCount: recentIssues.length,
    fallbackCount,
    discoveryCount: discoveryTracks.length,
    feedbackCount,
    djLineCount,
    playedTrackCount,
    clientSignalSampleCount: clientAudioEvidence?.signalSampleCount,
    clientLowSignalSampleCount: clientAudioEvidence?.lowSignalSampleCount,
    clientSilentMs: clientAudioEvidence?.silentMs,
    clientMaxSilentRunMs: clientAudioEvidence?.maxSilentRunMs,
    discoveryTracks,
    recentIssues,
  };
}

function normalizeListenClientAudioEvidence(value: unknown): {
  signalSampleCount: number;
  lowSignalSampleCount: number;
  silentMs: number;
  maxSilentRunMs: number;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const normalizeCount = (input: unknown, max: number) => {
    const numeric = Math.round(Number(input));
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return Math.min(numeric, max);
  };
  const normalizeMs = (input: unknown) => {
    const numeric = Math.round(Number(input));
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return Math.min(numeric, 24 * 60 * 60 * 1000);
  };
  const signalSampleCount = normalizeCount(raw.signalSampleCount, 200_000);
  const lowSignalSampleCount = Math.min(
    normalizeCount(raw.lowSignalSampleCount, 200_000),
    signalSampleCount,
  );
  const silentMs = normalizeMs(raw.silentMs);
  const maxSilentRunMs = Math.min(normalizeMs(raw.maxSilentRunMs), silentMs);
  return {
    signalSampleCount,
    lowSignalSampleCount,
    silentMs,
    maxSilentRunMs,
  };
}

function normalizeListenPlaybackSegments(
  value: unknown,
  maxPlaybackMs: number,
): db.ListenCheckRecord["playbackSegments"] {
  if (!Array.isArray(value) || maxPlaybackMs <= 0) return undefined;

  let remainingMs = Math.max(0, Math.round(maxPlaybackMs));
  const segments: NonNullable<db.ListenCheckRecord["playbackSegments"]> = [];
  const byTrackId = new Map<string, NonNullable<db.ListenCheckRecord["playbackSegments"]>[number]>();

  for (const rawSegment of value.slice(0, 100)) {
    if (remainingMs <= 0) break;
    if (!rawSegment || typeof rawSegment !== "object") continue;

    const segment = rawSegment as Record<string, unknown>;
    const trackId = getBoundedString(segment.trackId, 160);
    const playedMs = Math.round(Number(segment.playedMs));
    if (!trackId || !Number.isFinite(playedMs) || playedMs <= 0) continue;

    const clippedPlayedMs = Math.min(playedMs, remainingMs);
    remainingMs -= clippedPlayedMs;
    const existing = byTrackId.get(trackId);
    if (existing) {
      existing.playedMs += clippedPlayedMs;
      continue;
    }

    const normalized = {
      trackId,
      title: getBoundedString(segment.title, 160) ?? "Unknown Title",
      artist: getBoundedString(segment.artist, 160) ?? "Unknown Artist",
      playedMs: clippedPlayedMs,
    };
    byTrackId.set(trackId, normalized);
    segments.push(normalized);
  }

  return segments.length > 0 ? segments.slice(0, 20) : undefined;
}

app.post("/api/radio/listen-checks", async (req, res) => {
  const body = req.body as Record<string, any>;
  const startedAt = Number(body?.startedAt);
  const completedAt = Number(body?.completedAt);
  const checks = body?.checks as Record<string, unknown> | undefined;
  const durationMs = completedAt - startedAt;
  const rawPlaybackMs = Number(body?.playbackMs);
  const playbackMs = Number.isFinite(rawPlaybackMs) && rawPlaybackMs >= 0
    ? Math.min(Math.round(rawPlaybackMs), Math.max(0, durationMs))
    : durationMs;
  const note = typeof body?.note === "string"
    ? body.note.trim().slice(0, 500)
    : "";
  const needsFollowUp = body?.needsFollowUp === true;

  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || durationMs < 0) {
    res.status(400).json({ error: "startedAt and completedAt must be valid timestamps" });
    return;
  }

  const normalizedChecks = {
    program: checks?.program === true,
    dj: checks?.dj === true,
    context: checks?.context === true,
  };

  const state = await db.getState();
  const audit = auditProgramExperience(state);
  const programAudit = {
    ok: audit.ok,
    plannedMinutes: audit.plannedMinutes,
    trackCount: audit.trackCount,
    speechSlotCount: audit.speechSlotCount,
    issueCount: audit.issues.length,
  };
  const playbackSegments = normalizeListenPlaybackSegments(body?.playbackSegments, playbackMs);
  const clientAudioEvidence = normalizeListenClientAudioEvidence(body?.clientAudioEvidence);

  const record = await db.addListenCheckRecord({
    startedAt,
    completedAt,
    durationMs,
    playbackMs,
    playbackSegments,
    checks: normalizedChecks,
    note,
    needsFollowUp,
    programAudit,
    programContinuity: buildListenProgramContinuity(state, body?.startedProgram),
    listenEvidence: buildListenEvidence(state, startedAt, completedAt, playbackSegments, clientAudioEvidence),
    programSnapshot: buildListenProgramSnapshot(state),
  });
  res.status(201).json(record);
});

app.get("/api/taste", async (_req, res) => {
  const state = await db.getState();
  res.json(state.djProfile);
});

app.put("/api/taste", async (req, res) => {
  const { voice, style, name } = req.body || {};
  const patch: Record<string, string> = {};
  if (typeof voice === "string") patch.voice = voice;
  if (typeof style === "string") patch.style = style;
  if (typeof name === "string") patch.name = name;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No valid fields" });
  const updated = await db.updateState({ djProfile: { ...(await db.getState()).djProfile, ...patch } as any });
  res.json(updated.djProfile);
});

app.post("/api/history", async (req, res) => {
  const { title, artist } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });
  await db.recordPlay(title, artist || "");
  res.json({ ok: true });
});

app.get("/api/history", async (_req, res) => {
  const history = await db.getPlayHistory();
  res.json(history);
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendDistDir, "index.html"));
});

export function broadcast(data: object) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function clampQueueIndex(queueLength: number, index: number | undefined): number {
  if (queueLength <= 0) {
    return 0;
  }
  return Math.min(Math.max(typeof index === "number" ? index : 0, 0), queueLength - 1);
}

function getQueueStepContext(state: db.AppState, step = 1) {
  const queue = Array.isArray(state.radioQueue) ? state.radioQueue : [];
  if (!state.currentTrack || queue.length === 0) {
    return null;
  }

  const currentIndex = clampQueueIndex(queue.length, state.currentQueueIndex);
  const nextIndex = (currentIndex + step + queue.length) % queue.length;
  const currentTrack = queue[currentIndex] ?? state.currentTrack;
  const nextTrack = queue[nextIndex];
  if (!currentTrack || !nextTrack) {
    return null;
  }

  return {
    queue,
    currentIndex,
    nextIndex,
    currentTrack,
    nextTrack,
  };
}

function buildPreparedQueueTransitionKey(state: db.AppState, step = 1): string | null {
  const context = getQueueStepContext(state, step);
  if (!context) {
    return null;
  }

  return [
    step,
    context.currentIndex,
    context.currentTrack.id,
    context.nextIndex,
    context.nextTrack.id,
    state.currentProgram?.generatedAt ?? 0,
  ].join(":");
}

function resolveSpeechSlotForTransition(
  state: db.AppState,
  nextIndex: number,
  step = 1,
): db.RadioSpeechSlot | null {
  if (step !== 1) {
    return null;
  }

  const program = state.currentProgram;
  if (!program) {
    return {
      beforeTrackIndex: nextIndex,
      type: "short_say",
      note: "临时队列切歌，保持一句自然接歌",
    };
  }

  const queueLength = Array.isArray(state.radioQueue) ? state.radioQueue.length : 0;
  const speechPlan = program.speechPlan?.length
    ? program.speechPlan
    : radioSession.buildDefaultSpeechPlan(queueLength);
  const slot = speechPlan.find((item) => item.beforeTrackIndex === nextIndex);
  if (!slot || slot.type === "intro") {
    return null;
  }

  return slot;
}

function invalidatePreparedQueueTransition(): void {
  preparedQueueTransitions.clear();
  preparedQueueTransitionInFlight.clear();
}

function getTrackUrlTtlMs(track: db.Track, now = Date.now()): number | null {
  if (typeof track.urlExpiresAt !== "number" || !Number.isFinite(track.urlExpiresAt)) {
    return null;
  }

  return track.urlExpiresAt - now;
}

function getTrackUrlLeaseStatus(
  track: db.Track,
  thresholdMs: number,
  now = Date.now(),
): PlaybackLeaseStatus {
  if (track.lastResolveError) {
    return "failed";
  }
  if (!track.url) {
    return "missing";
  }

  const ttlMs = getTrackUrlTtlMs(track, now);
  if (ttlMs === null) {
    return "unknown";
  }
  if (ttlMs <= 0) {
    return "expired";
  }
  if (ttlMs <= thresholdMs) {
    return "expiring";
  }

  return "ready";
}

function shouldRefreshTrackUrl(track: db.Track, thresholdMs: number, now = Date.now()): boolean {
  return getTrackUrlLeaseStatus(track, thresholdMs, now) !== "ready";
}

function getTrackPlaybackHealth(
  track: db.Track,
  thresholdMs: number,
  now = Date.now(),
): PlaybackHealth {
  if (track.lastResolveError || track.lastPlaybackIssue) {
    return "failed";
  }

  const leaseStatus = getTrackUrlLeaseStatus(track, thresholdMs, now);
  if (leaseStatus === "expired" || leaseStatus === "missing") {
    return "expired";
  }
  if (leaseStatus === "expiring" || leaseStatus === "unknown") {
    return "refreshing";
  }
  if (track.source && track.urlSource && track.urlSource !== track.source) {
    return "fallback";
  }

  return "ready";
}

function buildPlaybackDiagnosticTrack(
  track: db.Track,
  queueIndex: number,
  thresholdMs: number,
  now = Date.now(),
): PlaybackDiagnosticTrack {
  const leaseStatus = getTrackUrlLeaseStatus(track, thresholdMs, now);
  return {
    queueIndex,
    id: track.id,
    name: track.name,
    artist: track.artist,
    source: track.source,
    sourceTrackId: track.sourceTrackId,
    urlSource: track.urlSource,
    urlExpiresAt: track.urlExpiresAt,
    urlRefreshedAt: track.urlRefreshedAt,
    urlTtlMs: getTrackUrlTtlMs(track, now),
    leaseStatus,
    health: getTrackPlaybackHealth(track, thresholdMs, now),
    shouldRefresh: leaseStatus !== "ready",
    lastResolveError: track.lastResolveError,
    lastPlaybackIssue: track.lastPlaybackIssue,
  };
}

async function buildPlaybackDiagnostics(state: db.AppState): Promise<PlaybackDiagnostics> {
  const now = Date.now();
  const queue = Array.isArray(state.radioQueue) ? state.radioQueue : [];
  const currentIndex = clampQueueIndex(queue.length, state.currentQueueIndex);
  const currentTrack = state.currentTrack ?? queue[currentIndex] ?? null;
  const current = currentTrack
    ? buildPlaybackDiagnosticTrack(currentTrack, currentIndex, CURRENT_URL_REFRESH_THRESHOLD_MS, now)
    : null;
  const upcoming = queue.length > 1
    ? Array.from({ length: Math.min(PREFETCH_LOOKAHEAD_COUNT, queue.length - 1) }, (_, index) => {
        const step = index + 1;
        const queueIndex = (currentIndex + step + queue.length) % queue.length;
        const track = queue[queueIndex];
        return track
          ? buildPlaybackDiagnosticTrack(track, queueIndex, UPCOMING_URL_REFRESH_THRESHOLD_MS, now)
          : null;
      }).filter((track): track is PlaybackDiagnosticTrack => Boolean(track))
    : [];
  const runtimeStatus = await musicSources.getMusicSourceRuntimeStatus();
  const recentIssue = current?.lastPlaybackIssue
    ?? current?.lastResolveError
    ?? upcoming.find((track) => track.lastPlaybackIssue || track.lastResolveError)?.lastPlaybackIssue
    ?? upcoming.find((track) => track.lastResolveError)?.lastResolveError;

  return {
    generatedAt: now,
    queueLength: queue.length,
    currentQueueIndex: currentIndex,
    thresholds: {
      currentRefreshMs: CURRENT_URL_REFRESH_THRESHOLD_MS,
      upcomingRefreshMs: UPCOMING_URL_REFRESH_THRESHOLD_MS,
    },
    current,
    upcoming,
    fallbacks: runtimeStatus.playableUrlFallbacks,
    sources: runtimeStatus.sources,
    recentIssue,
  };
}

async function ensurePlayableQueueState(
  options?: {
    refreshCurrentTrack?: boolean;
  },
): Promise<db.AppState> {
  const state = await db.getState();
  if (!options?.refreshCurrentTrack) {
    return state;
  }

  const queue = Array.isArray((state as Partial<db.AppState>).radioQueue)
    ? (state as Partial<db.AppState>).radioQueue as db.Track[]
    : [];
  const currentQueueIndex = typeof (state as Partial<db.AppState>).currentQueueIndex === "number"
    ? (state as Partial<db.AppState>).currentQueueIndex as number
    : 0;

  if (queue.length === 0 || !state.currentTrack) {
    return state;
  }

  if (!shouldRefreshTrackUrl(state.currentTrack, CURRENT_URL_REFRESH_THRESHOLD_MS)) {
    return state;
  }

  const refreshedTrack = await refreshTrackUrl(state.currentTrack, {
    forceRefresh: true,
  });
  if (!hasPlaybackResolutionChanged(refreshedTrack, state.currentTrack)) {
    return state;
  }

  const boundedIndex = Math.min(
    Math.max(currentQueueIndex, 0),
    Math.max(queue.length - 1, 0),
  );
  const refreshedQueue = queue.map((track, index) =>
    index === boundedIndex ? refreshedTrack : track,
  );

  return updatePlaybackState({
    radioQueue: refreshedQueue,
    currentTrack: refreshedTrack,
  }, state);
}

function hasPlaybackResolutionChanged(next: db.Track, previous: db.Track | undefined): boolean {
  if (!previous) {
    return true;
  }

  return next.url !== previous.url
    || next.urlSource !== previous.urlSource
    || next.urlExpiresAt !== previous.urlExpiresAt
    || next.urlRefreshedAt !== previous.urlRefreshedAt
    || next.playbackHealth !== previous.playbackHealth
    || next.lastPlaybackIssue?.code !== previous.lastPlaybackIssue?.code
    || next.lastPlaybackIssue?.message !== previous.lastPlaybackIssue?.message
    || next.lastResolveError?.code !== previous.lastResolveError?.code
    || next.lastResolveError?.message !== previous.lastResolveError?.message;
}

async function updatePlaybackState(
  patch: Partial<db.AppState>,
  fallbackState: db.AppState,
): Promise<db.AppState> {
  const updated = await db.updateState(patch);
  return updated ?? {
    ...fallbackState,
    ...patch,
  };
}

async function refreshTrackUrl(
  track: db.Track,
  options?: {
    forceRefresh?: boolean;
  },
): Promise<db.Track> {
  const refreshedTrack = await musicSources.refreshStoredTrackPlayableUrl(track, {
    forceRefresh: options?.forceRefresh ?? true,
  });
  if (refreshedTrack.lastResolveError) {
    console.warn(
      `[radio] failed to refresh track url for ${track.name}: ${refreshedTrack.lastResolveError.message}`,
    );
  }

  return refreshedTrack;
}

async function primeUpcomingQueueTransition(step = 1): Promise<PreparedQueueTransition | null> {
  const state = await db.getState();
  const key = buildPreparedQueueTransitionKey(state, step);
  const context = getQueueStepContext(state, step);
  if (!key || !context) {
    invalidatePreparedQueueTransition();
    return null;
  }

  const preparedTransition = preparedQueueTransitions.get(key);
  if (preparedTransition) {
    return preparedTransition;
  }

  const inFlight = preparedQueueTransitionInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const pending = (async () => {
    let nextTrack = shouldRefreshTrackUrl(context.nextTrack, UPCOMING_URL_REFRESH_THRESHOLD_MS)
      ? await refreshTrackUrl(context.nextTrack, { forceRefresh: true })
      : context.nextTrack;
    if (hasPlaybackResolutionChanged(nextTrack, context.nextTrack)) {
      const updatedQueue = context.queue.map((track, index) =>
        index === context.nextIndex ? nextTrack : track,
      );
      await db.updateState({
        radioQueue: updatedQueue,
      });
    }

    const speechSlot = resolveSpeechSlotForTransition(state, context.nextIndex, step);
    const transition: { text?: string; ttsAudioPath?: string } = speechSlot
      ? await buildTransitionReply(context.currentTrack, nextTrack, speechSlot)
      : {};
    const prepared: PreparedQueueTransition = {
      key,
      step,
      sourceTrackId: context.currentTrack.id,
      sourceQueueIndex: context.currentIndex,
      nextTrackId: nextTrack.id,
      nextQueueIndex: context.nextIndex,
      nextTrack,
      text: transition.text,
      ttsAudioPath: transition.ttsAudioPath,
      preparedAt: Date.now(),
    };
    preparedQueueTransitions.set(key, prepared);
    return prepared;
  })();
  preparedQueueTransitionInFlight.set(key, pending);

  try {
    return await pending;
  } catch (error) {
    console.warn(`[radio] prefetch queue transition failed: ${getErrorMessage(error)}`);
    preparedQueueTransitions.delete(key);
    return null;
  } finally {
    preparedQueueTransitionInFlight.delete(key);
  }
}

async function getPreparedQueueTransitionForAdvance(
  previousState: db.AppState,
  step: number,
): Promise<PreparedQueueTransition | null> {
  const key = buildPreparedQueueTransitionKey(previousState, step);
  if (!key) {
    return null;
  }

  const preparedTransition = preparedQueueTransitions.get(key);
  if (preparedTransition) {
    return preparedTransition;
  }

  const inFlight = preparedQueueTransitionInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  return null;
}

async function refreshUpcomingQueueUrls(startStep: number, count: number): Promise<number[]> {
  const state = await db.getState();
  const queue = Array.isArray(state.radioQueue) ? state.radioQueue : [];
  if (!state.currentTrack || queue.length <= 1) {
    return [];
  }

  const maxStep = Math.min(count, queue.length - 1);
  if (startStep > maxStep) {
    return [];
  }

  const currentIndex = clampQueueIndex(queue.length, state.currentQueueIndex);
  const results = await Promise.allSettled(
    Array.from({ length: maxStep - startStep + 1 }, async (_, offset) => {
      const step = startStep + offset;
      const nextIndex = (currentIndex + step + queue.length) % queue.length;
      const track = queue[nextIndex];
      if (!track) {
        return null;
      }
      if (!shouldRefreshTrackUrl(track, UPCOMING_URL_REFRESH_THRESHOLD_MS)) {
        return null;
      }
      const refreshed = await refreshTrackUrl(track, { forceRefresh: true });
      return { index: nextIndex, track: refreshed };
    }),
  );

  const refreshedByIndex = new Map<number, db.Track>();
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      refreshedByIndex.set(result.value.index, result.value.track);
    }
  }

  if (refreshedByIndex.size === 0) {
    return [];
  }

  const updatedQueue = queue.map((track, index) => refreshedByIndex.get(index) ?? track);
  const changed = updatedQueue.some((track, index) => hasPlaybackResolutionChanged(track, queue[index]));
  if (changed) {
    await db.updateState({ radioQueue: updatedQueue });
  }

  return Array.from(refreshedByIndex.keys()).sort((a, b) => a - b);
}

async function markPreparedUntilIndex(preparedIndexes: number[]): Promise<void> {
  if (preparedIndexes.length === 0) {
    return;
  }

  const state = await db.getState();
  if (!state.currentProgram) {
    return;
  }

  await db.updateState({
    currentProgram: {
      ...state.currentProgram,
      preparedUntilIndex: Math.max(...preparedIndexes),
    },
  });
}

async function primeUpcomingQueueWindow(count = PREFETCH_LOOKAHEAD_COUNT): Promise<void> {
  const preparedIndexes: number[] = [];
  const firstTransition = await primeUpcomingQueueTransition(1);
  if (firstTransition) {
    preparedIndexes.push(firstTransition.nextQueueIndex);
  }

  const refreshedIndexes = await refreshUpcomingQueueUrls(2, count);
  preparedIndexes.push(...refreshedIndexes);
  await markPreparedUntilIndex(preparedIndexes);
}

async function broadcastStateSnapshot(
  options?: {
    refreshCurrentTrack?: boolean;
  },
) {
  const state = await ensurePlayableQueueState({
    refreshCurrentTrack: options?.refreshCurrentTrack ?? false,
  });
  broadcast({ type: "state", data: state });
}

async function maintainPlaybackQueueLeases(): Promise<void> {
  if (wss.clients.size === 0) {
    return;
  }

  const before = await db.getState();
  const nextState = await ensurePlayableQueueState({ refreshCurrentTrack: true });
  const currentChanged = nextState.currentTrack && before.currentTrack
    ? hasPlaybackResolutionChanged(nextState.currentTrack, before.currentTrack)
    : nextState.currentTrack !== before.currentTrack;
  const refreshedIndexes = await refreshUpcomingQueueUrls(1, PREFETCH_LOOKAHEAD_COUNT);
  if (currentChanged || refreshedIndexes.length > 0) {
    await broadcastStateSnapshot();
  }
}

function startPlaybackLeaseMaintenanceLoop(): void {
  if (isTestEnv() || playbackLeaseMaintenanceTimer) {
    return;
  }

  playbackLeaseMaintenanceTimer = setInterval(() => {
    void maintainPlaybackQueueLeases().catch((error) => {
      console.warn(`[radio] playback lease maintenance failed: ${getErrorMessage(error)}`);
    });
  }, PLAYBACK_LEASE_MAINTENANCE_INTERVAL_MS);
  playbackLeaseMaintenanceTimer.unref?.();
}

function stopPlaybackLeaseMaintenanceLoop(): void {
  if (!playbackLeaseMaintenanceTimer) {
    return;
  }

  clearInterval(playbackLeaseMaintenanceTimer);
  playbackLeaseMaintenanceTimer = null;
}

async function broadcastPipelineResult(result: pipeline.PipelineResult) {
  invalidatePreparedQueueTransition();
  const timestamp = Date.now();
  await broadcastStateSnapshot();
  broadcast({ type: "status", data: "speaking" });
  broadcast({
    type: "dj_message",
    data: {
      text: result.djMessage,
      ttsAudioPath: result.ttsAudioPath,
      timestamp,
    },
  });

  if (result.shouldStartTrack !== false && result.tracks && result.tracks.length > 0) {
    broadcast({ type: "track", data: toClientTrack(result.tracks[0]) });
  }

  broadcast({ type: "status", data: "playing" });
}

async function speakChatText(
  state: db.AppState,
  text: string,
  atmosphere?: string,
): Promise<string | undefined> {
  try {
    const ttsResult = await tts.speak(text, {
      profile: state.djProfile,
      scene: "chat_reply",
      atmosphere,
    });
    return ttsResult.cachePath;
  } catch (error) {
    console.error("Chat TTS failed:", error);
    return undefined;
  }
}

async function broadcastDjChatReply(replyText: string, ttsAudioPath?: string): Promise<void> {
  if (ttsAudioPath) {
    broadcast({ type: "status", data: "speaking" });
  }

  const djTimestamp = Date.now();
  broadcast({ type: "dj_message", data: { text: replyText, ttsAudioPath, timestamp: djTimestamp } });
  await db.addChatMessage({ role: "dj", text: replyText, timestamp: djTimestamp });
}

function buildCurrentTrackReply(state: db.AppState): string {
  const useEnglish = djLanguage.usesEnglishDjCopy(state.djProfile);
  if (!state.currentTrack) {
    return djLanguage.pickDjCopy(
      state.djProfile,
      "现在还没有正在播放的歌曲，我可以先帮你接上一首合适的。",
      "Nothing is playing right now, but I can line up something that fits.",
    );
  }

  const trackLabel = `${state.currentTrack.name} - ${state.currentTrack.artist}`;
  return useEnglish
    ? `The track playing now is ${trackLabel}.`
    : `现在播的是 ${trackLabel}。`;
}

function buildReplyFallback(state: db.AppState, route: ChatRoute): string {
  if (route.intent === "recommendation_reason" && state.currentTrack) {
    const programNote = state.currentProgram?.summary
      ? `这首歌接在这里，是因为${state.currentProgram.summary}`
      : "这首歌放在这里，是想让当前这段情绪更顺一点。";
    return djLanguage.pickDjCopy(
      state.djProfile,
      programNote,
      state.currentProgram?.summary
        ? `I placed it here because ${state.currentProgram.summary}`
        : "I placed this track here to keep the mood moving naturally.",
    );
  }

  return djLanguage.pickDjCopy(
    state.djProfile,
    "我在听。你可以继续说，我会顺着你的状态把后面的音乐接好。",
    "I'm listening. Keep talking, and I'll shape the next part around you.",
  );
}

function buildReplyOnlyPrompt(text: string, route: ChatRoute, state: db.AppState): string {
  const language = djLanguage.resolveDjCopyLanguage(state.djProfile);
  const useEnglish = language === "en";
  const recentHistory = state.chatHistory
    .slice(-6)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");
  const currentTrack = state.currentTrack
    ? `${state.currentTrack.name} - ${state.currentTrack.artist}`
    : useEnglish ? "nothing playing" : "当前没有正在播放的歌曲";
  const currentProgram = [
    state.currentProgram?.title ? `title: ${state.currentProgram.title}` : "",
    state.currentProgram?.summary ? `summary: ${state.currentProgram.summary}` : "",
  ].filter(Boolean).join("; ");
  const routeSummary = JSON.stringify({
    intent: route.intent,
    action: route.action,
    reason: route.reason,
  });

  if (useEnglish) {
    return `The listener sent: ${JSON.stringify(text)}

Chat Intent Router result: ${routeSummary}
Current track: ${currentTrack}
Current program: ${currentProgram || "none"}
Recent conversation:
${recentHistory || "none"}

You are Claudio, an AI emotional radio DJ. The router has already decided this is a reply-only interaction.
No weather context is provided because this is not a weather request. Do not mention weather, temperature, rain, or forecast.

Return JSON only. Required fields:
- action: "reply_only"
- say: the line shown in the UI, natural English, 10-28 words, warm and conversational, no inline audio tags
- ttsText: same meaning as say, normal conversational pace, no slow/deep/whisper/theatrical stage directions

If the intent is recommendation_reason, explain the current track using only the current track and current program notes. Do not invent private listener data.
If the intent is emotion_expression, acknowledge the feeling briefly and keep the show moving gently.
`;
  }

  return `用户发来一条消息：${JSON.stringify(text)}

Chat Intent Router 结果：${routeSummary}
当前歌曲：${currentTrack}
当前节目：${currentProgram || "无"}
最近对话：
${recentHistory || "无"}

你是 Claudio，AI 情感电台 DJ。router 已经判断这次只需要自然回复，不需要查天气、不需要切歌。
这次没有提供天气上下文，因为用户没有明确问天气。不要主动提天气、气温、下雨或预报。

请输出 JSON，不要 Markdown，不要额外说明。字段必须是：
- action: "reply_only"
- say: 前端显示给用户的话，中文 30-80 字，温柔自然，不要包含音频标签
- ttsText: 给 MiMo TTS 朗读的文本，语义必须与 say 一致，保持正常聊天语速，不要加入低声、语速放慢、故作深沉或表演化标签

如果 intent 是 recommendation_reason，只能基于当前歌曲和当前节目说明推荐原因，不要编造用户隐私或不存在的资料。
如果 intent 是 emotion_expression，先轻轻承接情绪，再自然把后面的音乐接住。
`;
}

function buildWeatherPrompt(text: string, weatherContext: string | undefined, state: db.AppState): string {
  const useEnglish = djLanguage.usesEnglishDjCopy(state.djProfile);
  const recentHistory = state.chatHistory
    .slice(-4)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");

  if (useEnglish) {
    return `The listener asked about the weather: ${JSON.stringify(text)}

Weather context:
${weatherContext || "unavailable"}

Recent conversation:
${recentHistory || "none"}

You are Claudio, an AI emotional radio DJ. Return JSON only.
- action: "answer_weather"
- say: answer the weather question naturally in English, 12-34 words, based only on the weather context above
- ttsText: same meaning as say, normal conversational pace, no slow/deep/whisper/theatrical stage directions

If the weather context is unavailable, say you cannot get the latest weather right now.
`;
  }

  return `用户明确询问天气：${JSON.stringify(text)}

天气上下文：
${weatherContext || "不可用"}

最近对话：
${recentHistory || "无"}

你是 Claudio，AI 情感电台 DJ。请输出 JSON，不要 Markdown，不要额外说明。
- action: "answer_weather"
- say: 自然回答天气问题，中文 30-90 字，只能基于上面的天气上下文
- ttsText: 给 MiMo TTS 朗读的文本，语义必须与 say 一致，保持正常聊天语速，不要加入低声、语速放慢、故作深沉或表演化标签

如果天气上下文不可用，就说明现在拿不到最新天气，不要编造。
`;
}

async function answerWeatherChat(text: string): Promise<void> {
  const state = await db.getState();
  const useEnglish = djLanguage.usesEnglishDjCopy(state.djProfile);
  let weatherContext: string | undefined;
  try {
    weatherContext = await weather.getDefaultWeatherPromptContext();
  } catch (error) {
    console.warn(`[chat] weather answer skipped: ${getErrorMessage(error)}`);
  }

  const fallbackText = weatherContext
    ? (useEnglish ? `Here is the latest weather I have: ${weatherContext}.` : `我看了一下，${weatherContext}。`)
    : djLanguage.pickDjCopy(
      state.djProfile,
      "我现在拿不到最新天气数据，所以不想乱报。你可以稍后再问我一次。",
      "I can't get the latest weather right now, so I don't want to guess.",
    );
  let replyText = fallbackText;
  let replyTtsText = fallbackText;

  try {
    const reply = await claude.callJsonLLM<ChatReplyPayload>(
      buildWeatherPrompt(text, weatherContext, state),
      20_000,
    );
    replyText = reply.say?.trim() || replyText;
    replyTtsText = reply.ttsText?.trim() || replyText;
  } catch {
    // keep fallback text
  }

  const ttsAudioPath = await speakChatText(
    state,
    replyTtsText,
    [weatherContext, text].filter(Boolean).join("；"),
  );
  await broadcastDjChatReply(replyText, ttsAudioPath);
}

async function replyOnlyChat(text: string, route: ChatRoute): Promise<void> {
  const state = await db.getState();

  if (route.intent === "current_track_query") {
    const replyText = buildCurrentTrackReply(state);
    const ttsAudioPath = await speakChatText(
      state,
      replyText,
      [state.currentTrack?.name, state.currentTrack?.artist].filter(Boolean).join(" - "),
    );
    await broadcastDjChatReply(replyText, ttsAudioPath);
    return;
  }

  let replyText = buildReplyFallback(state, route);
  let replyTtsText = replyText;

  try {
    const reply = await claude.callJsonLLM<ChatReplyPayload>(
      buildReplyOnlyPrompt(text, route, state),
      20_000,
    );
    replyText = reply.say?.trim() || replyText;
    replyTtsText = reply.ttsText?.trim() || replyText;
  } catch {
    // keep fallback text
  }

  const atmosphere = [
    route.intent,
    state.currentProgram?.title,
    state.currentProgram?.summary,
    text,
  ].filter(Boolean).join("；");
  const ttsAudioPath = await speakChatText(state, replyTtsText, atmosphere);
  await broadcastDjChatReply(replyText, ttsAudioPath);
}

function splitTransitionSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?。！？])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function clampEnglishTransitionText(text: string, fallbackText: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallbackText;
  const sentences = splitTransitionSentences(normalized);
  const picked: string[] = [];
  for (const sentence of sentences.length ? sentences : [normalized]) {
    const next = [...picked, sentence].join(" ");
    const wordCount = next.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 20 && next.length <= 94) {
      picked.push(sentence);
    }
    if (picked.length > 0 && (wordCount >= 14 || next.length >= 72)) break;
  }
  const joined = picked.join(" ").trim();
  if (joined) return joined;

  const words = normalized.split(/\s+/).filter(Boolean).slice(0, 18);
  const clipped = words.join(" ").replace(/[,:;，、；：]+$/u, "").trim();
  return clipped ? `${clipped}.` : fallbackText;
}

function clampChineseTransitionText(text: string, fallbackText: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallbackText;
  if (normalized.length <= 58) return normalized;
  const firstSentence = normalized.split(/[。！？!?]/u).map((part) => part.trim()).filter(Boolean)[0];
  const candidate = firstSentence && firstSentence.length <= 58
    ? firstSentence
    : normalized.slice(0, 56).replace(/[，、；：,.!?！？。]+$/u, "");
  return candidate ? `${candidate}。` : fallbackText;
}

function clampTransitionText(text: string, fallbackText: string, useEnglish: boolean): string {
  return useEnglish
    ? clampEnglishTransitionText(text, fallbackText)
    : clampChineseTransitionText(text, fallbackText);
}

async function buildTransitionReply(
  previousTrack: db.Track | null,
  nextTrack: db.Track,
  speechSlot: db.RadioSpeechSlot,
): Promise<{ text: string; ttsAudioPath?: string }> {
  const state = await db.getState();
  const language = djLanguage.resolveDjCopyLanguage(state.djProfile);
  const useEnglish = language === "en";
  const weatherContext: string | undefined = undefined;
  const currentProgram = state.currentProgram;
  const timeOfDay = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const hostStyleGuide = radioStyle.buildHostStyleGuide(timeOfDay, weatherContext, language);
  const segueKind = radioStyle.inferSegueKind({
    timeOfDay,
    weatherContext,
    queueLength: state.radioQueue.length,
    nextIndex: state.currentQueueIndex,
  });
  const segueDirective = radioStyle.buildSegueDirective(segueKind, language);
  const speechSlotLabel = speechSlot.type === "bumper"
    ? (useEnglish ? "station ID / bumper" : "station ID / bumper")
    : speechSlot.type === "closing"
      ? (useEnglish ? "closing" : "收束")
      : (useEnglish ? "short talk" : "短讲");
  const recentDjLines = state.chatHistory
    .filter((message) => message.role === "dj")
    .slice(-3)
    .map((message) => `- ${message.text}`)
    .join("\n");
  const fallbackText = previousTrack
    ? djLanguage.pickDjCopy(
      state.djProfile,
      `${previousTrack.name} 收得比较轻，接 ${nextTrack.name} 会让节奏继续稳住。`,
      `${previousTrack.name} lands softly, so ${nextTrack.name} keeps the rhythm steady.`,
    )
    : djLanguage.pickDjCopy(
      state.djProfile,
      `接下来 ${nextTrack.name}，先把主线放稳。`,
      `Up next is ${nextTrack.name}, keeping the main line steady.`,
    );

  if (speechSlot.type === "bumper") {
    const bumperText = djLanguage.pickDjCopy(
      state.djProfile,
      `Claudio FM，继续把这一段听感放稳。下一首，${nextTrack.name}。`,
      `Claudio FM. Keeping this set in motion with ${nextTrack.name}.`,
    );

    try {
      const ttsResult = await tts.speak(bumperText, {
        profile: state.djProfile,
        scene: "segue",
        atmosphere: [currentProgram?.title, currentProgram?.mood, speechSlot.note].filter(Boolean).join("；"),
      });
      return {
        text: bumperText,
        ttsAudioPath: ttsResult.cachePath,
      };
    } catch {
      return {
        text: bumperText,
      };
    }
  }

  let replyText = fallbackText;
  let replyTtsText = fallbackText;

  try {
    const prompt = useEnglish
      ? `You are Claudio, an AI emotional radio DJ.
${hostStyleGuide}
${segueDirective}
${currentProgram?.title ? `Current show: ${currentProgram.title}` : "Current show: untitled"}
${currentProgram?.summary ? `Program note: ${currentProgram.summary}` : ""}
${weatherContext ? `Current weather: ${weatherContext}` : ""}
Speech slot: ${speechSlotLabel}
Slot note: ${speechSlot.note || "none"}
Previous track: ${previousTrack ? `${previousTrack.name} - ${previousTrack.artist}` : "unknown"}
Next track: ${nextTrack.name} - ${nextTrack.artist}
${recentDjLines ? `A few recent DJ lines you already said:\n${recentDjLines}` : ""}

Return JSON only. No markdown, no extra explanation.
- say: one natural radio segue, natural English, 8-24 words, like a real DJ handing one song into the next
- ttsText: same meaning as say, normal conversational pace, no slow/deep/whisper/theatrical performance tags

Extra constraints:
- Do not reintroduce yourself
- Do not say things like "good evening", "welcome back", or "I'm Claudio" as if the show restarted
- Do not repeat wording that is too close to the last few lines
- Say one concrete judgment about the handoff: tempo, vocal, rhythm, melody, texture, or why the next track belongs here
- Prefer one track-specific detail over abstract mood words
- Avoid vague filler such as "atmosphere", "vibe", "room", "light", "temperature", "story", "dream", unless tied to a concrete musical detail
- If this is a closing slot, give the section a soft landing without sounding final unless the note asks for it
- The focus is the handoff from the previous track to the next, not a long lyrical monologue
`
      : `你是 Claudio，一位 AI 情感电台 DJ。
${hostStyleGuide}
${segueDirective}
${currentProgram?.title ? `当前节目：${currentProgram.title}` : "当前节目：未命名节目"}
${currentProgram?.summary ? `节目思路：${currentProgram.summary}` : ""}
${weatherContext ? `当前天气：${weatherContext}` : ""}
发言位置：${speechSlotLabel}
发言备注：${speechSlot.note || "无"}
上一首：${previousTrack ? `${previousTrack.name} - ${previousTrack.artist}` : "未知"}
下一首：${nextTrack.name} - ${nextTrack.artist}
${recentDjLines ? `最近几句你刚说过的话：\n${recentDjLines}` : ""}

请输出 JSON，不要 markdown，不要额外说明：
- say: 一句自然的电台串场词，中文 18-45 字，要像 DJ 真的在接歌
- ttsText: 给 TTS 的版本，语义与 say 一致，保持正常聊天语速，不要加入低声、语速放慢、故作深沉或表演化标签

额外限制：
- 不要重新自我介绍
- 不要说“下午好/晚上好/欢迎回来/我是 Claudio”这类重新开场的话
- 不要重复最近几句已经说过的表述
- 必须说一个具体判断：节奏、人声、旋律、鼓点、吉他、钢琴、音色，或者为什么下一首适合接在这里
- 优先说歌曲本身的变化，不要只说“氛围、情绪、房间、灯光、温度、故事、梦”这类抽象词
- 如果用了抽象词，必须同时给出一个具体音乐理由
- 如果是收束位置，要让这一小段有落点，但不要像整档节目结束，除非备注要求
- 重点是把上一首自然接到下一首，不要写成长段抒情文
`;

    const reply = await claude.callJsonLLM<TransitionReplyPayload>(prompt, 25_000);
    replyText = clampTransitionText(reply.say?.trim() || fallbackText, fallbackText, useEnglish);
    replyTtsText = clampTransitionText(reply.ttsText?.trim() || replyText, replyText, useEnglish);
  } catch {
    // keep fallback text
  }

  try {
    const ttsResult = await tts.speak(replyTtsText, {
      profile: state.djProfile,
      scene: "segue",
      atmosphere: [currentProgram?.title, currentProgram?.summary, weatherContext].filter(Boolean).join("；"),
    });
    return {
      text: replyText,
      ttsAudioPath: ttsResult.cachePath,
    };
  } catch {
    return {
      text: replyText,
    };
  }
}

function parseQueueAdvanceFeedback(payload: any): { type: db.UserFeedbackType; note: string } | null {
  const reason = typeof (payload.data?.reason ?? payload.reason) === "string"
    ? (payload.data?.reason ?? payload.reason).trim()
    : "";
  if (reason === "track_complete") {
    return { type: "complete_track", note: "implicit: track completed" };
  }
  if (reason === "manual_skip" || reason === "chat_skip") {
    const positionSec = Number(payload.data?.positionSec ?? payload.positionSec);
    const durationSec = Number(payload.data?.durationSec ?? payload.durationSec);
    const played = Number.isFinite(positionSec) && positionSec >= 0 ? `${Math.round(positionSec)}s` : "unknown";
    const duration = Number.isFinite(durationSec) && durationSec > 0 ? `${Math.round(durationSec)}s` : "unknown";
    return { type: "skip_track", note: `implicit: ${reason}; played ${played}/${duration}` };
  }
  return null;
}

async function advanceQueueWithSegue(
  step: number,
  options?: {
    feedback?: { type: db.UserFeedbackType; note: string } | null;
  },
) {
  const previousState = await db.getState();
  const previousTrack = previousState.currentTrack;
  if (step === 1 && previousTrack && options?.feedback) {
    await addTrackFeedbackFromState(previousState, previousTrack, options.feedback.type, options.feedback.note);
  }
  const preparedTransition = step === 1
    ? await getPreparedQueueTransitionForAdvance(previousState, step)
    : null;
  const nextState = await db.advanceRadioQueue(step);
  if (!nextState?.currentTrack) {
    return null;
  }

  let playableState = nextState;
  let transition: { text?: string; ttsAudioPath?: string } = {};
  const canUsePreparedTransition =
    Boolean(preparedTransition)
    && Boolean(previousTrack)
    && preparedTransition!.step === step
    && preparedTransition!.sourceTrackId === previousTrack!.id
    && preparedTransition!.nextQueueIndex === nextState.currentQueueIndex
    && preparedTransition!.nextTrackId === nextState.currentTrack.id;

  if (canUsePreparedTransition && preparedTransition) {
    const updatedQueue = nextState.radioQueue.map((track, index) =>
      index === nextState.currentQueueIndex ? preparedTransition.nextTrack : track,
    );
    playableState = await updatePlaybackState({
      radioQueue: updatedQueue,
      currentTrack: preparedTransition.nextTrack,
    }, nextState);
    transition = {
      text: preparedTransition.text,
      ttsAudioPath: preparedTransition.ttsAudioPath,
    };
  } else {
    const refreshedTrack = shouldRefreshTrackUrl(nextState.currentTrack, CURRENT_URL_REFRESH_THRESHOLD_MS)
      ? await refreshTrackUrl(nextState.currentTrack, { forceRefresh: true })
      : nextState.currentTrack;
    if (hasPlaybackResolutionChanged(refreshedTrack, nextState.currentTrack)) {
      const updatedQueue = nextState.radioQueue.map((track, index) =>
        index === nextState.currentQueueIndex ? refreshedTrack : track,
      );
      playableState = await updatePlaybackState({
        radioQueue: updatedQueue,
        currentTrack: refreshedTrack,
      }, nextState);
    }
    const speechSlot = resolveSpeechSlotForTransition(playableState, playableState.currentQueueIndex, step);
    transition = speechSlot
      ? await buildTransitionReply(previousTrack, playableState.currentTrack!, speechSlot)
      : {};
  }

  invalidatePreparedQueueTransition();

  await db.recordPlay(playableState.currentTrack!.name, playableState.currentTrack!.artist);
  const timestamp = Date.now();

  await broadcastStateSnapshot();
  if (transition.ttsAudioPath) {
    broadcast({ type: "status", data: "speaking" });
  }
  if (transition.text) {
    broadcast({
      type: "dj_message",
      data: {
        text: transition.text,
        ttsAudioPath: transition.ttsAudioPath,
        timestamp,
      },
    });
  }
  broadcast({
    type: "track",
    data: toClientStoredTrack(playableState.currentTrack!),
  });
  broadcast({ type: "status", data: "playing" });

  if (transition.text) {
    await db.addChatMessage({
      role: "dj",
      text: transition.text,
      timestamp,
    });
  }

  return playableState;
}

async function playSelectedQueueTrack(
  trackId: string,
  options?: {
    forceRefresh?: boolean;
  },
) {
  invalidatePreparedQueueTransition();
  const selectedState = await db.selectRadioQueueTrack(trackId);
  if (!selectedState?.currentTrack) {
    return null;
  }

  const needsRefresh = options?.forceRefresh === true
    || shouldRefreshTrackUrl(selectedState.currentTrack, CURRENT_URL_REFRESH_THRESHOLD_MS);
  const refreshedTrack = needsRefresh
    ? await refreshTrackUrl(selectedState.currentTrack, { forceRefresh: true })
    : selectedState.currentTrack;
  let playableState = selectedState;
  if (hasPlaybackResolutionChanged(refreshedTrack, selectedState.currentTrack)) {
    const updatedQueue = selectedState.radioQueue.map((track, index) =>
      index === selectedState.currentQueueIndex ? refreshedTrack : track,
    );
    playableState = await updatePlaybackState({
      radioQueue: updatedQueue,
      currentTrack: refreshedTrack,
    }, selectedState);
  }

  await db.recordPlay(playableState.currentTrack!.name, playableState.currentTrack!.artist);
  await broadcastStateSnapshot();
  broadcast({
    type: "track",
    data: toClientStoredTrack(playableState.currentTrack!),
  });
  broadcast({ type: "status", data: "playing" });
  return playableState;
}

async function initializeStartupRadioProgram() {
  if (isTestEnv()) {
    return;
  }

  try {
    const state = await db.getState();
    const snapshot = await db.getNeteaseSnapshot();
    const localLibraryStatus = await musicSources.getLocalLibraryStatus({ sampleLimit: 0 });
    const hasUserMusicContext =
      state.playlists.length > 0
      || Boolean(snapshot?.playlists.length)
      || (localLibraryStatus.enabled && localLibraryStatus.trackCount > 0);

    if (!hasUserMusicContext) {
      console.log("[radio] skip startup program: no playlist context available yet");
      return;
    }

    console.log("[radio] generating startup program from weather + playlist context");
    const result = await pipeline.runStartupRadioProgram({ background: true });
    console.log(`[radio] startup program ready${result.programTitle ? `: ${result.programTitle}` : ""}`);
    if (wss.clients.size > 0) {
      await broadcastPipelineResult(result);
    }
  } catch (error) {
    console.error("[radio] startup program failed:", error);
  }
}

wss.on("connection", async (ws) => {
  const state = await ensurePlayableQueueState({ refreshCurrentTrack: true });
  ws.send(JSON.stringify({ type: "state", data: state }));

  ws.on("message", async (message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.type === "trigger") {
        const mode = parseWsTriggerMode(payload);
        if (!mode) {
          ws.send(JSON.stringify({ type: "error", data: { message: "Invalid mode" } }));
          return;
        }

        broadcast({ type: "status", data: "thinking" });

        try {
          const result = await pipeline.runPipeline(mode);
          await broadcastPipelineResult(result);
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", data: { message: getErrorMessage(error) } }));
        }
        return;
      }

      if (payload.type === "queue_next") {
        try {
          const nextState = await advanceQueueWithSegue(1, {
            feedback: parseQueueAdvanceFeedback(payload),
          });
          if (!nextState?.currentTrack) {
            ws.send(JSON.stringify({ type: "error", data: { message: "当前没有可切换的歌曲队列" } }));
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", data: { message: getErrorMessage(error) } }));
        }
        return;
      }

      if (payload.type === "queue_prefetch") {
        try {
          await primeUpcomingQueueWindow(PREFETCH_LOOKAHEAD_COUNT);
          await broadcastStateSnapshot();
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", data: { message: getErrorMessage(error) } }));
        }
        return;
      }

      if (payload.type === "queue_previous") {
        try {
          const nextState = await advanceQueueWithSegue(-1);
          if (!nextState?.currentTrack) {
            ws.send(JSON.stringify({ type: "error", data: { message: "当前没有可切换的歌曲队列" } }));
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", data: { message: getErrorMessage(error) } }));
        }
        return;
      }

      if (payload.type === "queue_select") {
        const trackId = typeof (payload.data?.trackId ?? payload.trackId) === "string"
          ? (payload.data?.trackId ?? payload.trackId).trim()
          : "";
        if (!trackId) {
          ws.send(JSON.stringify({ type: "error", data: { message: "trackId required" } }));
          return;
        }
        const forceRefresh = (payload.data?.forceRefresh ?? payload.forceRefresh) === true;

        try {
          const nextState = await playSelectedQueueTrack(trackId, { forceRefresh });
          if (!nextState?.currentTrack) {
            ws.send(JSON.stringify({ type: "error", data: { message: "未找到对应的队列歌曲" } }));
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", data: { message: getErrorMessage(error) } }));
        }
        return;
      }

      if (payload.type === "playback_issue") {
        try {
          await recordClientPlaybackIssue(payload);
          await broadcastStateSnapshot();
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", data: { message: getErrorMessage(error) } }));
        }
        return;
      }
      
      if (payload.type === "chat") {
        const text = typeof (payload.data?.text ?? payload.text) === "string"
          ? (payload.data?.text ?? payload.text).trim()
          : "";
        if (!text) return;

        const userTimestamp = Date.now();
        await db.addChatMessage({ role: "user", text, timestamp: userTimestamp });
        broadcast({ type: "chat", data: { role: "user", text, timestamp: userTimestamp } });

        const chatRoute = routeChatIntent(text);
        if (chatRoute.action === "answer_weather") {
          await answerWeatherChat(text);
          return;
        }

        if (chatRoute.action === "skip_track") {
          const nextState = await advanceQueueWithSegue(1, {
            feedback: { type: "skip_track", note: "implicit: chat_skip" },
          });
          if (!nextState?.currentTrack) {
            ws.send(JSON.stringify({ type: "error", data: { message: "当前没有可切换的歌曲队列" } }));
          }
          return;
        }

        if (chatRoute.action === "resume_queue") {
          const state = await ensurePlayableQueueState();
          if (!state.currentTrack) {
            ws.send(JSON.stringify({ type: "error", data: { message: "当前没有可播放的歌曲队列" } }));
            return;
          }

          const djTimestamp = Date.now();
          const replyText = djLanguage.pickDjCopy(
            state.djProfile,
            `好，先把这首 ${state.currentTrack.name} 放给你。`,
            `Alright, let's start with ${state.currentTrack.name}.`,
          );
          broadcast({
            type: "dj_message",
            data: { text: replyText, timestamp: djTimestamp },
          });
          await db.addChatMessage({ role: "dj", text: replyText, timestamp: djTimestamp });
          broadcast({
            type: "track",
            data: toClientStoredTrack(state.currentTrack),
          });
          broadcast({ type: "status", data: "playing" });
          return;
        }

        if (chatRoute.action === "replan_queue") {
          broadcast({ type: "status", data: "thinking" });
          try {
            const result = await pipeline.runChatSwitchProgram(text, {
              preserveCurrentTrack: chatRoute.preserveCurrentTrack ?? true,
            });
            await broadcastPipelineResult(result);
          } catch (error) {
            ws.send(JSON.stringify({ type: "error", data: { message: getErrorMessage(error) } }));
          }
          return;
        }

        if (chatRoute.action === "trigger_pipeline" && chatRoute.mode) {
          broadcast({ type: "status", data: "thinking" });
          try {
            const result = await pipeline.runPipeline(chatRoute.mode);
            await broadcastPipelineResult(result);
          } catch (error) {
            ws.send(JSON.stringify({ type: "error", data: { message: getErrorMessage(error) } }));
          }
          return;
        }

        if (chatRoute.intent === "recommendation_reason") {
          const state = await db.getState();
          if (state.currentTrack) {
            await addTrackFeedbackFromState(state, state.currentTrack, "ask_about_track", "implicit: recommendation reason question");
          }
        }

        await replyOnlyChat(text, chatRoute);
      }
    } catch (e) {}
  });
});

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url || "", `http://${request.headers.host}`);

  if (pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.on("close", () => {
  stopPlaybackLeaseMaintenanceLoop();
  wss.clients.forEach((client) => {
    client.terminate();
  });
});

export function startServer(port?: number | string) {
  const PORT = port !== undefined ? port : (process.env.PORT || 3000);
  if (!isTestEnv()) {
    void db.setStatus("idle");
  }
  void weather.startWeatherRefreshLoop();
  startPlaybackLeaseMaintenanceLoop();
  return server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    void initializeStartupRadioProgram();
  });
}

if (process.env.NODE_ENV !== "test" && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer();
}
