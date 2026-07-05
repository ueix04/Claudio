import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNetworkProxyUrl,
  hasNetworkProxyConfigured,
  isLikelyNetworkError,
  withConfiguredProxy,
  withDirectRetry,
} from "./network.js";

describe("network helpers", () => {
  const originalProxyUrl = process.env.NETWORK_PROXY_URL;
  const originalExternalProxyUrl = process.env.EXTERNAL_PROXY_URL;
  const originalProxyHost = process.env.NETWORK_PROXY_HOST;
  const originalProxyPort = process.env.NETWORK_PROXY_PORT;

  beforeEach(() => {
    delete process.env.NETWORK_PROXY_URL;
    delete process.env.EXTERNAL_PROXY_URL;
    delete process.env.NETWORK_PROXY_HOST;
    delete process.env.NETWORK_PROXY_PORT;
  });

  afterEach(() => {
    if (originalProxyUrl === undefined) {
      delete process.env.NETWORK_PROXY_URL;
    } else {
      process.env.NETWORK_PROXY_URL = originalProxyUrl;
    }
    if (originalExternalProxyUrl === undefined) {
      delete process.env.EXTERNAL_PROXY_URL;
    } else {
      process.env.EXTERNAL_PROXY_URL = originalExternalProxyUrl;
    }
    if (originalProxyHost === undefined) {
      delete process.env.NETWORK_PROXY_HOST;
    } else {
      process.env.NETWORK_PROXY_HOST = originalProxyHost;
    }
    if (originalProxyPort === undefined) {
      delete process.env.NETWORK_PROXY_PORT;
    } else {
      process.env.NETWORK_PROXY_PORT = originalProxyPort;
    }
  });

  it("should use direct networking when no proxy is configured", () => {
    expect(getNetworkProxyUrl()).toBeUndefined();
    expect(hasNetworkProxyConfigured()).toBe(false);
  });

  it("should use an explicit proxy URL when configured", () => {
    process.env.NETWORK_PROXY_URL = "http://127.0.0.1:7897";

    expect(getNetworkProxyUrl()).toBe("http://127.0.0.1:7897");
    expect(hasNetworkProxyConfigured()).toBe(true);
  });

  it("should support host and port proxy configuration", () => {
    process.env.NETWORK_PROXY_HOST = "127.0.0.1";
    process.env.NETWORK_PROXY_PORT = "7897";

    expect(getNetworkProxyUrl()).toBe("http://127.0.0.1:7897");
  });

  it("should detect common network errors", () => {
    expect(isLikelyNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isLikelyNetworkError({ status: 502, body: { code: 502, msg: "socket hang up" } })).toBe(true);
    expect(isLikelyNetworkError(new Error("Insufficient Balance"))).toBe(false);
  });

  it("should retry direct requests when no proxy is configured", async () => {
    const op = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("ok");

    const result = await withDirectRetry("test", () => op());

    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("should use configured proxy first for proxy-enabled callers", async () => {
    process.env.NETWORK_PROXY_URL = "http://127.0.0.1:7897";
    const op = vi.fn()
      .mockResolvedValueOnce("ok");

    const result = await withConfiguredProxy("test", (proxyUrl) => op(proxyUrl));

    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenNthCalledWith(1, "http://127.0.0.1:7897");
  });
});
