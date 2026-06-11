import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AppStatus,
  ChatEntry,
  DJMessage,
  DiscoveryCandidateRecord,
  FavoriteTrackItem,
  PlayerState,
  PlayHistoryEntry,
  TrackFeedbackType,
  TriggerMode,
  TtsPreset,
  UserFeedbackRecord,
} from "../types";
import { useLayout } from "./LayoutManager";
import { PixelClock } from "./PixelClock";

const USER_DISPLAY_NAME = "xian";

interface MobileRadioLayoutProps {
  playerState: PlayerState;
  messages: ChatEntry[];
  djMessages: DJMessage[];
  favoriteTracks: FavoriteTrackItem[];
  playHistory: PlayHistoryEntry[];
  userFeedback: UserFeedbackRecord[];
  discoveryCandidates: DiscoveryCandidateRecord[];
  status: AppStatus;
  statusText: string;
  isConnected: boolean;
  utilityNotice: string | null;
  visualizerBars: number[];
  voicePreset: TtsPreset;
  isUpdatingVoicePreset: boolean;
  userAvatarUrl: string | null;
  isTriggerBusy: boolean;
  subtitle: string;
  subtitleFading: boolean;
  profileSwitcher?: ReactNode;
  onSendMessage: (text: string) => void;
  onReplayAudio: (messageId: string) => void;
  onVoicePresetChange: (preset: TtsPreset) => void;
  onVoiceAction: () => void;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (time: number) => void;
  onVolumeChange: (volume: number) => void;
  onToggleFavorite: (trackId: string) => void;
  onTrackFeedback: (type: TrackFeedbackType) => void;
  onSelectTrack: (trackId: string) => void;
  onTrigger: (mode: TriggerMode) => void;
  onUserAvatarUpload: (file: File) => Promise<void>;
  onUtilityNotice: (message: string) => void;
}

type FeedItem =
  | { type: "chat"; data: ChatEntry }
  | { type: "dj"; data: DJMessage };

