import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMusicAudio } from "./audio-http.js";
import { fetchSourceText } from "./http-client.js";
import { fetchViaMusicRelay, hasMusicRelay, MUSIC_ROUTE_TIMEOUT_MS } from "./relay.js";

vi.mock("./relay.js", () => ({
  hasMusicRelay: vi.fn(),
  fetchViaMusicRelay: vi.fn(),
  MUSIC_ROUTE_TIMEOUT_MS: 2_500,
}));

const audioUrl = new URL("https://bd-lv.kuwo.cn/song.mp3");
const audioOptions = () => ({ range: "bytes=100-199", signal: new AbortController().signal });

describe("desktop music relay", () => {
  beforeEach(() => {
    vi.mocked(hasMusicRelay).mockReturnValue(true);
    vi.mocked(fetchViaMusicRelay).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps successful direct streams open beyond the connection timeout", async () => {
    vi.useFakeTimers();
    const direct = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ID3", { headers: { "Content-Type": "audio/mpeg" } }),
    );
    const response = await fetchMusicAudio(audioUrl, audioOptions());
    await vi.advanceTimersByTimeAsync(MUSIC_ROUTE_TIMEOUT_MS + 1);
    expect(direct.mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(fetchViaMusicRelay).not.toHaveBeenCalled();
    expect(await response.text()).toBe("ID3");
  });

  it("retries the same URL and byte range through the relay after a direct timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, options) =>
      new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
    );
    const relayed = new Response("ID3", { status: 206, headers: { "Content-Range": "bytes 100-199/500" } });
    vi.mocked(fetchViaMusicRelay).mockResolvedValue(relayed);
    const result = fetchMusicAudio(audioUrl, audioOptions());
    await vi.advanceTimersByTimeAsync(MUSIC_ROUTE_TIMEOUT_MS);

    expect(await result).toBe(relayed);
    expect(fetchViaMusicRelay).toHaveBeenCalledWith(audioUrl, expect.objectContaining({
      headers: expect.objectContaining({ Range: "bytes=100-199" }),
    }));
  });

  it("uses the desktop first for lookup and retries directly when the tunnel is unavailable", async () => {
    const lookupUrl = new URL("https://search.kuwo.cn/r.s");
    const direct = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("direct"));
    vi.mocked(fetchViaMusicRelay)
      .mockResolvedValueOnce(new Response("desktop"))
      .mockRejectedValueOnce(new TypeError("fetch failed"));

    expect(await fetchSourceText(lookupUrl)).toBe("desktop");
    expect(direct).not.toHaveBeenCalled();
    expect(await fetchSourceText(lookupUrl)).toBe("direct");
    expect(direct).toHaveBeenCalledOnce();
  });
});
