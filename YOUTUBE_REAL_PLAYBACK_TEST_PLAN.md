# Claudio YouTube 真实播放验收计划

本文件用于验收 YouTube 专用播放代理在真实网络和真实浏览器中的稳定性。它不是自动化测试替代品，也不是完成记录；只有按阶段执行并保存证据后，才能把对应验收项标记为通过。

核心结论先放在前面：

- `<audio>` 必须请求 `/api/audio/youtube/{videoId}`，不能再请求 `/api/audio/music?url=googlevideo...`。
- 首段和中段 Range 都必须能返回 `206`，中段至少验证 `Range: bytes=1048576-`。
- 同一首 YouTube 曲目必须真实可听 2 分钟以上。
- 完整节目必须真实播放满 20 分钟，并保存 Listen Check 记录。
- 任何日志、接口响应、截图说明和记录都不能包含完整 `googlevideo` URL、Cookie、token 或真实本地路径。

## 阶段门禁

按顺序执行。任一阶段失败时，停止后续阶段，先记录问题并修复。

| 阶段 | 目标 | 是否必须 |
| --- | --- | --- |
| 0 | 环境和安全准备 | 是 |
| 1 | 自动化回归 | 是 |
| 2 | 后端 YouTube 代理真实 Range | 是 |
| 3 | 浏览器真实可听 2 分钟 | 是 |
| 4 | lease 刷新和中段 Range 压力 | 是 |
| 5 | 真实 fallback | 是 |
| 6 | 完整 20 分钟真人实听 | 是 |
| 7 | 证据归档和失败处理 | 是 |

## 阶段 0：环境和安全准备

执行前先记录工作区状态：

```bash
git status --short
```

要求：

- 不回滚、不删除、不清理 `data/`。
- 不打印 `.env` 内容。
- 不把 Cookie、token、`googlevideo` URL 写进测试记录。
- 使用真实可用的 YouTube 配置启动测试环境：`YOUTUBE_ENABLED=true`。
- 如果本机需要代理访问 YouTube，使用已有 `NETWORK_PROXY_URL` 配置。
- 破坏性 fallback 测试必须使用单独的临时 `CLAUDIO_DATA_DIR`，不要污染正式 `data/`。

启动后检查：

```bash
curl.exe -sS http://localhost:3000/api/health
```

通过标准：

- 后端服务正常。
- 前端可打开并连接 WebSocket。
- 没有泄露敏感配置。

## 阶段 1：自动化回归

按顺序运行：

```bash
npm -w backend test
npm -w frontend test
npm test
npm run build
```

通过标准：

- 四个命令全部成功。
- YouTube adapter、代理 Range、fallback、前端 URL 归一化、Listen Check 相关测试都通过。
- 如果任一命令失败，不进入真实播放阶段。

## 阶段 2：后端 YouTube 代理真实 Range 测试

准备一个真实可解析、能播放的 YouTube `videoId`。不要把解析出的底层流地址写进记录。

首段 Range：

```bash
curl.exe -sS -D - -o NUL -H "Range: bytes=0-" http://localhost:3000/api/audio/youtube/{videoId}
```

中段 Range：

```bash
curl.exe -sS -D - -o NUL -H "Range: bytes=1048576-" http://localhost:3000/api/audio/youtube/{videoId}
```

必须检查：

- 首段返回 `206`。
- 中段返回 `206`。
- 中段 `Content-Range` 起点是 `1048576`。
- 响应包含音频类 `Content-Type`。
- 响应包含 `Content-Length`、`Accept-Ranges`、`Cache-Control: no-store`。
- 响应体和服务端日志不包含完整 `googlevideo` URL、Cookie、token。

负向检查：

```bash
curl.exe -sS -D - -o NUL http://localhost:3000/api/audio/youtube/not-valid
```

通过标准：

- 有效 `videoId` 的首段和中段 Range 都返回 `206`。
- 无效 `videoId` 返回安全的 `400` 或 `404`。
- 错误响应不泄露敏感信息。

## 阶段 3：浏览器真实可听 2 分钟

在浏览器打开前端，播放一首 YouTube track。

必须观察：

- Network 面板里的 `<audio>` 请求是 `/api/audio/youtube/{videoId}`。
- 不出现 `/api/audio/music?url=googlevideo...`。
- 同一首 YouTube track 真实可听累计至少 120 秒。
- 中途拖动到 60 秒或 90 秒附近，触发后续 Range。
- 后续 Range 返回 `206`，尤其要确认接近或等于 `bytes=1048576-` 的请求。
- 页面没有显示底层异常，没有长时间静音、卡住或重复错误恢复。

通过标准：

