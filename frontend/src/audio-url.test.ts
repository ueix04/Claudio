import { describe, expect, it } from "vitest";
import { buildPlaybackIssuePayload, toPlayableAudioUrl } from "./hooks/useWebSocket";

describe("toPlayableAudioUrl", () => {
  it("routes YouTube tracks through the track-aware proxy", () => {
    expect(toPlayableAudioUrl({
      url: "https://rr1---sn-example.googlevideo.com/videoplayback?itag=251",
      source: "youtube",
      sourceTrackId: "dQw4w9WgXcQ",
    })).toBe("/api/audio/youtube/dQw4w9WgXcQ");
  });

  it("does not double-wrap internal audio routes", () => {
    expect(toPlayableAudioUrl("/api/audio/youtube/dQw4w9WgXcQ"))
      .toBe("/api/audio/youtube/dQw4w9WgXcQ");
    expect(toPlayableAudioUrl("/api/audio/local/local_123"))
      .toBe("/api/audio/local/local_123");
  });

  it("keeps generic remote URLs on the existing music proxy", () => {
    expect(toPlayableAudioUrl("https://media.example.com/song.mp3"))
      .toBe("/api/audio/music?url=https%3A%2F%2Fmedia.example.com%2Fsong.mp3");
  });
});

describe("buildPlaybackIssuePayload", () => {
  it("includes source identity for track-aware recovery", () => {
    expect(buildPlaybackIssuePayload("audio_error", "Browser playback failed", {
      currentTrack: {
        id: "dQw4w9WgXcQ",
        url: "/api/audio/youtube/dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
        artist: "Rick Astley",
        source: "youtube",
        sourceTrackId: "dQw4w9WgXcQ",
        urlSource: "youtube",
      },
      currentTime: 12,
      duration: 213,
      audioSignalLevel: 0.02,
    })).toMatchObject({
      code: "audio_error",
      trackId: "dQw4w9WgXcQ",
      source: "youtube",
      sourceTrackId: "dQw4w9WgXcQ",
      urlSource: "youtube",
      positionSec: 12,
      durationSec: 213,
      signalLevel: 0.02,
    });
  });
});
