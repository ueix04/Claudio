import { describe, expect, it, vi } from "vitest";
import { getNetworkProxyUrl, isLikelyNetworkError, withProxyFallback } from "./network.js";

describe("network helpers", () => {
  it("should default proxy fallback to localhost:7897", () => {
    delete process.env.NETWORK_PROXY_URL;
    delete process.env.EXTERNAL_PROXY_URL;
    delete process.env.NETWORK_PROXY_HOST;
    delete process.env.NETWORK_PROXY_PORT;

    expect(getNetworkProxyUrl()).toBe("http://127.0.0.1:7897");
  });

  it("should detect common network errors", () => {
    expect(isLikelyNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isLikelyNetworkError({ status: 502, body: { code: 502, msg: "socket hang up" } })).toBe(true);
    expect(isLikelyNetworkError(new Error("Insufficient Balance"))).toBe(false);
  });

  it("should retry with proxy when the first request is a network failure", async () => {
    const op = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("ok");

    const result = await withProxyFallback("test", (proxyUrl) => op(proxyUrl));

    expect(result).toBe("ok");
    expect(op).toHaveBeenNthCalledWith(1, undefined);
    expect(op).toHaveBeenNthCalledWith(2, "http://127.0.0.1:7897");
  });
});
