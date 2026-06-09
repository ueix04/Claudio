# AGENTS.md

本文件是 Claudio 项目的项目级协作规则。所有 AI Agent、Codex、IDE 助手或后续开发者在修改本仓库前必须先阅读并遵守。

如果某个工具只识别单数 `AGENT.md`，需要先和用户确认是否复制一份同内容文件；默认以本文件 `AGENTS.md` 为准。

## 1. 项目定位

Claudio 是一个本地运行的 AI 情感电台 MVP，不是普通音乐播放器，也不是通用后台管理系统。

核心体验是：

- AI DJ 能持续规划一段节目，而不是每次临时推荐单首歌。
- 音乐连续播放优先，DJ 文案、TTS 和 LLM 都不能阻断播放。
- 用户可以聊天、反馈、收藏、跳过，Claudio 根据反馈调整后续节目。
- 当前主线是在线电台稳定性、播放诊断、Discovery、反馈闭环和 20 分钟实听验收。

当前阶段不把本地曲库作为产品主线。已有本地曲库能力只作为隐藏/备选能力保留，不要主动把界面和需求重心转回本地曲库，除非用户明确要求。

## 2. 技术栈和运行方式

项目使用 npm workspaces：

- 根目录：统一脚本、Vitest 聚合配置。
- `backend/`：TypeScript + Express + WebSocket + lowdb。
- `frontend/`：React 18 + Vite + Tailwind CSS v4 + Vitest。
- 数据默认写入 `data/`，测试默认写入 `data.test/`。

常用命令：

- 安装依赖：`npm install`
- 前后端开发：`npm run dev`
- 后端开发：`npm run dev:backend`
- 前端开发：`npm run dev:frontend`
- 全量测试：`npm test`
- 构建检查：`npm run build`
- 后端测试：`npm -w backend test`
- 前端测试：`npm -w frontend test`
- 前端 e2e：`npm -w frontend run test:e2e`

开发端口默认：

- 后端：`http://localhost:3000`
- 前端：`http://localhost:5173`
- WebSocket：`/ws`

线上部署（截至 2026-06-09）：

- 线上服务器 SSH 别名：`ssh ny-server`。
- 线上部署目录：`/srv/apps/claudio`。
- 线上目录当前不是 git worktree，更新通常通过本地打包/同步项目文件后在服务器重建容器完成。
- 线上使用 Docker Compose，Compose 配置文件为 `/srv/apps/claudio/docker-compose.yml`，项目名 `claudio`，服务名 `claudio`，容器名 `claudio`，镜像名 `claudio-claudio`。
- 容器对外只绑定本机端口：`127.0.0.1:3000->3000/tcp`；数据目录挂载为 `/srv/apps/claudio/data:/app/data`。
- Nginx 反代域名：`https://claudio.ruike5.ccwu.cc`，代理到 `http://127.0.0.1:3000`。
- 线上 `.env` 位于 `/srv/apps/claudio/.env`，包含密钥、Cookie 和第三方服务配置；部署代码时不要默认覆盖 `.env`，除非用户明确要求同步配置。
- 线上 `data/` 是运行数据目录，部署、测试或排障时不要删除、重置或覆盖。
- 常规代码部署后，在服务器执行 `docker compose build claudio && docker compose up -d claudio`，然后用 `docker compose ps`、容器 healthcheck 和 `/api/health` 验证。
- 更新前建议备份服务器现有源码到 `/srv/apps/claudio-deploy-backups/`；备份不应包含 `.env` 的明文输出。

当前项目尚未声明 `engines` 或 `.nvmrc`。本机已观察到的环境是 Node.js `v24.10.0`、npm `11.6.1`，但这不等于项目已经正式锁定该版本；如果要提高可复现性，应后续补充版本约束。

## 3. 目录边界

### `backend/`

后端负责：

- REST API 和 WebSocket 消息分发。
- 电台节目规划、队列维护、串场、播放 URL 刷新。
- LLM 调用、MiMo TTS、天气、网易云歌单同步。
- 音源适配层、fallback、播放诊断、实听验收记录。
- lowdb 状态读写。

修改后端时注意：

- 不要绕过 `runtime.ts` 里的路径和 `.env` 加载逻辑。
- 不要硬编码本机绝对路径。
- 不要让 LLM/TTS 失败阻断音乐播放。
- 新增音源必须走 `music-sources` 适配层，不能把第三方音源调用散落到业务逻辑里。
- 播放 URL 是运行时缓存，必须考虑过期、刷新、fallback 和可播放验证。
- REST/WebSocket payload 变化时，要同步更新前端类型和解析逻辑。

