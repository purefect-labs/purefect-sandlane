<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
-->

# 独立运行 Demo

Demo 独立运行，不依赖 Purefect Engine、PurefectClient 或其他仓库。按目的选择：

| 想做什么 | 入口 | 是否需要模型 Key |
| --- | --- | --- |
| 检查 Docker 执行链路 | `npm run demo` | 不需要，使用模拟模型和 CLI |
| 输入问题，让真实模型回答 | `npm run demo:chat -- ...` | 需要，还需真实 CLI 镜像 |
| 从文件读取问题，真实执行一次 | `npm run demo -- --real ...` | 需要，还需真实 CLI 镜像 |

首次体验推荐先跑通免 Key 模式，再按下文配置真实问答。所有入口均为终端程序，没有浏览器聊天页面。

- [配置并启动真实问答](#交互式真实模型问答)
- [切换模型和服务商](#切换模型和服务商)
- [切换 CLI](#切换-cli)
- [参数速查](#参数速查)
- [常见问题](#常见问题)

## 环境与运行

需要 Node.js 20+、npm、OpenSSL、Docker Engine **28+** 和 Docker Compose。
macOS 可使用 Docker Desktop 的 Linux 容器。启动时需要下载 Node 基础镜像、registry 镜像及 npm 依赖。

```bash
npm ci
npm run demo
```

成功输出包括：

```text
"state":"SUCCEEDED","toolCalls":1,"modelRequests":2
[demo] PASS: execution verified; demo containers, networks and volumes removed
```

控制面提交 → lane 领取 → Broker 创建沙箱 → fixture 请求模型 → 调用 `demo_echo` →
模型核对工具返回的随机值 → 事件回传 → complete → 清理。脚本断言最终答案包含模型桩产生的随机值。

其他故障场景：

```bash
npm run demo -- --scenario=cancel
npm run demo -- --scenario=lease-loss
```

分别要求 CANCELLED 和 FAILED/lease_lost，并检查停止与资源清理。命令行中断会停止本次 execution。
不要用旧的 `npm start`、8787 API 或旧 acceptance 命令；这些入口已删除。

## 交互式真实模型问答

下面以 **DeepSeek + Claude Code** 为例。在仓库根目录、同一个终端中依次执行。
命令适用于 macOS / Linux 的 zsh 或 bash；不需要修改 `.env` 或 Purefect 平台配置。

### 1. 准备 Key 文件

用文本编辑器在仓库外创建私有文件，例如 `~/.config/sandlane/deepseek.key`，内容只有 API Key。
不要把 Key 明文写进命令、聊天记录或 Git。文件应归当前用户所有，然后设置路径和权限：

```bash
DEMO_KEY_FILE="$HOME/.config/sandlane/deepseek.key"
chmod 600 "$DEMO_KEY_FILE"
```

已有文件则直接复用，不要覆盖它。文件不能是符号链接。`--key-file` 需要绝对路径；上面的变量会展开为绝对路径。

### 2. 准备 CLI 镜像

本仓库提供 Dockerfile，不要求宿主机安装或登录 Claude Code。
以下是已验证版本示例，不代表最新版本；首次构建需下载 CLI 和依赖：

```bash
docker build -f deploy/Dockerfile.cli-claude \
  --build-arg CLAUDE_CODE_VERSION=2.1.301 \
  -t sandlane/demo-claude:2.1.301 .

DEMO_IMAGE_ID=$(docker image inspect \
  sandlane/demo-claude:2.1.301 --format '{{.Id}}')
DEMO_IMAGE="sandlane/demo-claude@$DEMO_IMAGE_ID"
```

这里由 Docker 自动读取本地镜像 ID，避免手抄长 digest 被复制断行。Demo 支持核验本地镜像 ID，
并为派生镜像生成真正的 RepoDigest；这不是可供其他机器拉取的仓库 digest。
若使用已有镜像，可以跳过构建，将 `docker image inspect` 的目标换成该镜像的本地标签。
若镜像来自私有仓库，先自行登录并拉取，再把 `DEMO_IMAGE` 设置为已拉取的 `repo@sha256:...`。

### 3. 配置模型并启动

```bash
DEMO_HARNESS=claude-code
DEMO_ORIGIN=https://api.deepseek.com/anthropic
DEMO_MODEL=deepseek-flash
DEMO_AUTH=x-api-key

npm run demo:chat -- \
  --harness="$DEMO_HARNESS" \
  --image="$DEMO_IMAGE" \
  --model-origin="$DEMO_ORIGIN" \
  --model="$DEMO_MODEL" \
  --messages-auth="$DEMO_AUTH" \
  --key-file="$DEMO_KEY_FILE"
```

这些变量只作用于当前终端，重新打开终端需重新设置；切换配置后重新执行上述启动命令。
此模式不会退回模拟回答，也不会读取个人 CLI 登录态。第一次可输入：

> 用一句话解释什么是沙箱，不调用工具。

想体验 MCP 工具调用，可输入：

> 调用 demo_echo，nonce 使用 hello，然后说明返回结果。

看到 `你 >` 后输入一行问题。回答后显示 CLI 名称、镜像标签声明的 CLI 版本、配置的模型标识、
MCP 工具调用次数、每题启动/执行/清理的总耗时，以及运行时报告的 Token 用量（若有）。镜像准备耗时单独显示。
模型标识可能是服务商别名，不代表已核实底层权重版本；CLI 镜像未标注版本时显示未知。
费用以服务商账单为准，不根据 Token 猜测余额。

输入 `/exit` 退出，Ctrl+C 会请求停止并等待清理。最多连续输入 16 题，每题上限 16 KiB。
当前是**连续单题问答，不是带历史的多轮会话**：进入输入提示前先准备一次runtime、relay和带临时CA的CLI镜像，
同一次聊天复用固定镜像及TLS材料（最长12小时），后续问题不再构建或推送镜像。
每题仍独立创建并清理容器、网络、卷及Run凭据，不共享会话历史；退出聊天删除临时TLS材料。
镜像准备阶段不调用模型，不消耗模型额度。每题仍有容器启动开销，答案完整生成后显示，暂不逐字流式展示。
重新启动demo:chat会重新检查/构建，使用Docker层缓存及npm下载缓存，不跨聊天跳过源码更新。
每次提交都会真实消费模型额度；失败时停止，不由交互脚本自动重试（CLI 自身可能重试请求）。
仅提供无业务副作用的 `demo_echo` 工具，不开放业务系统、文件模式或联网搜索。

## 切换模型和服务商

先输入 `/exit` 退出，修改下面相应变量，再执行前面的 `npm run demo:chat` 启动命令。
输入问题时提到“换模型”不会改变实际配置。

| 切换内容 | 修改哪些配置 |
| --- | --- |
| 同服务商、同协议的另一型号 | `DEMO_MODEL`，填写账户有权使用的真实模型 ID |
| 换另一个账户的 Key | `DEMO_KEY_FILE`，新文件也需 `chmod 600` |
| 换服务商 | `DEMO_ORIGIN`、`DEMO_MODEL`、`DEMO_KEY_FILE`；Messages 还需核对 `DEMO_AUTH` |
| 换 CLI | `DEMO_HARNESS`、`DEMO_IMAGE`，并切换匹配协议的 `DEMO_ORIGIN` |

Claude Code 使用 Anthropic Messages；Codex、Qwen Code 和 OpenCode 使用 Responses。只有 Chat
Completions 兼容接口不能直接接入。
例如 Claude Code 接智谱时，地址按服务商文档设置为 `https://open.bigmodel.cn/api/anthropic`，
模型 ID 和 Key 换成对应账户的配置。需要 Bearer 的 Messages 服务使用 `DEMO_AUTH=bearer`。
不要把网页聊天地址作为 API 地址。

DeepSeek 已通过 Codex、Claude Code、Qwen Code 和 OpenCode 四种内置 CLI 的真实验证；智谱、Qwen
模型服务尚未实测；Kimi、Gemini 等的专用适配器未内置。
更多端点、套餐限制和扩展方式见[模型接入指南](./model-providers.md)。

## 切换 CLI

例如保留 DeepSeek，切换为 **Codex**。退出当前问答，在同一终端执行：

```bash
docker build -f deploy/Dockerfile.cli \
  --build-arg CODEX_VERSION=0.154.0 \
  -t sandlane/demo-codex:0.154.0 .

DEMO_IMAGE_ID=$(docker image inspect \
  sandlane/demo-codex:0.154.0 --format '{{.Id}}')
DEMO_IMAGE="sandlane/demo-codex@$DEMO_IMAGE_ID"
DEMO_HARNESS=codex
DEMO_ORIGIN=https://api.deepseek.com/responses
```

保留 DeepSeek 的 `DEMO_MODEL` 和 `DEMO_KEY_FILE`，再执行前面的启动命令。
`DEMO_AUTH` 仅影响 Messages，对三个 Responses Harness 无效。
切回 Claude Code 时恢复其镜像、`DEMO_HARNESS=claude-code` 和 `/anthropic` 地址。
Qwen Code 与 OpenCode 使用同一 Responses 地址；分别用下面命令构建镜像后，把 `DEMO_IMAGE` 和
`DEMO_HARNESS` 成对切换：

```bash
docker build -f deploy/Dockerfile.cli-qwen -t sandlane/demo-qwen:0.26.3 .
docker build -f deploy/Dockerfile.cli-opencode -t sandlane/demo-opencode:1.19.5 .

# 二选一，再按第 2 节的方法用 docker image inspect 生成固定的 DEMO_IMAGE。
DEMO_HARNESS=qwen-code
# DEMO_HARNESS=opencode
DEMO_ORIGIN=https://api.deepseek.com/responses
```

不能仅改 CLI 名称却继续使用另一种 CLI 的镜像。Qwen Code 0.26.3 与 OpenCode 1.19.5 已在
linux/arm64 上通过 DeepSeek `deepseek-flash` 的单次文本 + MCP 冒烟；其他模型、架构和镜像 digest
仍应以低额度、无副作用问题单独验证。

## 参数速查

| 参数 | 含义 | 示例 / 默认值 |
| --- | --- | --- |
| `--harness` | 真实 CLI 类型，必填 | `codex`、`claude-code`、`qwen-code` 或 `opencode` |
| `--image` | 本地已存在的固定镜像，必填 | `"$DEMO_IMAGE"`，不接受浮动 tag |
| `--model-origin` | 上游 HTTPS API 地址，必填 | DeepSeek Messages 用 `/anthropic`，Responses 用 `/responses` |
| `--model` | 模型 ID，必填 | `deepseek-flash`，以账户可用型号为准 |
| `--key-file` | 私有 Key 文件绝对路径，必填 | `"$DEMO_KEY_FILE"` |
| `--messages-auth` | Messages 认证方式，可选 | 默认 `x-api-key`；另支持 `bearer`、`both` |
| `--prompt-file` | 单次真实模式的问题文件 | 仅用于 `npm run demo -- --real`，不用在 `demo:chat` 中 |

帮助：`npm run demo:chat -- --help`。参数使用 `--名称=值` 写法；每行末尾的 `\` 后不要加空格。

## 真实 Agent CLI 单次运行（可选）

同一个独立控制面可使用四种内置 Harness。需要自行准备合法使用、按 digest 固定的
CLI 镜像、HTTPS 模型服务及 API key。镜像须符合仓库 launcher 的路径、用户和协议要求。
脚本会派生一个仅增加本次网关 CA 的镜像，不读取个人 CLI 登录态。
原始 CLI 镜像须先拉取到本地。脚本核验固定 digest 后为本次构建添加本地标签，避免 BuildKit
再次从远程解析私有镜像；派生镜像通过本次临时 registry 取得 RepoDigest。Demo 使用独立 CA 签发
`CA:FALSE` 的网关服务端证书，不能用 CA 证书本身充当服务端证书（部分 CLI 的 TLS 实现会拒绝）。

先完成上面的变量配置，再用编辑器创建问题文件，将下方 `/absolute/path/prompt.txt` 换成其实际绝对路径：

```bash
npm run demo -- --real \
  --harness="$DEMO_HARNESS" \
  --image="$DEMO_IMAGE" \
  --model-origin="$DEMO_ORIGIN" \
  --model="$DEMO_MODEL" \
  --messages-auth="$DEMO_AUTH" \
  --key-file="$DEMO_KEY_FILE" \
  --prompt-file=/absolute/path/prompt.txt
```

Codex、Qwen Code、OpenCode 使用 Responses 上游；Claude Code 使用 Anthropic Messages 上游。
示例 prompt 可写：“调用 demo_echo，nonce 使用 hello，并说明结果。”工具没有业务副作用。
真实模式会消费模型额度；缺少配置会失败，不会自动读取其他凭据或切换为 fixture。

## 常见问题

| 现象 | 如何处理 |
| --- | --- |
| `command not found: code@sha256...` 或 digest 后半段 | 命令被实际换行拆断；使用上面的镜像变量，不手工粘贴长 digest |
| `配置不完整或参数无效` | 检查变量是否在同一终端设置、参数是否使用 `=`、镜像是否固定到 digest |
| `交互 Demo 启动失败` | 检查 Docker 已启动、Key 文件存在且归当前用户所有并为 600、镜像已在本地、地址为 HTTPS |
| 构建较慢 | 输入问题前显示构建阶段，每10秒报告等待时长；单次构建超时5分钟。停在npm依赖阶段时检查Docker容器内网络（与宿主机npm网络可能不同）；详细日志见Docker Desktop Builds。依赖使用下载缓存，并关闭构建时的audit/fund请求 |
| 启动后模型调用失败 | 核对余额、模型权限、协议、地址和 Messages 认证方式；失败不等于未计费，CLI 可能已发起请求 |
| 没有网页，或答案没有逐字出现 | 当前是终端交互、完整答案输出，不是 Web UI 或流式聊天 |
| 下一题不记得上一题 | 当前每题独立，不携带会话历史 |
| 出现 `Not passed` / 清理未确认 | 查看提示的诊断目录；保留 Broker 状态，不用手工清空账本掩盖残留 |

普通成功退出会清理本次容器、网络和卷，但保留构建镜像与缓存。不会修改现有 Purefect 部署或默认模型。

## 隔离、凭据与清理

- 每次运行使用唯一 Compose project、Broker nodeId、网络、卷和临时 CA，不连接现有 Purefect 部署。
- CLI 只有 Run 级模型/MCP capability；Provider key 由 Worker 读取，保存在可信进程内，不交给沙箱。
- 模型和 MCP 网关没有宿主机公开端口；Relay 固定路由到专属网络内的 Worker IP。
- 脚本在 Docker daemon 宿主的 loopback 上创建临时 registry，为本地派生镜像获取真实 RepoDigest；
  不要求 GHCR 写权限。registry 在 finally 中删除，Docker Desktop 的 daemon 位于 Linux VM。
- fixture 检查直连 Worker 网关被拒绝、错误用途 capability 被拒绝，并以正常 Relay 请求成功作为对照。
  这些检查不等于对所有网络攻击或敌对租户的完整安全认证。
- 正常退出删除本次容器、网络、卷和临时文件；本地构建镜像和缓存保留。
  清理未确认时命令失败并保留诊断目录，若 Broker 有残留则保留状态卷，不能手工清空账本来掩盖故障。

`deploy/compose.demo.yaml` 是完整拓扑模板；脚本负责选取不冲突的子网、生成证书、启动 Relay、检查不可变身份、
生成绑定 override，再启动 Broker 和 Worker。因此不要仅运行 `docker compose -f deploy/compose.demo.yaml up`。

## Demo 的范围

Demo 内置的 `demo_echo` 已走真实 MCP 网关，不需要额外安装。客户接入自己的 HTTP / stdio MCP，
请按 [MCP 安装与接入](./mcp.md) 在 Worker / 独立控制面配置；当前 `demo:chat` 没有外部 MCP 配置参数。

内存控制面只用于开发示例，默认并发 1、最多 16 个 Run、单 prompt 16 KiB，事件及答案也有限额。
它实现租约、offset 重放校验、幂等结算与取消竞态，进程退出后不恢复或重放任务。
它没有登录、持久队列、计费、HTTP 提交接口、业务审批、文件回传或生产授权系统。

纯 Node 单元测试不启动 Docker；公共 CI 的独立 Docker job 运行三个 fixture 场景，真实模型不进入无凭据 CI。

- 第三方接入：[managed runtime API](./standalone.md)
- 平台集成：[Purefect 参考集成](./integrations/purefect.md)
