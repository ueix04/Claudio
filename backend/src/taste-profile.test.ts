import { describe, expect, it } from "vitest";
import {
  buildRecommendationCandidates,
  buildRuntimeTasteProfile,
  buildTasteProfile,
  summarizeRuntimeTasteProfile,
} from "./taste-profile.js";

describe("taste-profile", () => {
  it("builds a compact taste index from snapshot tracks", () => {
    const profile = buildTasteProfile({
      account: {
        userId: 1,
        nickname: "tester",
        avatarUrl: "https://example.com/avatar.jpg",
      },
      syncedAt: 1_700_000_000_000,
      playlists: [
        {
          id: 11,
          name: "Dream Pop",
          trackCount: 2,
          playCount: 10,
          coverImgUrl: "",
          creator: { nickname: "tester", userId: 1 },
          tracks: [
            { id: 1, name: "Space Song", artist: "Beach House", album: "Depression Cherry" },
            { id: 2, name: "Myth", artist: "Beach House", album: "Bloom" },
          ],
        },
        {
          id: 12,
          name: "Canton Pop",
          trackCount: 1,
          playCount: 5,
          coverImgUrl: "",
          creator: { nickname: "tester", userId: 1 },
          tracks: [
            { id: 3, name: "爱得太迟", artist: "古巨基", album: "Human 我生" },
          ],
        },
      ],
    });

    expect(profile.totalTrackCount).toBe(3);
    expect(profile.uniqueArtistCount).toBe(2);
    expect(profile.topArtists[0]?.name).toBe("Beach House");
    expect(profile.playlistFingerprints).toHaveLength(2);
    expect(profile.summary).toContain("Beach House");
    expect(profile.summary).toContain("Dream Pop");
  });

  it("uses recent feedback to boost or suppress recommendation candidates", () => {
    const snapshot = {
      account: {
        userId: 1,
        nickname: "tester",
        avatarUrl: "https://example.com/avatar.jpg",
      },
      syncedAt: 1_700_000_000_000,
      playlists: [
        {
          id: 11,
          name: "Main",
          trackCount: 3,
          playCount: 10,
          coverImgUrl: "",
          creator: { nickname: "tester", userId: 1 },
          tracks: [
            { id: 1, name: "Liked Direction", artist: "Artist A", album: "Album A" },
            { id: 2, name: "Avoid Exact", artist: "Artist B", album: "Album B" },
            { id: 3, name: "Neutral Song", artist: "Artist C", album: "Album C" },
          ],
        },
      ],
    };
    const profile = buildTasteProfile(snapshot);

    const candidates = buildRecommendationCandidates(snapshot, profile, [], 5, [
      {
        id: "feedback_1",
        type: "more_like_this",
        title: "Other Song",
        artist: "Artist A",
        createdAt: 1,
      },
      {
        id: "feedback_2",
        type: "dislike_track",
        title: "Avoid Exact",
        artist: "Artist B",
        createdAt: 2,
      },
    ]);

    expect(candidates.map((candidate) => candidate.title)).not.toContain("Avoid Exact");
    expect(candidates[0]).toMatchObject({
      title: "Liked Direction",
      artist: "Artist A",
    });
    expect(candidates[0].reasons).toContain("positive-feedback");
  });

  it("uses implicit favorite and skip signals with time decay", () => {
    const now = Date.now();
    const snapshot = {
      account: {
        userId: 1,
        nickname: "tester",
        avatarUrl: "https://example.com/avatar.jpg",
      },
      syncedAt: now,
      playlists: [
        {
          id: 11,
          name: "Main",
          trackCount: 3,
          playCount: 10,
          coverImgUrl: "",
          creator: { nickname: "tester", userId: 1 },
          tracks: [
            { id: 1, name: "Favorite Direction", artist: "Artist Fav", album: "Album A" },
            { id: 2, name: "Skipped Direction", artist: "Artist Skip", album: "Album B" },
            { id: 3, name: "Neutral Song", artist: "Artist C", album: "Album C" },
          ],
        },
      ],
    };
    const profile = buildTasteProfile(snapshot);

    const candidates = buildRecommendationCandidates(snapshot, profile, [], 5, [
      {
        id: "feedback_fav",
        type: "favorite_track",
        title: "Other Favorite",
        artist: "Artist Fav",
        createdAt: now,
      },
      {
        id: "feedback_skip",
        type: "skip_track",
        title: "Other Skip",
        artist: "Artist Skip",
        createdAt: now,
      },
      {
        id: "feedback_old_less",
        type: "less_like_this",
        title: "Old Neutral",
        artist: "Artist C",
        createdAt: now - 30 * 86_400_000,
      },
    ]);

    expect(candidates[0]).toMatchObject({
      title: "Favorite Direction",
      artist: "Artist Fav",
    });
    expect(candidates[0].reasons).toContain("positive-feedback");
    expect(candidates.find((candidate) => candidate.artist === "Artist Skip")?.reasons).toContain("reduced-by-feedback");
  });

  it("builds runtime taste signals from recent feedback", () => {
    const now = 1_700_000_000_000;
    const runtimeTaste = buildRuntimeTasteProfile([
      {
        id: "feedback_positive",
        type: "more_like_this",
        title: "Fast Dance Beat",
        artist: "Beach House",
        note: "more high energy and bright",
        createdAt: now,
      },
      {
        id: "feedback_negative",
        type: "less_like_this",
        title: "伤感夜歌",
        artist: "伤感歌手",
        note: "too sad and low energy tonight",
        createdAt: now,
      },
    ], now);

    expect(runtimeTaste.likedArtists[0]).toMatchObject({ label: "Beach House" });
    expect(runtimeTaste.avoidedArtists[0]).toMatchObject({ label: "伤感歌手" });
    expect(runtimeTaste.languageSignals.find((signal) => signal.key === "latin")?.score).toBeGreaterThan(0);
    expect(runtimeTaste.languageSignals.find((signal) => signal.key === "chinese")?.score).toBeLessThan(0);
    expect(runtimeTaste.likedEnergy.map((signal) => signal.key)).toContain("high_energy");
    expect(runtimeTaste.avoidedEnergy.map((signal) => signal.key)).toContain("low_energy");
    expect(runtimeTaste.likedMoods.map((signal) => signal.key)).toContain("bright");
    expect(runtimeTaste.avoidedMoods.map((signal) => signal.key)).toContain("melancholy");
    expect(summarizeRuntimeTasteProfile(runtimeTaste.likedArtists.length ? [
      {
        id: "feedback_positive",
        type: "more_like_this",
        title: "Fast Dance Beat",
        artist: "Beach House",
        note: "more high energy and bright",
        createdAt: now,
      },
    ] : [], now)).toContain("运行期口味画像");
  });

  it("uses runtime language and direction signals when scoring candidates", () => {
    const now = Date.now();
    const snapshot = {
      account: {
        userId: 1,
        nickname: "tester",
        avatarUrl: "https://example.com/avatar.jpg",
      },
      syncedAt: now,
      playlists: [
        {
          id: 11,
          name: "Main",
          trackCount: 2,
          playCount: 10,
          coverImgUrl: "",
          creator: { nickname: "tester", userId: 1 },
          tracks: [
            { id: 1, name: "Fast Dance Beat", artist: "Artist New", album: "Club Night" },
            { id: 2, name: "Quiet Piano", artist: "Artist Soft", album: "Soft Room" },
          ],
        },
      ],
    };
    const profile = buildTasteProfile(snapshot);

    const candidates = buildRecommendationCandidates(snapshot, profile, [], 5, [
      {
        id: "feedback_high",
        type: "more_like_this",
        title: "Another Dance Beat",
        artist: "Different Artist",
        note: "high energy bright dance",
        createdAt: now,
      },
      {
        id: "feedback_low",
        type: "less_like_this",
        title: "Other Quiet Piano",
        artist: "Another Soft Artist",
        note: "too quiet and soft",
        createdAt: now,
      },
    ]);

    expect(candidates[0]).toMatchObject({ title: "Fast Dance Beat" });
    expect(candidates[0].reasons).toContain("runtime-energy-match");
    expect(candidates.find((candidate) => candidate.title === "Quiet Piano")?.reasons)
      .toContain("runtime-energy-reduced");
  });
});
