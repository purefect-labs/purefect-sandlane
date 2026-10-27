<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  Worker 自带的只读状态面板：启用、字段说明与安全说明。
-->

# 状态面板（只读）

Worker 进程内的轻量状态页，不依赖任何控制面或外部服务：显示通道与并发占用、各 lane 当前在做什么、
沙箱节点（Broker）容量、最近的 Run 及其阶段计时、网关调用统计、上游预连结果、版本与启动时间。
数据只在内存中，Worker 重启即清空；不写盘、不上报。

## 启用

| 变量 | 默认 | 说明 |
|---|---|---|
| `SANDLANE_STATUS_PORT` | 未设置 = 不启用 | 监听端口；未设置或为空时不创建监听 |
| `SANDLANE_STATUS_BIND` | `127.0.0.1` | 监听地址（IP 字面量）。容器内需 `0.0.0.0`，再只把端口映射到宿主机回环 |
| `SANDLANE_STATUS_TOKEN` / `_FILE` | 无 | 可选访问令牌（32..256 个可打印字符，文件须 0600/0400）。设置后所有请求要带 `Authorization: Bearer <token>` 或 `?token=<token>` |
| `SANDLANE_STATUS_RUN_IDS` | `hash` | Run 标识显示方式：`hash`（进程内随机密钥的 12 位 HMAC 短哈希，不能由数字 ID 反推，重启后变化）、`plain`（原样，便于对照日志）、`none`（只显示序号） |
| `SANDLANE_STATUS_RECENT_RUNS` | `50` | 保留的已结束 Run 条数（环形缓冲，1..500） |
| `SANDLANE_STATUS_HOSTS` | 无 | 除 IP 字面量和 `localhost` 外允许的 Host 名（逗号分隔），经反向代理用域名访问时设置 |

示例（docker run）：

```sh
-e SANDLANE_STATUS_PORT=19445 -e SANDLANE_STATUS_BIND=0.0.0.0 -p 127.0.0.1:19445:19445
```

`compose.runtime.yaml` 的 `execution` 服务已带同样的映射（只发布到 `127.0.0.1`），设置
`SANDLANE_STATUS_PORT=19445` 即启用。启动后日志有一条 `STATUS_PANEL_LISTENING`（地址、端口、是否带令牌）。

访问：

- `GET /`：单个自包含 HTML 页，无外部资源，每 2 秒轮询 JSON；亮暗色跟随系统。带令牌时用
  `http://127.0.0.1:19445/?token=...` 打开，页面脚本从地址读取令牌并以 Bearer 头请求 JSON。
- `GET /status.json`：同一份数据的 JSON。
- 只支持 `GET`/`HEAD`，其他方法返回 405，其他路径 404。

## 字段（`/status.json`，`schemaVersion: 1`）

| 字段 | 内容 |
|---|---|
| `worker` | `version`（package.json）、`startedAt`、`uptimeMs`、`runtimeId`、`nodeId`、`harnesses` |
| `lanes` | `queues`（领取的控制面队列）、`concurrency`（lane 数 = 并发上限）、`busy`（执行中的 lane 数）；`items[]`：`index`、`state`、`since`、`run`（执行中 Run 的显示标识）、`lastError`（最近一次领取失败的错误码，领取恢复后清除） |
| `sandbox` | Broker status，最多每 2 秒取一次（并发请求共用一次查询，超时 2 秒）：`reachable`、`ready`、`active`（活跃分配）、`idleSessions`（空闲会话）、`capacity`、`perTenant`、`queuedOperations`、`sessionIdleMs`、`network`、`harnesses`、`checkedAt`；不可达时只有 `reachable:false`、`error`、`checkedAt` |
| `runs` | `idMode`、`capacity`（环形缓冲大小）、`active[]`（执行中）、`recent[]`（已结束，新的在前） |
| `runs.*[]` | `id`、`harness`、`lane`、`startedAt`、`phases`、`durationMs`、`status`（`running`/`SUCCEEDED`/`FAILED`/`CANCELLED`）、`settlement`、`error`、`toolCalls`、`toolFailures` |
| `gateways.model` / `gateways.tool` | `calls`、`failed`、`inFlight`、`limit`（并发上限）、`errors`（错误码 → 次数，最多 16 种，其余计入 `OTHER`） |
| `upstream` | 模型上游预连接：`preconnects`（成功次数）、`failures`、`last`（`ok`、`at`、`elapsedMs` 握手耗时、`error`） |

lane `state`：

- `idle`：未在领取（刚启动、Run 结束后、领取失败后的退避）。
- `claiming`：领取长轮询进行中，即“空闲等待作业”。
- `running`：正在执行 Run（含沙箱准备、回合、结算）。
- `stopped`：已排空或停止。

`phases`：各阶段相对“领取返回”的毫秒数，每个阶段只记第一次。

- `claimed`：领取返回，恒为 0。
- `sandbox-ready`：沙箱会话就绪。
- `started-acked`：控制面确认 started。
- `turn-admitted`：CLI 回合放行。
- `first-text`：CLI 收到首段文字。
- `first-delta-synced`：首段文字已同步到控制面。
- `turn-ended`：回合结束。

`settlement`：

- `settled`：结果已被控制面接受。
- `rejected`：控制面拒绝，或重试到期放弃。
- `lost`：租约丢失，不提交结果。
- `withheld`：沙箱停止未确认，暂不结算，等租约过期。

`error` 是 Run 结果的错误码（如 `harness_failure`、`sandbox_unavailable`）。

网关的 `calls`/`failed`/`inFlight` 在网关入口外层计数：模型网关按每次模型请求，工具网关按每次 MCP 工具调用。
在网关之前就被拒绝的请求不计入，例如 401、429、Host 不符。

Run 的 `toolCalls`/`toolFailures` 来自工具网关审计。只统计到达鉴权的调用，结果不是 `SUCCEEDED` 的都算失败。

## 安全

- **不显示内容与身份**：记录器只接收状态、计数、计时和固定错误码。事件里没有提示词、回答、工具参数或结果、凭据、
  用户 ID、租户 ID。错误码只接受“字母数字下划线 + 可选 `:HTTP 状态`”，其余显示为 `INVALID`；
  网关异常只取其错误码，不取消息。Broker status 只挑表中列出的数值和标识字段。
  Run 标识默认是短哈希；原始 Run ID 只在内存中作为执行中 Run 的查找键，不会出现在输出里。
- **只读**：没有任何写操作或控制入口；不支持跨域访问（不发 CORS 头）。
- **访问控制**：默认只监听 `127.0.0.1`。令牌比较先各自做 SHA-256 再常量时间比较。
  Host 头只接受 IP 字面量、`localhost` 和 `SANDLANE_STATUS_HOSTS`，用来防 DNS rebinding。
  面板是明文 HTTP：跨机器访问请放在 TLS 反向代理之后并设置令牌。带令牌的地址不要外传（页面设置了 `no-referrer`）。
- **响应头**：
  - `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`，以及 COOP/CORP。
  - HTML 的 CSP 为 `default-src 'none'`。内联脚本和样式只凭每次请求随机生成的 nonce 执行，`connect-src 'self'`。
  - 页面只用文本节点渲染数据，不拼接 HTML。
- **开销**：每个事件 O(1) 更新内存计数；已结束 Run 放在固定大小的环形缓冲；记录失败不影响执行。
  面板请求是独立的 HTTP 处理，Broker status 有缓存和超时，不阻塞 lane。

## 已知限制

- 只反映本进程；多个 Worker 需要分别查看。
- `version` 取 package.json 版本，不含构建提交号。
- 网关计数从进程启动开始累计，不分时间窗。
