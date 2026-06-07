import { describe, expect, it } from "vitest";
import { routeChatIntent } from "./agent-router.js";

describe("Chat Intent Router", () => {
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
});
