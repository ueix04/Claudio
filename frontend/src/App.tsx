import { useState, type CSSProperties, type FormEvent } from "react";
import type { UserProfile } from "./types";
import { LayoutManager, useLayout } from "./components/LayoutManager";
import { PlayerPanel } from "./components/PlayerPanel";
import { ChatPanel } from "./components/ChatPanel";
import { MobileRadioLayout } from "./components/MobileRadioLayout";
import { useWebSocket } from "./hooks/useWebSocket";
import { resolveAppShellAudioEffectClass } from "./audio-effects";

function AppLayout() {
  const { mode, audioEffect, isCompactLayout } = useLayout();
  const {
    profiles,
    currentProfileId,
    switchProfile,
    createProfile,
    hasHydratedState,
    playerState,
    messages,
    djMessages,
    favoriteTracks,
    playHistory,
    userFeedback,
    discoveryCandidates,
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
    playbackDiagnostics,
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
    subtitleFading,
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
    onTrackFeedback,
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
  const panelStyle = (width: string) => ({ "--app-panel-width": width } as CSSProperties);
  const renderProfileSwitcher = (variant: "floating" | "inline") => (
    <ProfileSwitcher
      profiles={profiles}
      currentProfileId={currentProfileId}
      onSwitchProfile={switchProfile}
      onCreateProfile={async (displayName) => {
        try {
          const profile = await createProfile(displayName);
          showUtilityNotice(`Profile: ${profile.displayName}`);
        } catch (error) {
          showUtilityNotice(error instanceof Error ? error.message : "Create profile failed");
        }
      }}
      variant={variant}
    />
  );

  return (
    <div className="app-frame h-screen h-dvh w-screen overflow-hidden p-3 md:p-4">
      <div className={`app-shell h-full w-full overflow-hidden rounded-[28px] border relative ${appShellEffectClass}`}>
        <div className="app-shell-vignette pointer-events-none absolute inset-0 z-0"></div>
        <div className="absolute inset-0 app-shell-grid pointer-events-none z-0"></div>
        {!isCompactLayout && renderProfileSwitcher("floating")}
        <div className="app-shell-scaled">
          <div className={`relative z-10 h-full w-full ${isCompactLayout ? "mobile-radio-host" : `app-panels app-panels-${mode}`}`}>
            <audio ref={audioRef} className="hidden" preload="auto" />
            <audio ref={nextAudioRef} className="hidden" preload="auto" />
            <audio ref={ttsAudioRef} className="hidden" preload="auto" />

            {isCompactLayout ? (
              <MobileRadioLayout
                playerState={playerState}
                messages={messages}
                djMessages={djMessages}
                favoriteTracks={favoriteTracks}
                playHistory={playHistory}
                userFeedback={userFeedback}
                discoveryCandidates={discoveryCandidates}
                status={status}
                statusText={statusText}
                isConnected={isConnected}
                utilityNotice={utilityNotice}
                visualizerBars={visualizerBars}
                voicePreset={voicePreset}
                isUpdatingVoicePreset={isUpdatingVoicePreset}
                userAvatarUrl={userAvatarUrl}
                isTriggerBusy={isTriggerBusy}
                subtitle={subtitle}
                subtitleFading={subtitleFading}
                profileSwitcher={renderProfileSwitcher("inline")}
                onSendMessage={sendMessage}
                onReplayAudio={onReplayAudio}
                onVoicePresetChange={updateVoicePreset}
                onVoiceAction={() => showUtilityNotice("Voice input coming soon")}
                onPlayPause={onPlayPause}
                onNext={onNext}
                onPrevious={onPrevious}
                onSeek={onSeek}
                onVolumeChange={onVolumeChange}
                onToggleFavorite={onToggleFavorite}
                onTrackFeedback={onTrackFeedback}
                onSelectTrack={onSelectTrack}
                onTrigger={sendTrigger}
                onUserAvatarUpload={setUserAvatarUrl}
                onUtilityNotice={showUtilityNotice}
              />
            ) : (
              <>
                <div
                  className={`app-panel-shell app-panel-player ${mode === "chat-fullscreen" ? "app-panel-shell-hidden" : ""}`}
                  style={panelStyle(playerWidth)}
                >
                  <PlayerPanel
                    playerState={playerState}
                    favoriteTracks={favoriteTracks}
                    playHistory={playHistory}
                    userFeedback={userFeedback}
                    discoveryCandidates={discoveryCandidates}
                    tasteProfile={tasteProfile}
                    isSyncingLibrary={isSyncingLibrary}
                    lastSyncSummary={lastSyncSummary}
                    musicSourceStatus={musicSourceStatus}
                    playbackDiagnostics={playbackDiagnostics}
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
                    onTrackFeedback={onTrackFeedback}
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
                  className={`app-panel-shell app-panel-chat ${mode === "player-fullscreen" ? "app-panel-shell-hidden" : ""}`}
                  style={panelStyle(chatWidth)}
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
                    subtitleFading={subtitleFading}
                    statusText={statusText}
                  />
                </div>
              </>
            )}

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

interface ProfileSwitcherProps {
  profiles: UserProfile[];
  currentProfileId: string;
  onSwitchProfile: (profileId: string) => void;
  onCreateProfile: (displayName?: string) => Promise<void>;
  variant?: "floating" | "inline";
}

function ProfileSwitcher({
  profiles,
  currentProfileId,
  onSwitchProfile,
  onCreateProfile,
  variant = "floating",
}: ProfileSwitcherProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onCreateProfile(draftName.trim() || undefined);
    setDraftName("");
    setIsCreating(false);
  };

  return (
    <div className={`profile-switcher profile-switcher-${variant}`}>
      {isCreating ? (
        <form className="profile-switcher-create" onSubmit={handleCreate}>
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="Profile name"
            maxLength={80}
            autoFocus
          />
          <button type="submit" title="Create profile">Create</button>
          <button type="button" title="Cancel" onClick={() => setIsCreating(false)}>Cancel</button>
        </form>
      ) : (
        <>
          <select
            value={currentProfileId}
            onChange={(event) => onSwitchProfile(event.target.value)}
            title="Profile"
            aria-label="Profile"
          >
            {profiles.length === 0 ? (
              <option value={currentProfileId}>xian</option>
            ) : profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.displayName}
              </option>
            ))}
          </select>
          <button type="button" title="Create profile" onClick={() => setIsCreating(true)}>+</button>
        </>
      )}
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