const formatPlaybackTime = (timeInSeconds: number) => {
  if (!Number.isFinite(timeInSeconds) || timeInSeconds <= 0) return "0:00";
  const minutes = Math.floor(timeInSeconds / 60);
  const seconds = Math.floor(timeInSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const normalizeDurationSeconds = (duration: number) => (
  Number.isFinite(duration) && duration > 1000 ? duration / 1000 : duration
);

const formatDayLabel = (date: Date) =>
  date.toLocaleDateString("en-US", { weekday: "long" });

const formatDateLabel = (date: Date) => {
  const day = date.getDate().toString().padStart(2, "0");
  const month = date.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  return `${day} - ${month} - ${date.getFullYear()}`;
};

const formatHistoryTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const MobileRadioLayout: React.FC<MobileRadioLayoutProps> = ({
  playerState,
  messages,
  djMessages,
  favoriteTracks,
  playHistory,
  userFeedback,
  discoveryCandidates,
  status,
  statusText,
  isConnected,
  utilityNotice,
  visualizerBars,
  voicePreset,
  isUpdatingVoicePreset,
  userAvatarUrl,
  isTriggerBusy,
  subtitle,
  subtitleFading,
  profileSwitcher,
  onSendMessage,
  onReplayAudio,
  onVoicePresetChange,
  onVoiceAction,
  onPlayPause,
  onNext,
  onPrevious,
  onSeek,
  onVolumeChange,
  onToggleFavorite,
  onTrackFeedback,
  onSelectTrack,
  onTrigger,
  onUserAvatarUpload,
  onUtilityNotice,
}) => {
  const { theme, setTheme } = useLayout();
  const [now, setNow] = useState(() => new Date());
  const [inputText, setInputText] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const feed = useMemo<FeedItem[]>(() => {
    return [
      ...messages.map((message) => ({ type: "chat" as const, data: message })),
      ...djMessages.map((message) => ({ type: "dj" as const, data: message })),
    ].sort((a, b) => {
      const timeA = typeof a.data.timestamp === "number" ? a.data.timestamp : 0;
      const timeB = typeof b.data.timestamp === "number" ? b.data.timestamp : 0;
      if (timeA !== timeB) return timeA - timeB;
      return a.data.id.localeCompare(b.data.id);
    });
  }, [messages, djMessages]);

  useEffect(() => {
    if (!chatScrollRef.current) return;
    chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [feed, detailsOpen]);

  const currentTrack = playerState.currentTrack;
  const currentTrackId = currentTrack?.id ?? currentTrack?.url ?? "";
  const durationSeconds = normalizeDurationSeconds(playerState.duration);
  const currentTimeSeconds = playerState.currentTime > durationSeconds && playerState.currentTime > 1000
    ? playerState.currentTime / 1000
    : playerState.currentTime;
  const isCurrentFavorite = Boolean(
    currentTrack?.isFavorite
      || favoriteTracks.some((track) => track.id === currentTrackId || track.url === currentTrack?.url),
  );
  const progressPercent = durationSeconds > 0
    ? Math.min(100, Math.max(0, (currentTimeSeconds / durationSeconds) * 100))
    : 0;
  const queueCount = playerState.queueCount || playerState.playlist.length;
  const readyDiscoveryCount = discoveryCandidates.filter((item) => item.health === "ready").length;

  const handleSend = () => {
    const text = inputText.trim();
    if (!text) return;
    onSendMessage(text);
    setInputText("");
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    handleSend();
  };

  const handleProgressClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!durationSeconds) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    onSeek(durationSeconds * ratio);
  };

  const handleVoiceAction = () => {
    onVoiceAction();
    setVoiceHint("Voice input coming soon");
    window.setTimeout(() => setVoiceHint(null), 2200);
  };

  const handleVoicePresetToggle = () => {
    if (isUpdatingVoicePreset) return;
    onVoicePresetChange(voicePreset === "冰糖" ? "Dean" : "冰糖");
  };

  const renderAvatar = (className: string, label = USER_DISPLAY_NAME) => (
    <div className={`mobile-radio-avatar ${className}`}>
      {userAvatarUrl ? (
        <img src={userAvatarUrl} alt={label} />
      ) : (
        <span>{label.slice(0, 1).toUpperCase()}</span>
      )}
    </div>
  );

  const renderClaudioAvatar = () => (
    <div className="mobile-claudio-avatar" aria-hidden="true">
      <span></span>
    </div>
  );

  const renderVisualizer = () => (
    <div className="mobile-eq" aria-hidden="true">
      {(visualizerBars.length ? visualizerBars : [0.2, 0.55, 0.35]).slice(0, 8).map((value, index) => (
        <span
          key={index}
          style={{
            height: `${Math.max(18, Math.round(18 + value * 34))}%`,
            animationDelay: `${index * 0.08}s`,
          }}
        />
      ))}
    </div>
  );

  const renderPlaybackButton = () => (
    <button
      type="button"
      className="mobile-control-btn mobile-control-btn-primary"
      onClick={onPlayPause}
      aria-label={playerState.isPlaying ? "Pause" : "Play"}
    >
      {playerState.isPlaying ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6 5h4v14H6V5Zm8 0h4v14h-4V5Z" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M8 5v14l11-7L8 5Z" />
        </svg>
      )}
    </button>
  );

  const renderDetailsPanel = () => (
    <div className="mobile-details-panel">
      <div className="mobile-detail-group">
        <div className="mobile-detail-heading">
          <span>FEEDBACK</span>
          <span>{userFeedback.length}</span>
        </div>
        <div className="mobile-feedback-row">
          <button type="button" disabled={!currentTrack} onClick={() => onTrackFeedback("more_like_this")}>
            More
          </button>
          <button type="button" disabled={!currentTrack} onClick={() => onTrackFeedback("less_like_this")}>
            Less
          </button>
          <button type="button" disabled={!currentTrack} onClick={() => onTrackFeedback("dislike_track")}>
            Nope
          </button>
        </div>
      </div>

      <div className="mobile-detail-group">
        <div className="mobile-detail-heading">
          <span>QUEUE</span>
          <span>{queueCount} TRACKS</span>
        </div>
        <div className="mobile-mini-list">
          {playerState.playlist.length === 0 ? (
            <div className="mobile-empty-line">Queue is empty</div>
          ) : (
            playerState.playlist.slice(0, 4).map((track) => (
              <button
                type="button"
                key={track.id}
                className={`mobile-mini-track ${track.isPlaying ? "mobile-mini-track-active" : ""}`}
                onClick={() => onSelectTrack(track.id)}
              >
                <span>{track.title}</span>
                <small>{track.artist}</small>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="mobile-detail-group">
        <div className="mobile-detail-heading">
          <span>PROGRAM</span>
          <span>{readyDiscoveryCount}/{discoveryCandidates.length} READY</span>
        </div>
        <div className="mobile-trigger-row">
          <button type="button" disabled={isTriggerBusy} onClick={() => onTrigger("morning_brief")}>
            Morning
          </button>
          <button type="button" disabled={isTriggerBusy} onClick={() => onTrigger("mood_pick")}>
            Mood
          </button>
          <button type="button" disabled={isTriggerBusy} onClick={() => onTrigger("random_discover")}>
            Discover
          </button>
        </div>
      </div>

      {playHistory.length > 0 && (
        <div className="mobile-detail-group">
          <div className="mobile-detail-heading">
            <span>RECENT</span>
            <span>{playHistory.length}</span>
          </div>
          <div className="mobile-mini-list">
            {playHistory.slice(0, 3).map((track, index) => (
              <div key={`${track.playedAt}-${index}`} className="mobile-mini-track mobile-mini-track-static">
                <span>{track.title}</span>
                <small>{track.artist} - {formatHistoryTime(track.playedAt)}</small>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const renderChatItem = (item: FeedItem) => {
    if (item.type === "dj") {
      const message = item.data;
      return (
        <div key={message.id} className="mobile-message mobile-message-dj">
          <div className="mobile-message-name">
            {renderClaudioAvatar()}
            <span>{message.sender || "CLAUDIO"}</span>
          </div>
          <div className="mobile-message-row">
            <div className="mobile-dj-bubble">
              <div className="mobile-message-text">
                {message.text.split("\n").map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
              </div>
              {message.hasAudio && (
                <button type="button" onClick={() => onReplayAudio(message.id)} className="mobile-replay-btn">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M8 5v14l11-7L8 5Z" />
                  </svg>
                  Replay
                </button>
              )}
            </div>
          </div>
          <span className="mobile-message-time">{message.time}</span>
        </div>
      );
    }

    const message = item.data;
    if (message.role === "user") {
      return (
        <div key={message.id} className="mobile-message mobile-message-user">
          <div className="mobile-message-name mobile-message-name-user">
            <span>{message.sender || USER_DISPLAY_NAME}</span>
          </div>
          <div className="mobile-message-row">
            <div className="mobile-user-bubble">{message.text}</div>
            {renderAvatar("mobile-message-avatar", message.sender || USER_DISPLAY_NAME)}
          </div>
          <span className="mobile-message-time">{message.time}</span>
        </div>
      );
    }

    return (
      <div key={message.id} className="mobile-message mobile-message-dj">
        <div className="mobile-message-name">
          {renderClaudioAvatar()}
          <span>{message.sender || "CLAUDIO"}</span>
        </div>
        <div className="mobile-message-row">
          <div className="mobile-dj-bubble">
            {message.audioUrl && (
              <button type="button" onClick={() => onReplayAudio(message.id)} className="mobile-inline-play">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M8 5v14l11-7L8 5Z" />
                </svg>
              </button>
            )}
            <div className="mobile-message-text">
              <p>{message.text}</p>
            </div>
          </div>
        </div>
        <span className="mobile-message-time">{message.time}</span>
      </div>
    );
  };

  return (
    <div className="mobile-radio-root claudio-grid-bg claudio-theme-bg claudio-theme-text">
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

      <header className="mobile-radio-topbar">
        <button
          type="button"
          className="mobile-avatar-button"
          onClick={() => avatarInputRef.current?.click()}
          aria-label="Upload avatar"
        >
          {renderAvatar("mobile-top-avatar", USER_DISPLAY_NAME)}
        </button>
        <div className="mobile-logo">
          <span className="mobile-logo-title">Claudio</span>
          <span className="mobile-logo-subtitle">FM</span>
        </div>
        <div className="mobile-top-actions">
          <button type="button" className="mobile-login-pill" onClick={() => onUtilityNotice("Login coming soon")}>
            LOGIN
          </button>
          <div className="mobile-theme-segment" aria-label="Theme">
            <button
              type="button"
              className={theme === "dark" ? "mobile-theme-active" : ""}
              onClick={() => setTheme("dark")}
            >
              Dark
            </button>
            <button
              type="button"
              className={theme === "light" ? "mobile-theme-active" : ""}
              onClick={() => setTheme("light")}
            >
              Light
            </button>
          </div>
        </div>
      </header>

      {profileSwitcher && (
        <div className="mobile-profile-row">
          {profileSwitcher}
        </div>
      )}

      <section className="mobile-clock-stage">
        <PixelClock
          value={now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
          dotSize={5}
          gap={2}
          className="mobile-hero-clock"
        />
        <div className="mobile-clock-day">{formatDayLabel(now)}</div>
        <div className="mobile-clock-date">{formatDateLabel(now)}</div>
        <div className="mobile-on-air">
          <span></span>
          ON AIR
        </div>
      </section>

      <section className="mobile-player-strip">
        <div className="mobile-now-row">
          {renderVisualizer()}
          <div className="mobile-now-copy">
            <span className="mobile-track-title">{currentTrack?.title || "No track loaded"}</span>
            <span className="mobile-track-artist">{currentTrack?.artist || "Claudio is standing by"}</span>
          </div>
          <button
            type="button"
            className={`mobile-fav-btn ${isCurrentFavorite ? "mobile-fav-btn-active" : ""}`}
            disabled={!currentTrackId}
            onClick={() => currentTrackId && onToggleFavorite(currentTrackId)}
            aria-label={isCurrentFavorite ? "Remove favorite" : "Add favorite"}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill={isCurrentFavorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l7.78-7.84 1.06-1a5.5 5.5 0 0 0 0-7.78Z" />
            </svg>
          </button>
        </div>

        <div className="mobile-progress-row" onClick={handleProgressClick}>
          <span>{formatPlaybackTime(currentTimeSeconds)}</span>
          <div className="mobile-progress-rail">
            <div className="mobile-progress-fill" style={{ width: `${progressPercent}%` }}></div>
          </div>
          <span>{formatPlaybackTime(durationSeconds)}</span>
        </div>

        <div className="mobile-controls-row">
          <button type="button" className="mobile-control-btn" onClick={onPrevious} aria-label="Previous track">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 6h2v12H7V6Zm10 12-7-6 7-6v12Z" />
            </svg>
          </button>
          {renderPlaybackButton()}
          <button type="button" className="mobile-control-btn" onClick={onNext} aria-label="Next track">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M15 6h2v12h-2V6ZM5 18l7-6-7-6v12Z" />
            </svg>
          </button>
          <label className="mobile-volume-control">
            <span>VOL</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={playerState.volume}
              onChange={(event) => onVolumeChange(Number(event.target.value))}
              aria-label="Volume"
            />
          </label>
        </div>
      </section>

      <button type="button" className="mobile-queue-strip" onClick={() => setDetailsOpen((open) => !open)}>
        <span>QUEUE</span>
        <strong>{queueCount} TRACKS</strong>
        <em>{isConnected ? "LIVE" : "OFFLINE"}</em>
      </button>

      <section ref={chatScrollRef} className="mobile-chat-feed claudio-scrollbar">
        {detailsOpen && renderDetailsPanel()}

        {utilityNotice && (
          <div className="mobile-status-note">
            {utilityNotice}
          </div>
        )}

        {status !== "idle" && status !== "playing" && (
          <div className="mobile-status-note">
            {statusText}
          </div>
        )}

        {feed.length === 0 ? (
          <div className="mobile-empty-chat">
            Connected to Claudio server
          </div>
        ) : (
          feed.map(renderChatItem)
        )}
      </section>

      {subtitle && (
        <div className={`mobile-subtitle ${subtitleFading ? "mobile-subtitle-fading" : ""}`}>
          {subtitle}
        </div>
      )}

      {voiceHint && (
        <div className="mobile-voice-hint">
          {voiceHint}
        </div>
      )}

      <footer className="mobile-input-bar">
        <button
          type="button"
          className="mobile-voice-preset"
          onClick={handleVoicePresetToggle}
          disabled={isUpdatingVoicePreset}
        >
          {voicePreset}
        </button>
        <div className="mobile-input-wrap">
          <input
            type="text"
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Say something to the DJ..."
          />
        </div>
        <button type="button" className="mobile-round-btn" onClick={handleVoiceAction} aria-label="Voice input">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <path d="M12 19v3" />
          </svg>
        </button>
        <button
          type="button"
          className="mobile-send-btn"
          onClick={handleSend}
          disabled={!inputText.trim()}
          aria-label="Send message"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        </button>
      </footer>
    </div>
  );
};

export default MobileRadioLayout;
