import { describe, expect, it } from "vitest";

describe("netease module", () => {
  it("should export searchSongs function", async () => {
    const mod = await import("./netease");
    expect(typeof mod.searchSongs).toBe("function");
    expect(typeof mod.getPlayableUrl).toBe("function");
    expect(typeof mod.resolveTrack).toBe("function");
    expect(typeof mod.getPlaylistTracks).toBe("function");
  });

  it("should export correct types (compile-time check)", () => {
    // 编译期类型验证 - 以下代码只要编译通过即通过
    const track: import("./netease").NeteaseTrack = {
      id: 1,
      name: "test",
      artists: [{ name: "a" }],
      album: { name: "album", picUrl: "url" },
      duration: 100,
    };
    expect(track.id).toBe(1);
  });

  it("should normalize raw MUSIC_U cookie values", async () => {
    const mod = await import("./netease");
    expect(mod.normalizeNeteaseCookie("abc123")).toBe("MUSIC_U=abc123");
    expect(mod.normalizeNeteaseCookie("MUSIC_U=abc123")).toBe("MUSIC_U=abc123");
    expect(mod.normalizeNeteaseCookie("MUSIC_U=abc123; os=pc")).toBe("MUSIC_U=abc123; os=pc");
  });
});
