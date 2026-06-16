import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NETEASE_LEGACY_SOURCE_ID,
  YOUTUBE_SOURCE_ID,
  getMusicSourceRuntimeStatus,
  getMusicSourceAdapter,
  isYouTubeEnabled,
  listMusicSourceAdapters,
  resolveTrack,
  setYouTubeClientForTests,
} from "./music-sources/index.js";
import { MusicSourceError } from "./music-sources/types.js";
import type { Innertube } from "youtubei.js";

interface FakeSongItem {
  item_type?: string;
  id?: string;
  title?: string;
  artists?: Array<{ name?: string }>;
  album?: { name?: string };
  thumbnails?: Array<{ url?: string }>;
  duration?: { seconds?: number };
}

function createFakeInnertube(options: {
  songs?: FakeSongItem[];
  streamUrl?: string;
  streamError?: Error;
  basicInfo?: Partial<{
    title: string;
    author: string;
    duration: number;
    thumbnail: Array<{ url: string }>;
  }>;
}): Innertube {
  const { songs = [], streamUrl, streamError, basicInfo } = options;
  const fake = {
    music: {
      search: async () => ({
        songs: { contents: songs },
      }),
      getInfo: async () => ({
        basic_info: {
          title: basicInfo?.title ?? "Detail Title",
          author: basicInfo?.author ?? "Detail Artist",
          duration: basicInfo?.duration ?? 180,
          thumbnail: basicInfo?.thumbnail ?? [{ url: "https://img.example.com/big.jpg" }],
        },
      }),
    },
    getStreamingData: async () => {
      if (streamError) {
        throw streamError;
      }
      return { url: streamUrl };
    },
  };
  return fake as unknown as Innertube;
}