- 真实听到音乐超过 2 分钟。
- 至少一次中段 Range 返回 `206`。
- 播放过程中没有退回 `/api/audio/music?url=...` 泛用代理。

## 阶段 4：lease 刷新和中段 Range 压力测试

不要修改 `.env`。用临时进程环境把 YouTube stream lease TTL 调短，例如 30 秒：

```powershell
$env:YOUTUBE_URL_TTL_MS="30000"
npm run dev
```

执行：

- 播放 YouTube track。
- 等待超过 40 秒。
- 拖动进度，或直接请求 `Range: bytes=1048576-`。
- 重复 3 次中段 Range 请求。

通过标准：

- lease 过期后仍能重新解析并返回 `206`。
- 播放不中断，或短暂停顿后自动恢复。
- 日志只出现安全诊断信息，不出现完整底层流地址。

说明：

- 真实 YouTube `403` 不一定稳定复现。
- “第一次 403 后刷新并重试同一 Range”由后端自动化测试兜底。
- 真实阶段重点验证 lease 过期刷新后中段 Range 仍可继续播放。

## 阶段 5：真实 fallback 验收

使用隔离测试数据目录，不污染正式 `data/`。

推荐流程：

1. 正常网络下启动服务。
2. 生成或选择一首 YouTube track。
3. 确认它正在通过 `/api/audio/youtube/{videoId}` 播放。
4. 停止服务。
5. 用同一个临时数据目录重启，但临时配置一个不可用的网络代理，或断开 YouTube 可访问性。
6. 重新播放或选择该 YouTube track，观察失败处理。

通过标准：

- 后端把该 YouTube track 标记为 failed。
- fallback 解析排除 YouTube，不重新选回同一个 `videoId`。
- 本地库启用时优先 fallback 到本地；否则 fallback 到酷狗。
- 前端自动切到 fallback 或跳过。
- UI、日志和接口响应不暴露 `403` 底层详情、Cookie、token 或 `googlevideo` URL。
- 如果没有可用 fallback，状态保留 failed 诊断，并由现有恢复逻辑跳过。

## 阶段 6：完整 20 分钟真人实听验收

使用正常真实配置，不做故障注入。

执行前：

- 打开 Playback Diagnostics / Program Audit。
- 确认没有阻断性播放问题。
- 在前端开始 Listen Check。

执行中：

- 真实播放节目累计至少 20 分钟。
- 尽量不手动跳歌、不刷新页面、不暂停播放。
- 至少经历一次自然切歌或队列推进。
- 如果 20 分钟内刚好只有一首超长曲目，需要另补一次自然切歌验证。
- 观察音乐连续性、DJ 串场是否打断音乐、fallback 是否可恢复。
- 若出现静音或卡顿，记录发生时间、持续时间、当前曲目和 Network 状态码。

完成后：

```bash
curl.exe -sS http://localhost:3000/api/radio/listen-checks?limit=3
curl.exe -sS http://localhost:3000/api/radio/listen-acceptance
```

通过标准：

- Listen Check 记录显示真实累计播放满 20 分钟。
- 音乐没有长时间中断；单次静音或卡住超过 10 秒必须记录为问题。
- 没有连续 fallback 失败。
- 页面没有暴露底层异常。
- 只有这一阶段真实完成并保存记录后，才能说“20 分钟实听通过”。

## 阶段 7：证据记录和失败处理

每次正式验收保存一份脱敏记录：

```text
测试时间：
分支 / commit：
YouTube videoId：
首段 Range 状态：
中段 Range 状态：
中段 Content-Range：
2 分钟实听结果：
fallback 测试结果：
20 分钟 Listen Check ID：
/api/radio/listen-acceptance 结果：
未通过项：
备注：
```

失败处理规则：

- 中段 Range 没有返回 `206`：停止后续实听，优先修复代理 Range 或 stream 刷新。
- 2 分钟真实可听失败：记录浏览器 Network、前端播放问题上报和后端诊断，不进入 20 分钟验收。
- 20 分钟中出现长静音、频繁断流、fallback 失败或节目无法连续播放：标记为未通过，保存 Listen Check note 和 follow-up。
- 所有失败记录必须脱敏，不能包含完整 `googlevideo` URL、Cookie、token 或真实本地路径。

## 默认假设

- 使用当前 YouTube 专用代理，不新增依赖。
- QQ 音乐仍只作为 metadata，不参与实际播放 URL 解析。
- fallback 顺序沿用现有运行时可播放源顺序，并排除 YouTube。
- 自动化测试通过只是进入真人实听的门槛，不代表最终播放体验已经验收。
- 本计划只定义测试和验收流程，不修改 `.env`、不删除 `data/`、不重置用户已有状态。
