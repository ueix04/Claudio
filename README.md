# Claudio — AI 情感电台

**Claudio** 是一个本地运行的 AI 情感电台。AI DJ 持续规划节目、与听众聊天、根据反馈调整风格，音乐不间断播放。

> ⚠️ **MVP 阶段** — 核心功能在快速迭代中，部分模块可能还不够稳定。

---

## 功能概览

- 🎧 **AI DJ** — 持续规划节目编排，而不是每次临时推荐单首歌
- 🎵 **音乐连续播放** — DJ 话术、TTS 语音合成、LLM 推理均不阻断播放流
- 💬 **实时聊天** — 听众可以和 DJ 对话，DJ 会根据上下文回应
- 👍 **反馈闭环** — 收藏、跳过、负反馈等行为会影响后续节目编排
- 🔍 **音乐发现** — 根据当前曲风和偏好推荐新歌，先验证可播放再入队
- 🎤 **TTS 语音** — DJ 文案以语音播报，支持多音色切换
- 📻 **双 Audio 预加载** — 当前歌曲播放时预加载下一首，实现无缝切歌
- ☁️ **Docker 部署** — 支持容器化部署

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS v4 |
| 后端 | TypeScript + Express + WebSocket |
| 数据 | lowdb（本地 JSON 文件数据库） |
| 构建 | npm workspaces + Vitest |
| 容器 | Docker + Docker Compose |
| 外部服务 | OpenAI-compatible LLM · MiMo TTS · NeteaseCloudMusicApi · OpenWeather |

---

## 快速开始

### 前置要求

- Node.js >= 20
- npm >= 9

### 安装

```bash
# 1. 克隆仓库
git clone https://github.com/ueix04/Claudio.git
cd Claudio

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入必要的 API Key 和配置（见下方说明）
```

### 运行

```bash
# 同时启动前后端开发服务器
npm run dev

# 或分别启动
npm run dev:backend   # http://localhost:3000
npm run dev:frontend  # http://localhost:5173

# 运行测试
npm test
```

### 环境变量

完整变量列表见 `.env.example`，以下是必需项：

| 变量 | 说明 |
|------|------|
| `LLM_API_KEY` | LLM API Key（OpenAI-compatible） |
| `BASE_URL` | LLM API 地址 |
| `MODEL` | LLM 模型名 |
| `MIMO_API_KEY` | MiMo TTS API Key |
| `NETEASE_COOKIE` | 网易云音乐 Cookie（用于获取播放链接） |

所有敏感信息仅放在 `.env`，不会提交到仓库。

---

## 项目结构

```
Claudio/
├── backend/              # 后端服务
│   └── src/
│       ├── server.ts           # Express + WebSocket 入口
│       ├── pipeline.ts         # 电台节目编排
│       ├── radio-session.ts    # 电台会话管理
│       ├── music-sources/      # 音源适配层
│       ├── db.ts               # lowdb 数据层
│       ├── tts.ts              # TTS 语音合成
│       ├── agent-router.ts     # LLM 调用路由
│       ├── taste-profile.ts    # 用户口味画像
│       └── weather.ts          # 天气服务
├── frontend/             # 前端应用
│   └── src/
│       ├── App.tsx             # 主界面（电台 + 聊天双面板）
│       ├── components/         # UI 组件
│       ├── hooks/              # React Hooks
│       ├── types.ts            # 类型定义
│       ├── audio-effects.ts    # 音频效果（淡入淡出、TTS ducking）
│       └── index.css           # Tailwind 样式
├── data/                 # 运行时数据（不提交）
├── docker-compose.yml    # Docker Compose 配置
├── Dockerfile            # 容器镜像
└── .env.example          # 环境变量模板
```

---

## Docker 部署

```bash
# 构建并启动
docker compose up -d --build

# 验证
curl http://localhost:3000/api/health
```

容器默认监听 `127.0.0.1:3000`，建议通过 Nginx 等反代对外暴露。

---

## WebSocket 消息

前端通过 WebSocket（`/ws`）与后端实时通信。

**下行消息**（服务端 → 客户端）：
`state` · `status` · `track` · `dj_message` · `segue` · `chat` · `error`

**上行消息**（客户端 → 服务端）：
`trigger` · `chat` · `queue_next` · `queue_previous` · `playback_issue` · `ping`

---

## 开发准则

- 音乐连续性优先 — LLM/TTS 故障不阻断播放
- 播放链接考虑过期、刷新、fallback 和可播放验证
- 用户反馈影响后续队列，但不粗暴打断当前歌曲
- 新增音源必须走 `music-sources/` 适配层
- 类型定义前后端同步更新

---

## License

MIT
