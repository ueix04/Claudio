import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("undici", () => ({
  fetch: vi.fn(),
  ProxyAgent: vi.fn().mockImplementation((proxyUrl: string) => ({ proxyUrl })),
}));

vi.mock("node:fs/promises");

import fs from "node:fs/promises";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { cacheAudio, getCachedAudio, normalizeTtsPresetName, speak, synthesize } from "./tts.js";

describe("TTS Module", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MIMO_API_KEY: "test-mimo-key",
      MIMO_TTS_MODEL: "mimo-v2.5-tts",
      MIMO_TTS_VOICE: "冰糖",
    };
    vi.stubGlobal("fetch", vi.fn());
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  describe("synthesize", () => {
    it("should successfully synthesize audio with MiMo", async () => {
      const base64Audio = Buffer.from("mimo-audio").toString("base64");
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                audio: { data: base64Audio },
              },
            },
          ],
        }),
      } as Response);

      const result = await synthesize("hello", {
        profile: {
          voice: "温暖",
          style: "情感电台",
          name: "Claudio",
        },
      });

      expect(Buffer.from(result.audioBuffer).toString()).toBe("mimo-audio");
      expect(result.format).toBe("wav");
      expect(result.cached).toBe(false);

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toContain("/chat/completions");
      expect(init).toMatchObject({
        method: "POST",
        headers: {
          "api-key": "test-mimo-key",
          "Content-Type": "application/json",
        },
      });

      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "mimo-v2.5-tts",
        audio: {
          format: "wav",
          voice: "冰糖",
        },
      });
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toContain("CHARACTER");
      expect(body.messages[0].content).toContain("SCENE");
      expect(body.messages[0].content).toContain("DIRECTION");
      expect(body.messages[0].content).toContain("使用正确音色：冰糖");
      expect(body.messages[0].content).toContain("情感电台");
      expect(body.messages[1]).toMatchObject({
        role: "assistant",
        content: "hello",
      });
    });

    it("should throw error when MIMO_API_KEY is missing", async () => {
      delete process.env.MIMO_API_KEY;
      await expect(synthesize("hello")).rejects.toThrow("MIMO_API_KEY is missing");
    });

    it("should use English prompt copy for Dean preset", async () => {
      const base64Audio = Buffer.from("dean-audio").toString("base64");
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                audio: { data: base64Audio },
              },
            },
          ],
        }),
      } as Response);

      await synthesize("hello", {
        profile: {
          voice: "Dean",
          style: "late-night radio",
          name: "Claudio",
        },
        atmosphere: "city lights after midnight",
      });

      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
      expect(body.audio.voice).toBe("Dean");
      expect(body.messages[0].content).toContain("Use preset voice: Dean");
      expect(body.messages[0].content).toContain("Persona name: Claudio");
      expect(body.messages[0].content).toContain("Show style: late-night radio");
      expect(body.messages[0].content).toContain("Atmosphere note: city lights after midnight");
      expect(body.messages[0].content).not.toContain("使用正确音色");
      expect(body.messages[0].content).not.toContain("角色名：");
    });

    it("should throw when VoiceDesign has no prompt source", async () => {
      process.env.MIMO_TTS_MODEL = "mimo-v2.5-tts-voicedesign";
      const base64Audio = Buffer.from("voice-design-audio").toString("base64");
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                audio: { data: base64Audio },
              },
            },
          ],
        }),
      } as Response);

      await expect(synthesize("hello")).resolves.toMatchObject({
        format: "wav",
      });
    });

    it("should propagate API errors", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      } as Response);

      await expect(synthesize("hello")).rejects.toThrow("MiMo API error: 401 Unauthorized");
    });

    it("should retry via proxy on network failures", async () => {
      const base64Audio = Buffer.from("mimo-audio").toString("base64");
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
      vi.mocked(undiciFetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                audio: { data: base64Audio },
              },
            },
          ],
        }),
      } as Response);

      const result = await synthesize("hello");

      expect(Buffer.from(result.audioBuffer).toString()).toBe("mimo-audio");
      expect(undiciFetch).toHaveBeenCalledWith(
        expect.stringContaining("/chat/completions"),
        expect.objectContaining({
          dispatcher: expect.anything(),
        }),
      );
      expect(ProxyAgent).toHaveBeenCalledWith("http://127.0.0.1:7897");
    });
  });

  describe("cache helpers", () => {
    it("should produce deterministic cache keys", async () => {
      const pathA = await cacheAudio("hello", new ArrayBuffer(0), "variant-a");
      const pathB = await getCachedAudio("hello", "variant-a");

      expect(pathA).toContain("data/audio/mimo-");
      expect(pathB).toContain("data/audio/mimo-");
    });
  });

  describe("speak", () => {
    it("should return cached audio if available", async () => {
      const mockBuffer = Buffer.from("cached-audio");
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(mockBuffer);

      const result = await speak("hello");

      expect(result.cached).toBe(true);
      expect(result.cachePath?.replace(/\\/g, "/")).toContain("data/audio/mimo-");
      expect(fetch).not.toHaveBeenCalled();
    });

    it("should synthesize and cache if not in cache", async () => {
      const base64Audio = Buffer.from("fresh-audio").toString("base64");
      vi.mocked(fs.access).mockRejectedValue(new Error("not found"));
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                audio: { data: base64Audio },
              },
            },
          ],
        }),
      } as Response);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const result = await speak("new-text", {
        profile: {
          voice: "清醒",
          style: "晨间简报",
        },
      });

      expect(result.cached).toBe(false);
      expect(fetch).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
      expect(result.cachePath?.replace(/\\/g, "/")).toContain("data/audio/mimo-");

      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
      expect(body.messages[0].content).toContain("晨间简报");
      expect(body.messages[0].content).toContain("CHARACTER");
      expect(body.messages[0].content).toContain("补充声音气质：清醒");
    });
  });

  it("should normalize supported presets", () => {
    expect(normalizeTtsPresetName("Dean")).toBe("Dean");
    expect(normalizeTtsPresetName("冰糖")).toBe("冰糖");
    expect(normalizeTtsPresetName("温暖")).toBe("冰糖");
  });
});
