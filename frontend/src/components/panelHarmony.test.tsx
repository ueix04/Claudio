import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DiscoveryCandidateRecord, LocalLibraryStatus, PlayerState } from "../types";
import { ChatPanel } from "./ChatPanel";
import { LayoutManager } from "./LayoutManager";
import { PlayerPanel } from "./PlayerPanel";

const playerState: PlayerState = {
  currentTrack: {
    id: "track-1",
    url: "/audio/mock.mp3",
    title: "Warm Light",
    artist: "Claudio FM",
    duration: 200,
    isFavorite: true,
  },
  isPlaying: true,
  currentTime: 65,
  duration: 200,
  volume: 0.72,
  audioSignalLevel: 0.18,
  playlist: [
    {
      id: "track-1",
      title: "Warm Light",
      artist: "Claudio FM",
      duration: 200,
      isPlaying: true,
      url: "/audio/mock.mp3",
    },
  ],
  queueCount: 1,
  status: "playing",
  isOnAir: true,
};

const localLibraryStatus: LocalLibraryStatus = {
  source: "local_library",
  enabled: true,
  configuredDirectoryCount: 1,
  availableDirectoryCount: 1,
  trackCount: 2,
  maxFiles: 2000,
  scanCacheMs: 60000,
  scannedAt: 123456789,
  message: "Local library directories: 1/1; playable files: 2",
  sampleTracks: [
    {
      source: "local_library",
      sourceTrackId: "local_1",
      title: "Local Song",
      artist: "Local Artist",
      album: "Local Album",
    },
  ],
};

const discoveryCandidates: DiscoveryCandidateRecord[] = [
  {
    id: "discovery-1",
    query: "dream pop adjacent",
    direction: "dream pop adjacent",
    title: "Discovery Song",
    artist: "Discovery Artist",
    reason: "Adjacent to current taste.",
    risk: "adjacent",
    source: "netease_legacy",
    sourceTrackId: "123",
    urlSource: "netease_legacy",
    health: "ready",
    createdAt: 123456789,
  },
];

describe("split panel harmony", () => {
  it("keeps the player progress rail inside the dock divider", () => {
    const markup = renderToStaticMarkup(
      <LayoutManager>
        <PlayerPanel
          playerState={playerState}
          favoriteTracks={[]}
          playHistory={[]}
          userFeedback={[]}
          discoveryCandidates={discoveryCandidates}
          tasteProfile={null}
          isSyncingLibrary={false}
          lastSyncSummary={null}
          musicSourceStatus={null}
          playbackDiagnostics={null}
          localLibraryStatus={localLibraryStatus}
          localLibraryMatchStatus={null}
          programAudit={null}
          listenCheckRecords={[]}
          listenAcceptance={null}
          isRescanningLocalLibrary={false}
          utilityNotice={null}
          visualizerBars={Array.from({ length: 12 }, () => 0.2)}
          onPlayPause={() => {}}
          onNext={() => {}}
          onPrevious={() => {}}
          onSeek={() => {}}
          onVolumeChange={() => {}}
          onToggleFavorite={() => {}}
          onTrackFeedback={() => {}}
          onSelectTrack={() => {}}
          onPlaySavedTrack={() => {}}
          onUserAvatarUpload={async () => {}}
          onFullscreenToggle={() => {}}
          isFullscreen={false}
          onTrigger={() => {}}
          onSyncLibrary={() => {}}
          onRetryFailedSync={() => {}}
          onRescanLocalLibrary={() => {}}
          onListenCheckSaved={() => {}}
          isTriggerBusy={false}
          statusText="Now playing"
          status="playing"
        />
      </LayoutManager>,
    );

    expect(markup).toContain("player-dock-shell");
    expect(markup).toContain("player-dock-progress");
    expect(markup).toContain("claudio-bottom-bar");
    expect(markup).toContain("DISCOVERY CANDIDATES");
    expect(markup).toContain("Discovery Song");
    expect(markup.indexOf("player-dock-progress")).toBeLessThan(markup.indexOf("player-dock-grid"));
    expect(markup).toMatch(/1:05<\/span><span class="flex-shrink-0">\/<\/span><span class="flex-shrink-0">3:20/);
  });

  it("shows online source standby in the empty player state", () => {
    const markup = renderToStaticMarkup(
      <LayoutManager>
        <PlayerPanel
          playerState={{
            ...playerState,
            currentTrack: null,
            playlist: [],
            queueCount: 0,
            isPlaying: false,
          }}
          favoriteTracks={[]}
          playHistory={[]}
          userFeedback={[]}
          discoveryCandidates={[]}
          tasteProfile={null}
          isSyncingLibrary={false}
          lastSyncSummary={null}
          musicSourceStatus={null}
          playbackDiagnostics={null}
          localLibraryStatus={localLibraryStatus}
          localLibraryMatchStatus={null}
          programAudit={null}
          listenCheckRecords={[]}
          listenAcceptance={null}
          isRescanningLocalLibrary={false}
          utilityNotice={null}
          visualizerBars={Array.from({ length: 12 }, () => 0.2)}
          onPlayPause={() => {}}
          onNext={() => {}}
          onPrevious={() => {}}
          onSeek={() => {}}
          onVolumeChange={() => {}}
          onToggleFavorite={() => {}}
          onTrackFeedback={() => {}}
          onSelectTrack={() => {}}
          onPlaySavedTrack={() => {}}
          onUserAvatarUpload={async () => {}}
          onFullscreenToggle={() => {}}
          isFullscreen={false}
          onTrigger={() => {}}
          onSyncLibrary={() => {}}
          onRetryFailedSync={() => {}}
          onRescanLocalLibrary={() => {}}
          onListenCheckSaved={() => {}}
          isTriggerBusy={false}
          statusText="Now playing"
          status="playing"
        />
      </LayoutManager>,
    );

    expect(markup).toContain("Online sources standby");
  });

  it("uses the same bottom bar skin in the chat panel", () => {
    const markup = renderToStaticMarkup(
      <LayoutManager>
        <ChatPanel
          messages={[]}
          djMessages={[]}
          status="idle"
          isConnected={true}
          djName="Claudio"
          djStatus="live"
          voicePreset="冰糖"
          isUpdatingVoicePreset={false}
          userAvatarUrl={null}
          onSendMessage={() => {}}
          onReplayAudio={() => {}}
          onVoicePresetChange={() => {}}
          onVoiceAction={() => {}}
          onFullscreenToggle={() => {}}
          isFullscreen={false}
          subtitle=""
          subtitleFading={false}
          statusText="Ready"
          currentTrack={null}
        />
      </LayoutManager>,
    );

    expect(markup).toContain("claudio-bottom-bar");
    expect(markup).toContain("CONNECTED");
  });
});
