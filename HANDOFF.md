# Handoff

**Date:** 2026-05-06  
**Project:** Claudio AI Radio  
**User preference:** 必须使用 `opencode` 实现 AI 电台的决策和聊天功能

## 1. 当前结论

本轮对话的核心问题已经从“LLM 调用链没打通”推进到“主链路已打通，剩余主要是外部依赖稳定性和体验收尾”。

已确认：

- `opencode` 已接入并可用于决策 JSON 输出与聊天文本输出
- 后端 `POST /api/pipeline/trigger` 已能成功返回 `200`
- WebSocket `trigger` 主流程已能跑通
- WebSocket `chat` 已能走通 user -> LLM -> dj reply -> 持久化
- `/api/audio/tts/:filename` 已拦截路径穿越并返回 `403`
- `/api/history` 已取消硬编码截断 20 条
- 前端已修复若干与状态流和播放展示相关的问题

## 2. 用户诉求

用户明确要求：

- 用 `opencode` 来实现 AI 电台的“决策”和“聊天”功能
- 不接受只保留旧的 LLM 占位链路
- 在此基础上继续修复问题，并补完功能测试

## 3. 已完成的关键修复

### 3.1 LLM / opencode 链路

已打通两类调用：

- `callLLM()`：用于输出结构化 JSON 决策结果
- `callTextLLM()`：用于输出纯文本聊天回复

成功示例：

`callLLM()` 输入：

```txt
请只输出JSON:{"say":"你好","play":[],"reason":"测试"}
```

`callLLM()` 输出：

```json
{
  "say": "你好",
  "play": [],
  "reason": "测试"
}
```

`callTextLLM()` 输入：

```txt
你好，请只回复 hello
```

`callTextLLM()` 输出：

```txt
hello
```

### 3.2 Pipeline 主链路

`POST /api/pipeline/trigger` 现在可返回包含以下字段的结果：

- `status`
- `djMessage`
- `tracks`
- `reason`
- `segue`

### 3.3 WebSocket 主链路

WebSocket `trigger` 现已验证能收到如下状态序列：

```json
[
  { "type": "status", "data": "thinking" },
  { "type": "status", "data": "speaking" },
  { "type": "dj_message", "data": { "text": "..." } },
  {
    "type": "track",
    "data": {
      "id": 1318733599,
      "name": "Sunflower",
      "title": "Sunflower",
      "artist": "Post Malone, Swae Lee",
      "url": "..."
    }
  },
  { "type": "status", "data": "playing" }
]
```

WebSocket `chat` 现已验证：

- 用户消息会回写到聊天记录
- 后端会调用 `opencode`
- DJ 回复会返回到前端
- user / dj 消息都能写入 `state.json`

### 3.4 前端已修复问题

已修复：

- `status` 消息格式兼容
- `track.name` / `track.title` 字段兼容
- 聊天消息重复回显
- DJ 聊天消息未更新 subtitle
- pipeline 成功后播放按钮、音频 `src`、`QUEUE` 展示异常

## 4. 当前实现决策

### 4.1 为什么不继续直接调用 `opencode run`

不建议继续把后端同步绑定到 `opencode run ...` CLI 调用。主要原因：

- Windows 环境下 `execFile("opencode")` 容易出现 `ENOENT`
- `opencode run` 在当前环境里存在卡住问题
- 本机默认 agent 被插件改成了较重的 `Sisyphus (Ultraworker)`，不适合这里的同步服务调用

### 4.2 当前采用的方案

后端现在改为：

- 启动或复用 `opencode serve`
- 通过本地 HTTP API 创建 session 并发送 `/message`
- 默认显式指定 `agent = build`

### 4.3 相关环境变量

- `OPENCODE_AGENT` 默认值：`build`
- `OPENCODE_MODEL` 可选，例如：
  - `giteai/GLM-5`
  - `giteai/GLM-4.7-Flash`

如果未显式指定，`opencode` 会退回本机默认模型配置。

## 5. 重要环境背景

### 5.1 仓库状态

- 当前目录不是 git repo，`git status` 不可用
- 有效配置来源是项目根目录的 `.env`
- 之前出现过后端从 `backend/` 启动时读不到根目录 `.env` 的问题

### 5.2 外部依赖现状

#### Fish Audio

当前经常失败，常见错误：

- `402 Insufficient Balance`
- `fetch failed`
- `ECONNRESET`

这不会再阻断 pipeline 主流程，但会造成：

- 没有 TTS 音频
- WebSocket 的 `dj_message` 里可能没有 `ttsAudioPath`

#### 网易云用户信息

`getUserAccount()` 当前常见报错：

```txt
获取用户信息失败: 未找到 profile
```

目前已做降级处理：

- 不阻断 pipeline 主流程
- 但拿不到“用户歌单上下文”

#### 网易云歌曲解析

部分歌曲解析时会出现：

```txt
502 socket hang up
```

目前已在 pipeline 中加入 fallback 曲目兜底，避免出现 DJ 说完但无歌可播的情况。

## 6. 已修改文件

主要变更涉及：

- `backend/src/runtime.ts`
- `backend/src/claude.ts`
- `backend/src/server.ts`
- `backend/src/pipeline.ts`
- `backend/src/tts.ts`
- `backend/src/db.ts`
- `backend/src/netease.ts`
- `frontend/src/hooks/useWebSocket.ts`
- `frontend/src/types.ts`

备注：

- `data/state.json` 已恢复到测试前内容，避免把临时测试数据留在交付状态里

## 7. 已完成验证

已确认通过：

- `npm run build`
- `npm -w backend test`

测试结果：

- 后端测试通过 `48/48`
- 浏览器无头验证中已观察到：
  - `audio src` 非空
  - 播放按钮出现
  - `QUEUE / 1 TRACKS`
  - subtitle 正常显示

## 8. 尚未完全收尾的事项

### P1. 优化降级体验

1. TTS 失败时前端体验仍可更自然
- 现在即使 TTS 失败，音乐依然能播
- 但状态切换节奏仍可能略显突兀
- 建议在无 `ttsAudioPath` 时更快切到 `track` / `playing`

2. 网易云用户信息失败的日志可再温和一些
- 目前“无 profile”更像可接受降级，而不是硬错误
- 建议降低日志噪音

### P1. 重跑重点功能测试

建议重点回归以下项目：

- A3 `/api/pipeline/trigger`
- A16 `/api/audio/tts/../.env`
- B2 WebSocket trigger 全链路
- B4 WebSocket chat
- C2 / C3 / C4 / C11 前端 pipeline、播放和 queue
- D1 / D2 / D4 持久化

### P2. 前端全屏功能人工复查

之前曾怀疑聊天面板全屏失效，但后续单独验证时更像是测试脚本判断不准。建议人工再次点击确认：

- 播放器全屏
- 聊天面板全屏

## 9. 推荐下一个 LLM 的起手动作

最适合继续的三件事：

1. 继续优化 `backend/src/pipeline.ts` 和 `backend/src/server.ts` 的降级体验
2. 重新跑一轮 A / B / C / D 重点功能测试并记录结果
3. 视需要把 `OPENCODE_AGENT` / `OPENCODE_MODEL` 写入 `.env.example` 与 README

## 10. 一句话总结

这次对话最重要的成果是：`opencode` 已经真正接到 AI 电台主链路里，剩余问题主要集中在外部服务稳定性、前端状态细节和完整回归测试，而不再是“LLM 根本没打通”。
