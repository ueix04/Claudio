import { describe, expect, it } from "vitest";
import { buildTasteProfile } from "./taste-profile.js";

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
});
