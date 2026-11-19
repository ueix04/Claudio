import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("undici", () => ({
  fetch: vi.fn(),
  ProxyAgent: vi.fn().mockImplementation((proxyUrl: string) => ({ proxyUrl })),
}));

vi.mock("node:fs/promises");

import fs from "node:fs/promises";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { normalizeTtsPresetName, resolveDjCopyLanguage } from "./dj-language.js";
import { cacheAudio, getCachedAudio, speak, synthesize } from "./tts.js";

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
    vi.useRealTimers();
  });

  describe("synthesize", () => {
    it("should successfully synthesize audio with MiMo", async () => {
      process.env.MIMO_TTS_VOICE = "茉莉";
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
        direction: "第一句轻快。\n‘hello’稍带笑意。",
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
          voice: "茉莉",
        },
      });
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toContain("正常聊天语速");
      expect(body.messages[0].content).toContain("声音气质 — 温暖");
      expect(body.messages[0].content).toContain("情感电台");
      expect(body.messages[0].content).toContain("本段导演提示 — 第一句轻快。\n‘hello’稍带笑意。");
      expect(body.messages[1]).toMatchObject({
        role: "assistant",
        content: "hello",
      });
    });

    it("should throw error when MIMO_API_KEY is missing", async () => {
      delete process.env.MIMO_API_KEY;
      await expect(synthesize("hello")).rejects.toThrow("MIMO_API_KEY is missing");
    });

    it.each(["Dean", "Chloe"])("should use English delivery for %s", async (voice) => {
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
          voice,
          style: "late-night radio",
          name: "Claudio",
        },
        atmosphere: "city lights after midnight",
      });

      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
      expect(body.audio.voice).toBe(voice);
      expect(body.messages[0].content).toContain("conversational speed");
      expect(body.messages[0].content).toContain("Host name — Claudio");
      expect(body.messages[0].content).toContain("Show style — late-night radio");
      expect(body.messages[0].content).toContain("Atmosphere — city lights after midnight");
    });

    it("uses the VoiceDesign description and scene while reading the original line", async () => {
      process.env.MIMO_TTS_MODEL = "mimo-v2.5-tts-voicedesign";
      process.env.MIMO_TTS_VOICE_PROMPT = "声线偏中音，吐字松弛清楚。";
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

      await expect(synthesize("接下来听首歌。", { scene: "segue" })).resolves.toMatchObject({
        format: "wav",
      });
      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
      expect(body.audio).toEqual({ format: "wav", optimize_text_preview: false });
      expect(body.messages[0].content).toContain(process.env.MIMO_TTS_VOICE_PROMPT);
      expect(body.messages[0].content).toContain("按台词的意思自然停连");
      expect(body.messages[1]).toEqual({ role: "assistant", content: "接下来听首歌。" });
    });

    it("uses the sample as the VoiceClone voice and the scene as delivery guidance", async () => {
      process.env.MIMO_TTS_MODEL = "mimo-v2.5-tts-voiceclone";
      process.env.MIMO_TTS_VOICE_SAMPLE_PATH = "sample.mp3";
      const sample = Buffer.from("test-sample").toString("base64");
      vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from("test-sample"));
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { audio: { data: sample } } }] }),
      } as Response);

      await synthesize("接下来听首歌。", { scene: "chat_reply", profile: { voice: "茉莉" } });

      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
      expect(body.audio).toEqual({ format: "wav", voice: `data:audio/mpeg;base64,${sample}` });
      expect(body.messages[0].content).toContain("根据内容自然展开和收尾");
      expect(body.messages[0].content).not.toContain("茉莉");
    });

    it("rejects samples that exceed the VoiceClone limit before making a request", async () => {
      process.env.MIMO_TTS_MODEL = "mimo-v2.5-tts-voiceclone";
      process.env.MIMO_TTS_VOICE_SAMPLE_PATH = "sample.wav";
      vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.alloc(7_500_001));

      await expect(synthesize("hello")).rejects.toThrow("at most 10 MB");
      expect(fetch).not.toHaveBeenCalled();
    });

    it("should propagate API errors", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      } as Response);

      await expect(synthesize("hello")).rejects.toThrow("MiMo API error: HTTP 401");
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
    const frame = (pcm: string) => `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: pcm } } }] })}\r\n\r\n`;

    function mockStream() {
      vi.mocked(fs.access).mockRejectedValueOnce(new Error("not found"));
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (value) => { controller = value; } });
      vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      });
      const encoder = new TextEncoder();
      return {
        send: (data: string) => controller.enqueue(encoder.encode(data)),
        close: () => controller.close(),
      };
    }

    it("streams past the initial wait interval while PCM keeps arriving and caches the full WAV", async () => {
      vi.useFakeTimers();
      process.env.MIMO_TTS_TIMEOUT_MS = "1000";
      const stream = mockStream();

      const onPcmChunk = vi.fn();
      const result = speak("live", { onPcmChunk });
      const first = frame("AAA=");
      stream.send(first.slice(0, -2));
      stream.send(first.slice(-2));
      await vi.advanceTimersByTimeAsync(700);
      expect(onPcmChunk).toHaveBeenCalledWith("AAA=");
      expect(fs.writeFile).not.toHaveBeenCalled();

      stream.send(frame("AQI="));
      await vi.advanceTimersByTimeAsync(700);
      expect(onPcmChunk).toHaveBeenCalledWith("AQI=");
      stream.send("data: [DONE]\r\n\r\n");
      stream.close();
      const wav = Buffer.from((await result).audioBuffer);
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(24_000);
      expect(wav.subarray(44)).toEqual(Buffer.from([0, 0, 1, 2]));
      expect(fs.writeFile).toHaveBeenCalledOnce();
      const requestBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
      expect(requestBody).toMatchObject({ stream: true, audio: { format: "pcm16", voice: "冰糖" } });
    });

    it("stops an idle audio stream even when the connection sends keepalives", async () => {
      vi.useFakeTimers();
      process.env.MIMO_TTS_TIMEOUT_MS = "1000";
      const stream = mockStream();
      const onPcmChunk = vi.fn();
      const result = expect(speak("stalled", { onPcmChunk })).rejects.toMatchObject({ name: "TimeoutError" });

      stream.send(frame("AAA="));
      await vi.advanceTimersByTimeAsync(600);
      expect(onPcmChunk).toHaveBeenCalledOnce();
      stream.send(": keepalive\r\n\r\n");
      await vi.advanceTimersByTimeAsync(450);

      await result;
      expect(fetch).toHaveBeenCalledOnce();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it("falls back to WAV when streaming fails before the first chunk", async () => {
      vi.mocked(fs.access).mockRejectedValueOnce(new Error("not found"));
      vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 502 }));
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({
        choices: [{ message: { audio: { data: "AAA=" } } }],
      }));
      const onPcmChunk = vi.fn();

      await expect(speak("fallback", { onPcmChunk })).resolves.toMatchObject({ format: "wav" });
      expect(onPcmChunk).not.toHaveBeenCalled();
      const requestBody = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
      expect(requestBody.audio.format).toBe("wav");
      expect(requestBody.stream).toBeUndefined();
    });

    it("keeps an interrupted stream out of the cache and does not restart the line", async () => {
      vi.mocked(fs.access).mockRejectedValueOnce(new Error("not found"));
      vi.mocked(fetch).mockResolvedValueOnce(new Response(frame("AAA="), {
        headers: { "Content-Type": "text/event-stream" },
      }));
      const onPcmChunk = vi.fn();

      await expect(speak("interrupted", { onPcmChunk })).rejects.toThrow("without complete audio");
      expect(onPcmChunk).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

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
      expect(body.messages[0].content).toContain("声音气质 — 清醒");
    });
  });

  it("should normalize supported presets", () => {
    expect(normalizeTtsPresetName("Dean")).toBe("Dean");
    expect(normalizeTtsPresetName("冰糖")).toBe("冰糖");
    expect(normalizeTtsPresetName("温暖")).toBe("冰糖");
    expect(resolveDjCopyLanguage({ voice: "Milo" })).toBe("en");
    expect(resolveDjCopyLanguage({ voice: "白桦" })).toBe("zh");
  });
});