### `frontend/`

前端负责：

- 电台播放器和聊天 DJ 双面板界面。
- 双 audio 预加载、切歌、淡入淡出、TTS ducking。
- 音频错误恢复、低音频信号检测、播放问题上报。
- Playback Diagnostics、Taste、Feedback、Discovery、Listen Check 等面板。

修改前端时注意：

- 保持现有沉浸式电台风格，不要改成普通 SaaS 后台或营销页。
- 保留黑/浅主题变量、像素时钟、播放器面板、聊天面板和底部播放控制。
- 不要移除双 audio 预加载、TTS 压低音乐、音频信号采样和自动恢复链路。
- 界面可以显示诊断信息，但不能暴露 Cookie、API key、真实本地路径或隐私配置。
- 空状态和错误提示要面向普通用户，不要直接堆底层异常。

### `data/` 和 `data.test/`

- `data/` 是正式本地运行状态，可能包含用户歌单快照、播放历史、反馈、TTS 缓存。
- `data.test/` 是测试数据目录。
- 两者都不应提交。
- 不要在未确认前删除、重置或覆盖 `data/`。
- 测试或调试需要隔离数据时，优先使用 `CLAUDIO_DATA_DIR` 或测试环境默认目录。

### 文档

- `ONLINE_RADIO_AGENT_PROGRESS.md` 记录当前在线电台主线进展。
- `PLAN.md` 是阶段性改善计划，部分内容已经完成或转为历史记录。
- `HANDOFF.md` 有旧交接信息，其中 opencode 相关内容可能已和当前代码不一致。
- 当前代码和最新进度文档优先于旧交接文档。

## 4. 环境变量和安全

敏感信息只能放在 `.env`，不要写入代码、测试快照、日志或文档。

重要变量包括：

- `LLM_API_KEY`、`BASE_URL`、`MODEL`
- `MIMO_API_KEY`、`MIMO_API_BASE`、`MIMO_TTS_MODEL`、`MIMO_TTS_VOICE`
- `NETEASE_COOKIE`
- `OPENWEATHER_API_KEY` 及默认天气位置
- `CLAUDIO_DATA_DIR`
- `LOCAL_MUSIC_ENABLED`、`LOCAL_MUSIC_DIRS`
- `UNBLOCK_NETEASE_ENABLED`、`UNBLOCK_NETEASE_SOURCES`

注意：

- 不要打印 `.env` 内容。
- 不要把 `NETEASE_COOKIE`、API key、Cookie、token 写进提交。
- 不要把真实本地音乐目录路径返回给前端或写进公开文档。
- 涉及账号登录、付费服务、公开发布、删除数据、迁移数据时，必须先让用户确认。

## 5. 产品和体验规则

优先级：

1. 音乐连续性。
2. 播放链路可诊断、可恢复。
3. DJ 话术自然、短、具体。
4. 用户反馈能影响后续节目。
5. 页面稳定、清楚、不中断使用。

必须保持：

- 当前歌和后续歌曲要主动维护播放 URL。
- URL 过期、502、坏音频、静音都要进入刷新、fallback 或跳过链路。
- fallback 只解决播放链接问题，不应随意改变歌曲身份。
- Discovery 必须先验证可播放，不能让 LLM 凭空决定最终播放歌曲。
- 第一首应稳，探索比例要克制；负反馈后不要继续冒险。
- 天气只在用户询问、节目开场或确实相关时出现，不要强行提天气。
- DJ 不要长篇抒情、装深沉、重复开场、频繁打断音乐。
- 用户反馈默认影响后续队列，不要粗暴打断当前歌，除非用户明确要求切歌或换方向。

## 6. 接口和状态约束

WebSocket 下行消息包括：

- `state`
- `status`
- `dj_message`
- `track`
- `chat`
- `segue`
- `error`

WebSocket 上行消息包括：

- `trigger`
- `chat`
- `queue_next`
- `queue_previous`
- `queue_prefetch`
- `queue_select`
- `playback_issue`
- `ping`

修改接口时：