describe("youtube music source adapter", () => {
  const originalEnabled = process.env.YOUTUBE_ENABLED;
  const originalTtl = process.env.YOUTUBE_URL_TTL_MS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    delete process.env.YOUTUBE_ENABLED;
    delete process.env.YOUTUBE_URL_TTL_MS;
    setYouTubeClientForTests(null);
  });

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env.YOUTUBE_ENABLED;
    } else {
      process.env.YOUTUBE_ENABLED = originalEnabled;
    }
    if (originalTtl === undefined) {
      delete process.env.YOUTUBE_URL_TTL_MS;
    } else {
      process.env.YOUTUBE_URL_TTL_MS = originalTtl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    setYouTubeClientForTests(null);
  });

  it("is disabled by default and excluded from the runtime search order", async () => {
    expect(isYouTubeEnabled()).toBe(false);

    const status = await getMusicSourceRuntimeStatus();
    expect(status.searchOrder).not.toContain(YOUTUBE_SOURCE_ID);
    expect(status.searchOrder).toEqual([NETEASE_LEGACY_SOURCE_ID]);

    const youtubeStatus = status.sources.find((source) => source.source === YOUTUBE_SOURCE_ID);
    expect(youtubeStatus).toMatchObject({
      role: "primary",
      enabled: false,
      ok: false,
    });
  });

  it("joins the search order ahead of netease when enabled", async () => {
    process.env.YOUTUBE_ENABLED = "true";

    const status = await getMusicSourceRuntimeStatus();
    expect(isYouTubeEnabled()).toBe(true);
    expect(status.searchOrder).toEqual([YOUTUBE_SOURCE_ID, NETEASE_LEGACY_SOURCE_ID]);
  });

  it("registers the adapter in the adapter map", () => {
    const ids = listMusicSourceAdapters().map((adapter) => adapter.id);
    expect(ids).toContain(YOUTUBE_SOURCE_ID);
  });

  it("maps YouTube Music song results into source tracks", async () => {
    process.env.YOUTUBE_ENABLED = "true";
    setYouTubeClientForTests(
      createFakeInnertube({
        songs: [
          {
            item_type: "song",
            id: "dQw4w9WgXcQ",
            title: "Never Gonna Give You Up",
            artists: [{ name: "Rick Astley" }, { name: "" }],
            album: { name: "Whenever You Need Somebody" },
            thumbnails: [{ url: "https://img.example.com/small.jpg" }, { url: "https://img.example.com/large.jpg" }],
            duration: { seconds: 213 },
          },
          {
            item_type: "video",
            id: "videoShouldBeSkipped",
            title: "Ignore MV results",
          },
          {
            item_type: "song",
            id: "abcdefghij1",
            title: "Second Song",
            artists: [{ name: "Other Artist" }],
            duration: { seconds: 90 },
          },
        ],
      }),
    );

    const adapter = getMusicSourceAdapter(YOUTUBE_SOURCE_ID);
    const tracks = await adapter.search({ keyword: "rick astley", limit: 10 });

    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      source: YOUTUBE_SOURCE_ID,
      sourceTrackId: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      album: "Whenever You Need Somebody",
      picUrl: "https://img.example.com/large.jpg",
      duration: 213,
    });
    expect(tracks[0].sourceTrackId).not.toMatch(/^\d+$/);
  });

  it("resolves a deciphered googlevideo direct URL with ttl metadata", async () => {
    process.env.YOUTUBE_ENABLED = "true";
    process.env.YOUTUBE_URL_TTL_MS = "120000";
    setYouTubeClientForTests(
      createFakeInnertube({
        streamUrl: "https://rr1---sn-example.googlevideo.com/videoplayback?itag=251",
      }),
    );

    const adapter = getMusicSourceAdapter(YOUTUBE_SOURCE_ID);
    const result = await adapter.resolvePlayableUrl("dQw4w9WgXcQ");

    expect(result.source).toBe(YOUTUBE_SOURCE_ID);
    expect(result.sourceTrackId).toBe("dQw4w9WgXcQ");
    expect(result.url).toContain("googlevideo.com");
    expect(result.expiresAt - result.refreshedAt).toBe(120_000);
  });

  it("rejects malformed video ids with a not_found error", async () => {
    process.env.YOUTUBE_ENABLED = "true";
    setYouTubeClientForTests(createFakeInnertube({}));

    const adapter = getMusicSourceAdapter(YOUTUBE_SOURCE_ID);
    await expect(adapter.resolvePlayableUrl("too-short")).rejects.toMatchObject({
      source: YOUTUBE_SOURCE_ID,
      code: "not_found",
    });
  });

  it("normalizes bot-check / unavailable errors as unplayable", async () => {
    process.env.YOUTUBE_ENABLED = "true";
    setYouTubeClientForTests(
      createFakeInnertube({
        streamError: new Error("Sign in to confirm you're not a bot"),
      }),
    );

    const adapter = getMusicSourceAdapter(YOUTUBE_SOURCE_ID);
    await expect(adapter.resolvePlayableUrl("dQw4w9WgXcQ")).rejects.toMatchObject({
      source: YOUTUBE_SOURCE_ID,
      code: "unplayable",
      retriable: false,
    });
  });

  it("returns track detail from music.getInfo basic_info", async () => {
    process.env.YOUTUBE_ENABLED = "true";
    setYouTubeClientForTests(
      createFakeInnertube({
        basicInfo: {
          title: "Resolved Title",
          author: "Resolved Artist",
          duration: 240,
          thumbnail: [{ url: "https://img.example.com/detail.jpg" }],
        },
      }),
    );

    const adapter = getMusicSourceAdapter(YOUTUBE_SOURCE_ID);
    const track = await adapter.getTrackDetail("dQw4w9WgXcQ");
    expect(track).toMatchObject({
      source: YOUTUBE_SOURCE_ID,
      sourceTrackId: "dQw4w9WgXcQ",
      title: "Resolved Title",
      artist: "Resolved Artist",
      duration: 240,
      picUrl: "https://img.example.com/detail.jpg",
    });
  });

  it("returns null for unknown ids in getTrackDetail", async () => {
    process.env.YOUTUBE_ENABLED = "true";
    setYouTubeClientForTests(createFakeInnertube({}));

    const adapter = getMusicSourceAdapter(YOUTUBE_SOURCE_ID);
    expect(await adapter.getTrackDetail("bad-id")).toBeNull();
  });

  it("integrates with resolveTrack search flow", async () => {
    process.env.YOUTUBE_ENABLED = "true";
    setYouTubeClientForTests(
      createFakeInnertube({
        songs: [
          {
            item_type: "song",
            id: "dQw4w9WgXcQ",
            title: "Never Gonna Give You Up",
            artists: [{ name: "Rick Astley" }],
            duration: { seconds: 213 },
            thumbnails: [{ url: "https://img.example.com/cover.jpg" }],
          },
        ],
        streamUrl: "https://rr1.example.com/googlevideo.com/videoplayback?itag=251",
      }),
    );

    // URL validation is skipped in the test environment (NODE_ENV=test),
    // so resolveTrack returns the track without probing the stream.
    const track = await resolveTrack("Never Gonna Give You Up", "Rick Astley", YOUTUBE_SOURCE_ID);
    expect(track).not.toBeNull();
    expect(track?.source).toBe(YOUTUBE_SOURCE_ID);
    expect(track?.sourceTrackId).toBe("dQw4w9WgXcQ");
    expect(track?.url).toContain("googlevideo.com");
  });

  it("exposes a MusicSourceError with the youtube source id", () => {
    const error = new MusicSourceError(YOUTUBE_SOURCE_ID, "unplayable", "no stream");
    expect(error.source).toBe(YOUTUBE_SOURCE_ID);
    expect(error.code).toBe("unplayable");
  });
});
