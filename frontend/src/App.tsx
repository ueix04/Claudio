import { LayoutManager, useLayout } from "./components/LayoutManager";
import { PlayerPanel } from "./components/PlayerPanel";
import { ChatPanel } from "./components/ChatPanel";
import { useWebSocket } from "./hooks/useWebSocket";
import { resolveAppShellAudioEffectClass } from "./audio-effects";

function AppLayout() {
  const { mode, audioEffect } = useLayout();
  const {
    hasHydratedState,
    playerState,
    messages,
    djMessages,
    favoriteTracks,
    playHistory,
    tasteProfile,
    status,
    isConnected,
    reconnecting,
    audioRef,
    nextAudioRef,
    ttsAudioRef,
    isSyncingLibrary,
    lastSyncSummary,
    musicSourceStatus,
    localLibraryStatus,
    localLibraryMatchStatus,
    programAudit,
    listenCheckRecords,
    listenAcceptance,
    isRescanningLocalLibrary,
    utilityNotice,
    statusText,
    isTriggerBusy,
    subtitle,
    visualizerBars,
    voicePreset,
    isUpdatingVoicePreset,
    userAvatarUrl,
    sendTrigger,
    sendMessage,
    onPlayPause,
    onNext,
    onPrevious,
    onSeek,
    onVolumeChange,
    onToggleFavorite,
    onSelectTrack,
    onReplayAudio,
    updateVoicePreset,
    setUserAvatarUrl,
    syncNeteaseLibrary,
    retryFailedLibrarySync,
    rescanLocalLibrary,
    playSavedTrack,
    refreshLibraryData,
    showUtilityNotice,
  } = useWebSocket();

  const playerWidth = mode === "chat-fullscreen" ? "0%" : mode === "player-fullscreen" ? "100%" : "50%";
  const chatWidth = mode === "player-fullscreen" ? "0%" : mode === "chat-fullscreen" ? "100%" : "50%";
  const appShellEffectClass = resolveAppShellAudioEffectClass(status, audioEffect);

  return (
    <div className="app-frame h-screen h-dvh w-screen overflow-hidden p-3 md:p-4">
      <div className={`app-shell h-full w-full overflow-hidden rounded-[28px] border relative ${appShellEffectClass}`}>
        <div className="app-shell-vignette pointer-events-none absolute inset-0 z-0"></div>
        <div className="absolute inset-0 app-shell-grid pointer-events-none z-0"></div>
        <div className="app-shell-scaled">
          <div className="relative z-10 h-full w-full flex">
            <audio ref={audioRef} className="hidden" preload="auto" />
            <audio ref={nextAudioRef} className="hidden" preload="auto" />
            <audio ref={ttsAudioRef} className="hidden" preload="auto" />

            <div
              className={`app-panel-shell ${mode === "chat-fullscreen" ? "app-panel-shell-hidden" : ""}`}
              style={{ width: playerWidth }}
            >
                <PlayerPanel
                  playerState={playerState}
                  favoriteTracks={favoriteTracks}
                  playHistory={playHistory}
                  tasteProfile={tasteProfile}
                  isSyncingLibrary={isSyncingLibrary}
                  lastSyncSummary={lastSyncSummary}
                  musicSourceStatus={musicSourceStatus}
                  localLibraryStatus={localLibraryStatus}
                  localLibraryMatchStatus={localLibraryMatchStatus}
                  programAudit={programAudit}
                  listenCheckRecords={listenCheckRecords}
                  listenAcceptance={listenAcceptance}
                  isRescanningLocalLibrary={isRescanningLocalLibrary}
                  utilityNotice={utilityNotice}
                  visualizerBars={visualizerBars}
                  onPlayPause={onPlayPause}
                  onNext={onNext}
                  onPrevious={onPrevious}
                  onSeek={onSeek}
                  onVolumeChange={onVolumeChange}
                  onToggleFavorite={onToggleFavorite}
                  onSelectTrack={onSelectTrack}
                  onPlaySavedTrack={playSavedTrack}
                  onUserAvatarUpload={setUserAvatarUrl}
                  onFullscreenToggle={() => {}}
                  isFullscreen={mode === "player-fullscreen"}
                  onTrigger={sendTrigger}
                  onSyncLibrary={syncNeteaseLibrary}
                  onRetryFailedSync={retryFailedLibrarySync}
                  onRescanLocalLibrary={rescanLocalLibrary}
                  onListenCheckSaved={refreshLibraryData}
                  isTriggerBusy={isTriggerBusy}
                  statusText={statusText}
                  status={status}
                />
            </div>
            <div
              className={`app-panel-shell ${mode === "player-fullscreen" ? "app-panel-shell-hidden" : ""}`}
              style={{ width: chatWidth }}
            >
                <ChatPanel
                  messages={messages}
                  djMessages={djMessages}
                  status={status}
                  currentTrack={playerState.currentTrack}
                  isConnected={isConnected}
                  djName="Claudio"
                  djStatus="live"
                  voicePreset={voicePreset}
                  isUpdatingVoicePreset={isUpdatingVoicePreset}
                  userAvatarUrl={userAvatarUrl}
                  onSendMessage={sendMessage}
                  onReplayAudio={onReplayAudio}
                  onVoicePresetChange={updateVoicePreset}
                  onVoiceAction={() => showUtilityNotice("Voice input coming soon")}
                  onFullscreenToggle={() => {}}
                  isFullscreen={mode === "chat-fullscreen"}
                  subtitle={subtitle}
                  statusText={statusText}
                />
            </div>

            {reconnecting && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-[color:var(--claudio-overlay)] backdrop-blur-sm">
                <div className="flex flex-col items-center gap-3">
                  <div className="thinking-spinner w-6 h-6"></div>
                  <span className="text-sm tracking-wider text-[color:var(--claudio-text-dim)]">Reconnecting...</span>
                </div>
              </div>
            )}
            {!hasHydratedState && (
              <div className="absolute inset-0 z-40 flex items-center justify-center bg-[color:var(--claudio-overlay)] backdrop-blur-sm">
                <div className="flex flex-col items-center gap-3">
                  <div className="thinking-spinner w-6 h-6"></div>
                  <span className="text-sm tracking-wider text-[color:var(--claudio-text-dim)]">Restoring session...</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <LayoutManager>
      <AppLayout />
    </LayoutManager>
  );
}
