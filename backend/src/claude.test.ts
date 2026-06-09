import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractJson, callClaude, callJsonLLM, callTextLLM, buildContextPrompt, getLlmTaskTimeoutMs } from "./claude";

describe("extractJson", () => {
  const validPayload = {
    say: "早上好，为你带来一首温暖的歌",
    ttsText: "（轻声）早上好，为你带来一首温暖的歌。",
    play: [{ title: "晴天", artist: "周杰伦", mood: "nostalgic", reason: "经典旋律" }],
    reason: "用经典旋律唤醒美好的一天",
    segue: "接下来是这首",
  };

  it("从带前后文本的字符串提取 JSON", () => {
    const raw = `这是我的一些想法...\n${JSON.stringify(validPayload)}\n希望你喜欢`;
    const result = extractJson(raw);
    expect(result).toEqual(validPayload);
  });

  it("提取纯 JSON 字符串", () => {
    const raw = JSON.stringify(validPayload);
    const result = extractJson(raw);
    expect(result).toEqual(validPayload);
  });

  it("提取多行 JSON", () => {
    const raw = `前缀文本\n${JSON.stringify(validPayload, null, 2)}\n后缀文本`;
    const result = extractJson(raw);
    expect(result).toEqual(validPayload);
  });

  it("提取嵌套对象 JSON", () => {
    const nested = {
      say: "ok",
      play: [{ title: "x", artist: "y", mood: "z", reason: "r" }],
      reason: "good",
      segue: "next",
    };
    const raw = `---\n${JSON.stringify(nested)}\n---`;
    const result = extractJson(raw);
    expect(result).toEqual(nested);
  });

  it("无花括号时抛出异常", () => {
    expect(() => extractJson("这只是普通文本，没有任何 JSON")).toThrow("未找到有效 JSON");
  });

  it("只有开括号没有闭括号时抛出异常", () => {
    expect(() => extractJson("前面 { 中间不存在")).toThrow("未找到有效 JSON");
  });

  it("花括号顺序颠倒时抛出异常", () => {
    expect(() => extractJson("后面 } 前面 {")).toThrow("未找到有效 JSON");
  });

  it("无效 JSON 时抛出异常", () => {
    expect(() => extractJson("{invalid json stuff}")).toThrow("JSON 解析失败:");
  });

  it("JSON 值为 null 时抛出异常", () => {
    expect(() => extractJson("text {null} end")).toThrow("JSON 解析失败");
  });

  it("JSON 值为数组时抛出异常", () => {
    expect(() => extractJson("text [1,2,3] end")).toThrow("未找到有效 JSON");
  });

  it("空字符串抛出异常", () => {
    expect(() => extractJson("")).toThrow("未找到有效 JSON");
  });
});

describe("buildContextPrompt", () => {
  it("morning_brief 模式生成正确 prompt", () => {
    const result = buildContextPrompt({
      mode: "morning_brief",
      timeOfDay: "08:30",
      recentHistory: "昨日: 晴天",
      playlistContext: "【我的收藏】: 晴天 - 周杰伦, 夜曲 - 周杰伦",
      weatherContext: "香港当前天气多云，气温28°C，体感31°C，湿度82%",
    });

    expect(result).toContain("Claudio");
    expect(result).toContain("08:30");
    expect(result).toContain("轻松活泼的晨间简报");
    expect(result).toContain("实时天气: 香港当前天气多云");
    expect(result).toContain("昨日: 晴天");
    expect(result).toContain("只输出 JSON");
  });

  it("mood_pick 模式生成正确 prompt", () => {
    const result = buildContextPrompt({
      mode: "mood_pick",
      timeOfDay: "14:00",
      recentHistory: "上一首: 好久不见",
      playlistContext: "",
    });

    expect(result).toContain("基于用户心情推荐一首歌");
    expect(result).toContain("14:00");
    expect(result).toContain("上一首: 好久不见");
  });

  it("random_discover 模式生成正确 prompt", () => {
    const result = buildContextPrompt({
      mode: "random_discover",
      timeOfDay: "20:00",
      recentHistory: "",
      playlistContext: "",
    });

    expect(result).toContain("随机发现一首冷门好歌");
    expect(result).toContain("无");
  });

  it("包含所有必需字段说明", () => {
    const result = buildContextPrompt({
      mode: "morning_brief",
      timeOfDay: "10:00",
      recentHistory: "none",
      playlistContext: "",
    });

    expect(result).toContain("say:");
    expect(result).toContain("ttsText:");
    expect(result).toContain("play:");
    expect(result).toContain("reason:");
    expect(result).toContain("segue:");
    expect(result).toContain("title（必填）");
    expect(result).toContain("不要编造未提供的天气细节");
  });

  it("Dean 音色会生成英文提示词", () => {
    const result = buildContextPrompt({
      mode: "random_discover",
      timeOfDay: "23:40",
      recentHistory: "last track: Yellow",
      playlistContext: "Coldplay, The 1975",
      weatherContext: "Hong Kong cloudy, 24°C",
      djVoice: "Dean",
    });

    expect(result).toContain("You are Claudio");
    expect(result).toContain("natural English");
    expect(result).toContain("Return JSON only");
    expect(result).not.toContain("中文 30-80 字");
  });
});

