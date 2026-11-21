import { describe, expect, it, vi } from "vitest";
import { fetchSourceJson } from "./music-sources/http-client.js";

vi.mock("./music-sources/http-client.js");

describe("netease module", () => {
  it("should export searchSongs function", async () => {
    const mod = await import("./netease");
    expect(typeof mod.searchSongs).toBe("function");
    expect(typeof mod.getOpenPlayableUrl).toBe("function");
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

  it("does not request anonymous audio for a track marked unavailable despite a free fee code", async () => {
    const { getOpenPlayableUrl } = await import("./netease.js");
    vi.mocked(fetchSourceJson).mockClear();
    vi.mocked(fetchSourceJson).mockResolvedValueOnce({ code: 200, privileges: [{ id: 186016, st: -200, fee: 0, pl: 0 }] });

    expect(await getOpenPlayableUrl(186016)).toBeNull();
    expect(fetchSourceJson).toHaveBeenCalledTimes(1);
  });

  it("requests the allowed quality anonymously and uses the provider expiry for free audio", async () => {
    const { getOpenPlayableUrl } = await import("./netease.js");
    vi.mocked(fetchSourceJson).mockClear();
    const url = "https://m801.music.126.net/free.mp3";
    vi.mocked(fetchSourceJson)
      .mockResolvedValueOnce({ code: 200, privileges: [{ id: 123, st: 0, fee: 8, pl: 128_000 }] })
      .mockResolvedValueOnce({ code: 200, data: [{ id: 123, code: 200, url, fee: 8, expi: 1200 }] });

    const result = await getOpenPlayableUrl(123);
    expect(result).toMatchObject({ url });
    expect(result!.expiresAt - result!.refreshedAt).toBe(1_200_000);
    const options = vi.mocked(fetchSourceJson).mock.calls[1][1];
    expect(options?.method).toBe("POST");
    expect((options?.body as URLSearchParams).get("br")).toBe("128000");
    expect(new Headers(options?.headers).has("cookie")).toBe(false);
  });
});
