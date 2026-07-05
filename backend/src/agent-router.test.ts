import { beforeEach, describe, expect, it, vi } from "vitest";
import * as claude from "./claude.js";
import { routeChatIntent, routeChatIntentWithSemanticFallback } from "./agent-router.js";

vi.mock("./claude.js", () => ({
  callJsonLLM: vi.fn(),
  getLlmTaskTimeoutMs: vi.fn(() => 20_000),
}));

describe("Chat Intent Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes explicit weather questions to answer_weather", () => {
    expect(routeChatIntent("今天外面天气怎么样")).toMatchObject({
      intent: "weather_query",
      action: "answer_weather",
    });
  });

  it("routes current track questions to reply_only", () => {
    expect(routeChatIntent("这首歌叫什么")).toMatchObject({
      intent: "current_track_query",
      action: "reply_only",
    });
  });

  it("routes recommendation reason questions to reply_only", () => {
    expect(routeChatIntent("这首为什么推荐")).toMatchObject({
      intent: "recommendation_reason",
      action: "reply_only",
    });
  });

  it("routes strong program refresh signals to a fresh program when semantic routing fails", async () => {
    vi.mocked(claude.callJsonLLM).mockRejectedValue(new Error("timeout"));

    for (const text of [
      "我要新的",
      "换一档新节目，不要循环旧歌",
      "下一档",
      "别循环之前的歌了",
      "这档听腻了",
      "更换新界面",
    ]) {
      const route = await routeChatIntentWithSemanticFallback(text);
      expect(route).toMatchObject({
        intent: "program_refresh",
        action: "replan_queue",
        preserveCurrentTrack: false,
        routedBy: "fallback",
      });
    }

    expect(claude.callJsonLLM).toHaveBeenCalledTimes(6);
  });

  it("routes weak music adjustment signals to upcoming queue replans when semantic routing fails", async () => {
    vi.mocked(claude.callJsonLLM).mockRejectedValue(new Error("timeout"));

    for (const text of [
      "换点别的",
      "来点不一样的",
      "换安静一点",
      "换歌阿！！！",
      "change",
      "switch it up",
      "我要听电子音乐",
    ]) {
      const route = await routeChatIntentWithSemanticFallback(text);
      expect(route).toMatchObject({
        intent: "style_change",
        action: "replan_queue",
        preserveCurrentTrack: true,
        routedBy: "fallback",
      });
    }

    expect(claude.callJsonLLM).toHaveBeenCalledTimes(7);
  });

  it("routes random music requests to the random_discover pipeline", () => {
    expect(routeChatIntent("帮我随机推荐一首歌")).toMatchObject({
      intent: "music_request",
      action: "trigger_pipeline",
      mode: "random_discover",
    });
  });

  it("routes ordinary chat to reply_only", () => {
    expect(routeChatIntent("你在干嘛")).toMatchObject({
      intent: "ordinary_chat",
      action: "reply_only",
    });
  });

  it("keeps hard playback controls on rules without calling semantic LLM", async () => {
    const route = await routeChatIntentWithSemanticFallback("下一首");

    expect(route).toMatchObject({
      intent: "playback_control",
      action: "skip_track",
      routedBy: "rule",
    });
    expect(claude.callJsonLLM).not.toHaveBeenCalled();
  });

  it("does not call semantic LLM for plain ordinary chat", async () => {
    const route = await routeChatIntentWithSemanticFallback("你在干嘛");

    expect(route).toMatchObject({
      intent: "ordinary_chat",
      action: "reply_only",
      routedBy: "rule",
    });
    expect(claude.callJsonLLM).not.toHaveBeenCalled();
  });

  it("does not call semantic LLM for current track questions", async () => {
    const route = await routeChatIntentWithSemanticFallback("这首叫什么");

    expect(route).toMatchObject({
      intent: "current_track_query",
      action: "reply_only",
      routedBy: "rule",
    });
    expect(claude.callJsonLLM).not.toHaveBeenCalled();
  });

  it("uses semantic LLM for low-confidence music expressions", async () => {
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      intent: "style_change",
      action: "replan_queue",
      confidence: 0.82,
      reason: "listener asks for less noisy music",
    });

    const route = await routeChatIntentWithSemanticFallback("来点没那么吵的");

    expect(route).toMatchObject({
      intent: "style_change",
      action: "replan_queue",
      preserveCurrentTrack: true,
      routedBy: "llm",
      confidence: 0.82,
    });
  });

  it("defaults program_refresh semantic routes to replacing the current track", async () => {
    vi.mocked(claude.callJsonLLM).mockResolvedValue({
      intent: "program_refresh",
      action: "replan_queue",
      confidence: 0.9,
      reason: "listener asks for a fresh program",
    });

    const route = await routeChatIntentWithSemanticFallback("我要新的");

    expect(route).toMatchObject({
      intent: "program_refresh",
      action: "replan_queue",
      preserveCurrentTrack: false,
      routedBy: "llm",
      confidence: 0.9,
    });
  });

  it("falls back to a queue replan when semantic LLM times out for music adjustment text", async () => {
    vi.mocked(claude.callJsonLLM).mockRejectedValue(new Error("timeout"));

    const route = await routeChatIntentWithSemanticFallback("来点没那么吵的");

    expect(route).toMatchObject({
      intent: "style_change",
      action: "replan_queue",
      preserveCurrentTrack: true,
      routedBy: "fallback",
    });
  });

  it("falls back to a queue replan when semantic LLM returns illegal or low-confidence routes", async () => {
    vi.mocked(claude.callJsonLLM).mockResolvedValueOnce({
      intent: "playback_control",
      action: "skip_track",
      confidence: 0.95,
      reason: "illegal direct playback action",
    });

    await expect(routeChatIntentWithSemanticFallback("来点没那么吵的")).resolves.toMatchObject({
      intent: "style_change",
      action: "replan_queue",
      preserveCurrentTrack: true,
      routedBy: "fallback",
    });

    vi.mocked(claude.callJsonLLM).mockResolvedValueOnce({
      intent: "style_change",
      action: "replan_queue",
      confidence: 0.41,
      reason: "too uncertain",
    });

    await expect(routeChatIntentWithSemanticFallback("来点没那么吵的")).resolves.toMatchObject({
      intent: "style_change",
      action: "replan_queue",
      preserveCurrentTrack: true,
      routedBy: "fallback",
    });
  });
});