describe("callClaude", () => {
  const validResponse = {
    say: "嗨，来听首歌吧",
    play: [{ title: "稻香", artist: "周杰伦", mood: "warm", reason: "旋律温暖" }],
    reason: "让人回到童年",
    segue: "接下来还有惊喜",
  };

  const clearLlmEnv = () => {
    delete process.env.LLM_API_KEY;
    delete process.env.BASE_URL;
    delete process.env.MODEL;
    delete process.env.LLM_PROVIDER_ORDER;
    delete process.env.LLM_PRIMARY_API_KEY;
    delete process.env.LLM_PRIMARY_BASE_URL;
    delete process.env.LLM_PRIMARY_MODEL;
    delete process.env.LLM_PRIMARY_TIMEOUT_MS;
    delete process.env.LLM_BACKUP_API_KEY;
    delete process.env.LLM_BACKUP_BASE_URL;
    delete process.env.LLM_BACKUP_MODEL;
    delete process.env.LLM_BACKUP_TIMEOUT_MS;
    delete process.env.LLM_SEMANTIC_ROUTER_TIMEOUT_MS;
    delete process.env.LLM_CHAT_SWITCH_TIMEOUT_MS;
    delete process.env.LLM_STARTUP_TIMEOUT_MS;
    delete process.env.LLM_DISCOVERY_TIMEOUT_MS;
  };

  const configureMultiProviderEnv = () => {
    clearLlmEnv();
    process.env.LLM_PROVIDER_ORDER = "primary,backup";
    process.env.LLM_PRIMARY_API_KEY = "primary-key";
    process.env.LLM_PRIMARY_BASE_URL = "https://primary.example.com/v1";
    process.env.LLM_PRIMARY_MODEL = "primary-model";
    process.env.LLM_PRIMARY_TIMEOUT_MS = "12000";
    process.env.LLM_BACKUP_API_KEY = "backup-key";
    process.env.LLM_BACKUP_BASE_URL = "https://backup.example.com/v1";
    process.env.LLM_BACKUP_MODEL = "backup-model";
    process.env.LLM_BACKUP_TIMEOUT_MS = "12000";
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    clearLlmEnv();
    process.env.LLM_API_KEY = "test-key";
    process.env.BASE_URL = "https://example.com/v1";
    process.env.MODEL = "test-model";
  });

  afterEach(() => {
    clearLlmEnv();
    vi.unstubAllGlobals();
  });

  it("task timeout defaults are separate from provider timeouts", () => {
    configureMultiProviderEnv();

    expect(getLlmTaskTimeoutMs("semantic_router")).toBe(20_000);
    expect(getLlmTaskTimeoutMs("chat_switch")).toBe(90_000);
    expect(getLlmTaskTimeoutMs("startup")).toBe(120_000);
    expect(getLlmTaskTimeoutMs("discovery")).toBe(45_000);
  });

  it("task timeout can be overridden from env", () => {
    process.env.LLM_CHAT_SWITCH_TIMEOUT_MS = "65000";
    process.env.LLM_STARTUP_TIMEOUT_MS = "100000";

    expect(getLlmTaskTimeoutMs("chat_switch")).toBe(65_000);
    expect(getLlmTaskTimeoutMs("startup")).toBe(100_000);
  });

  it("成功调用并返回解析结果", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(validResponse),
          },
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callClaude("推荐一首歌");

    expect(result).toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(Object),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("test-model");
    expect(body.messages[1].content).toBe("推荐一首歌");
  });

  it("支持自定义超时时间", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(validResponse) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await callClaude("推荐一首歌", 30_000);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("HTTP 错误时抛出接口消息", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        message: "bad request",
      },
    }), { status: 400 })));

    await expect(callClaude("test")).rejects.toThrow("bad request");
  });

  it("fetch 拒绝时透传异常", async () => {
    const fetchError = new Error("ETIMEDOUT");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchError));

    await expect(callClaude("test")).rejects.toThrow("ETIMEDOUT");
  });

  it("文本调用返回去掉 markdown fence 的内容", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "```text\nhello\n```" } }],
    }), { status: 200 })));

    await expect(callTextLLM("say hi")).resolves.toBe("hello");
  });

  it("多 provider 会在 primary 网络错误后切到 backup", async () => {
    configureMultiProviderEnv();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validResponse) } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callClaude("推荐一首歌", 30_000);

    expect(result).toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://primary.example.com/v1/chat/completions");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://backup.example.com/v1/chat/completions");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).model).toBe("primary-model");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).model).toBe("backup-model");
  });

  it("多 provider 会在 primary 返回 429 后切到 backup", async () => {
    configureMultiProviderEnv();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "rate limited" },
      }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validResponse) } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callClaude("推荐一首歌", 30_000)).resolves.toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("JSON 调用会在 primary 返回非 JSON 内容后切到 backup", async () => {
    configureMultiProviderEnv();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "not json" } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validResponse) } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callJsonLLM("推荐一首歌", 30_000)).resolves.toEqual(validResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("文本调用也会在 primary 空响应后切到 backup", async () => {
    configureMultiProviderEnv();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "" } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "```text\nhello\n```" } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callTextLLM("say hi", 30_000)).resolves.toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("所有 provider 失败时返回汇总错误且不泄露 key", async () => {
    configureMultiProviderEnv();
    process.env.LLM_PRIMARY_API_KEY = "primary-secret";
    process.env.LLM_BACKUP_API_KEY = "backup-secret";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Bearer primary-secret ETIMEDOUT"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "invalid key backup-secret" },
      }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callClaude("test", 30_000)).rejects.toThrow(
      "LLM request failed across providers: primary: Bearer [redacted] ETIMEDOUT; backup: invalid key [redacted]",
    );
  });
});
