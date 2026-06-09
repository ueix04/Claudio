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

  it("routes style changes to upcoming queue replans without interrupting current track", () => {
    expect(routeChatIntent("换安静一点")).toMatchObject({
      intent: "style_change",
      action: "replan_queue",
      preserveCurrentTrack: true,
    });

    expect(routeChatIntent("换歌阿！！！")).toMatchObject({
      intent: "style_change",
      action: "replan_queue",
      preserveCurrentTrack: true,
    });

    expect(routeChatIntent("change")).toMatchObject({
      intent: "style_change",
      action: "replan_queue",
      preserveCurrentTrack: true,
    });

    expect(routeChatIntent("switch it up")).toMatchObject({
      intent: "style_change",
      action: "replan_queue",
      preserveCurrentTrack: true,
    });

    expect(routeChatIntent("我要听电子音乐")).toMatchObject({
      intent: "style_change",
      action: "replan_queue",
      preserveCurrentTrack: true,
    });
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

  it("falls back when semantic LLM times out", async () => {
    vi.mocked(claude.callJsonLLM).mockRejectedValue(new Error("timeout"));

    const route = await routeChatIntentWithSemanticFallback("来点没那么吵的");

    expect(route).toMatchObject({
      intent: "ordinary_chat",
      action: "reply_only",
      routedBy: "fallback",
    });
  });

  it("falls back when semantic LLM returns illegal or low-confidence routes", async () => {
    vi.mocked(claude.callJsonLLM).mockResolvedValueOnce({
      intent: "playback_control",
      action: "skip_track",
      confidence: 0.95,
      reason: "illegal direct playback action",
    });

    await expect(routeChatIntentWithSemanticFallback("来点没那么吵的")).resolves.toMatchObject({
      intent: "ordinary_chat",
      action: "reply_only",
      routedBy: "fallback",
    });

    vi.mocked(claude.callJsonLLM).mockResolvedValueOnce({
      intent: "style_change",
      action: "replan_queue",
      confidence: 0.41,
      reason: "too uncertain",
    });

    await expect(routeChatIntentWithSemanticFallback("来点没那么吵的")).resolves.toMatchObject({
      intent: "ordinary_chat",
      action: "reply_only",
      routedBy: "fallback",
    });
  });
});
