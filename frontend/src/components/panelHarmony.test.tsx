import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LocalLibraryStatus, PlayerState } from "../types";
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

describe("split panel harmony", () => {
  it("keeps the player progress rail inside the dock divider", () => {
    const markup = renderToStaticMarkup(
      <LayoutManager>
        <PlayerPanel
          playerState={playerState}
          favoriteTracks={[]}
          playHistory={[]}
          tasteProfile={null}
          isSyncingLibrary={false}
          lastSyncSummary={null}
          localLibraryStatus={localLibraryStatus}
          isRescanningLocalLibrary={false}
          utilityNotice={null}
          visualizerBars={Array.from({ length: 12 }, () => 0.2)}
          onPlayPause={() => {}}
          onNext={() => {}}
          onPrevious={() => {}}
          onSeek={() => {}}
          onVolumeChange={() => {}}
          onToggleFavorite={() => {}}
          onSelectTrack={() => {}}
          onPlaySavedTrack={() => {}}
          onUserAvatarUpload={async () => {}}
          onFullscreenToggle={() => {}}
          isFullscreen={false}
          onTrigger={() => {}}
          onSyncLibrary={() => {}}
          onRetryFailedSync={() => {}}
          onRescanLocalLibrary={() => {}}
          isTriggerBusy={false}
          statusText="Now playing"
          status="playing"
        />
      </LayoutManager>,
    );

    expect(markup).toContain("player-dock-shell");
    expect(markup).toContain("player-dock-progress");
    expect(markup).toContain("claudio-bottom-bar");
    expect(markup.indexOf("player-dock-progress")).toBeLessThan(markup.indexOf("player-dock-grid"));
    expect(markup).toMatch(/1:05<\/span><span class="flex-shrink-0">\/<\/span><span class="flex-shrink-0">3:20/);
  });

  it("shows local library readiness in the empty player state", () => {
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
          tasteProfile={null}
          isSyncingLibrary={false}
          lastSyncSummary={null}
          localLibraryStatus={localLibraryStatus}
          isRescanningLocalLibrary={false}
          utilityNotice={null}
          visualizerBars={Array.from({ length: 12 }, () => 0.2)}
          onPlayPause={() => {}}
          onNext={() => {}}
          onPrevious={() => {}}
          onSeek={() => {}}
          onVolumeChange={() => {}}
          onToggleFavorite={() => {}}
          onSelectTrack={() => {}}
          onPlaySavedTrack={() => {}}
          onUserAvatarUpload={async () => {}}
          onFullscreenToggle={() => {}}
          isFullscreen={false}
          onTrigger={() => {}}
          onSyncLibrary={() => {}}
          onRetryFailedSync={() => {}}
          onRescanLocalLibrary={() => {}}
          isTriggerBusy={false}
          statusText="Now playing"
          status="playing"
        />
      </LayoutManager>,
    );

    expect(markup).toContain("2 local tracks");
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
          statusText="Ready"
          currentTrack={null}
        />
      </LayoutManager>,
    );

    expect(markup).toContain("claudio-bottom-bar");
    expect(markup).toContain("CONNECTED");
  });
});
