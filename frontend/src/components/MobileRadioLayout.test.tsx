import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlayerState } from "../types";
import { LayoutManager } from "./LayoutManager";
import { MobileRadioLayout } from "./MobileRadioLayout";

const playerState: PlayerState = {
  currentTrack: {
    id: "track-1",
    url: "/audio/mock.mp3",
    title: "If",
    artist: "Bread",
    duration: 158,
    isFavorite: false,
  },
  isPlaying: true,
  currentTime: 33,
  duration: 158,
  volume: 0.72,
  audioSignalLevel: 0.18,
  playlist: [
    {
      id: "track-1",
      title: "If",
      artist: "Bread",
      duration: 158,
      isPlaying: true,
      url: "/audio/mock.mp3",
    },
  ],
  queueCount: 1,
  status: "playing",
  isOnAir: true,
};

describe("MobileRadioLayout", () => {
  it("renders the mobile radio composition without video caption text", () => {
    const markup = renderToStaticMarkup(
      <LayoutManager>
        <MobileRadioLayout
          playerState={playerState}
          messages={[]}
          djMessages={[
            {
              id: "dj-1",
              sender: "CLAUDIO",
              text: "This is Claudio. Here is a song that moves with your breath.",
              time: "21:02",
              timestamp: 123456789,
              hasAudio: true,
            },
          ]}
          favoriteTracks={[]}
          playHistory={[]}
          userFeedback={[]}
          discoveryCandidates={[]}
          status="playing"
          statusText="Now playing"
          isConnected={true}
          utilityNotice={null}
          visualizerBars={[0.2, 0.7, 0.4]}
          voicePreset="冰糖"
          isUpdatingVoicePreset={false}
          userAvatarUrl={null}
          isTriggerBusy={false}
          subtitle=""
          subtitleFading={false}
          onSendMessage={() => {}}
          onReplayAudio={() => {}}
          onVoicePresetChange={() => {}}
          onVoiceAction={() => {}}
          onPlayPause={() => {}}
          onNext={() => {}}
          onPrevious={() => {}}
          onSeek={() => {}}
          onVolumeChange={() => {}}
          onToggleFavorite={() => {}}
          onTrackFeedback={() => {}}
          onSelectTrack={() => {}}
          onTrigger={() => {}}
          onUserAvatarUpload={async () => {}}
          onUtilityNotice={() => {}}
        />
      </LayoutManager>,
    );

    expect(markup).toContain("mobile-radio-root");
    expect(markup).toContain("Claudio");
    expect(markup).toContain("ON AIR");
    expect(markup).toContain("If");
    expect(markup).toContain("Bread");
    expect(markup).toContain("QUEUE");
    expect(markup).toContain("Say something to the DJ");
    expect(markup).not.toContain("24小时");
  });
});