- 保持向后兼容，尤其是 `track.name/title`、`status` 字符串/对象兼容。
- 后端 `db.ts`、前端 `types.ts`、`useWebSocket.ts` 要同步更新。
- 新增字段可以渐进添加，删除或改名要非常谨慎。
- 错误返回不要泄露密钥、Cookie、真实路径或完整外部响应。

## 7. 测试和验收

修改前先看 `git status --short`，确认哪些是已有改动。不要回滚不是自己产生的改动。

常规修改后至少运行：

- 后端相关：`npm -w backend test`
- 前端相关：`npm -w frontend test`
- 跨前后端或共享契约：`npm test`
- 发布前或大改：`npm run build`

高风险功能需要额外验证：

- `/api/pipeline/trigger`
- WebSocket trigger/chat/queue 流程
- `/api/audio/tts/:filename` 路径穿越防护
- `/api/radio/playback-diagnostics`
- `/api/radio/listen-checks`
- `/api/radio/listen-acceptance`
- 播放 URL 刷新、fallback、低音频信号恢复
- 前端双 audio 预加载和 TTS ducking

不要把“自动测试通过”等同于“20 分钟实听通过”。真人连续 20 分钟实听必须真实完成并保存记录后，才能说最终听感验收完成。

## 8. 修改原则

- 只改和当前任务直接相关的文件。
- 不做无关重构。
- 不随意更换框架、状态管理、UI 体系或构建方式。
- 不因为某个模块变大就立刻大拆；拆分必须降低真实复杂度。
- 不新增来源不明或维护状态差的依赖。
- 格式化只针对相关文件；不要无故全仓库格式化。
- 发现旧文档和当前代码冲突时，以当前代码和最新进度文档为准，并在交付中说明冲突。
- 无法验证时必须明确说“未验证”，不要假装已经跑通。

### Git 提交和同步规则

- 每次修改前后都要运行 `git status --short`，确认当前工作区状态和改动范围。
- 只提交本次任务直接相关的文件；不要把用户已有改动、`.env`、`data/`、密钥、Cookie、token、真实本地路径或无关格式化一起提交。
- 修改完成后必须运行与改动范围匹配的验证。验证失败或无法验证时，不自动提交或推送，必须说明原因并等待进一步指令。
- 验证通过后，要检查 diff 是否包含敏感信息或无关改动；确认无问题后，默认创建一次清晰的 commit，并推送到当前分支已配置的 GitHub upstream 远端。
- `force push`、改写历史、删除远端分支、切换发布目标、覆盖线上配置、部署上线等高风险操作，仍然必须先得到用户确认。
- 最终交付时必须说明 commit 是否已创建、push 是否成功、验证是否通过；不能把“已修改”说成“已同步到 GitHub”。

## 9. 当前已知未完成项

- 最终真人连续 20 分钟实听尚未完成，不能标记为最终通过。
- `HANDOFF.md` 里的 opencode 约束与当前代码的 OpenAI-compatible LLM 调用链存在冲突，后续需要用户确认是否仍是硬要求。
- `.env.example` 可能还需要补齐 `UNBLOCK_NETEASE_ENABLED` / `UNBLOCK_NETEASE_SOURCES` 等当前代码已使用的配置说明。
- 项目缺少面向新开发者的 README，需要补充安装、启动、环境变量和验收流程。

## 10. 后续建议补充

- 确认 LLM 主链路：当前代码使用 `LLM_API_KEY` / `BASE_URL` / `MODEL` 的 OpenAI-compatible 接口；旧 `HANDOFF.md` 写过必须使用 `opencode`，这条需要最终确认并统一文档。
- 补一份 `README.md`：包含安装、启动、端口、环境变量、常见故障、20 分钟实听流程。
- 补齐 `.env.example`：尤其是 `UNBLOCK_NETEASE_ENABLED`、`UNBLOCK_NETEASE_SOURCES` 这类代码已使用但示例里没写的变量。
- 明确 Node/npm 版本：建议增加 `.nvmrc` 或在 README/AGENTS.md 中写明正式推荐版本，避免后续环境漂移。
- 明确数据备份/重置流程：尤其是 `data/state.json`、TTS 缓存、测试数据目录如何安全清理。
- 明确外部服务风险：网易云 Cookie、UnblockNeteaseMusic、MiMo、OpenWeather、LLM provider 的可用性、费用和合规边界。
- 明确最终验收口径：20 分钟实听通过后，应该更新哪个文档、保存哪些证据、哪些标准才算真正完成。
