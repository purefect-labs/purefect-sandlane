<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  Claude Code 作为第二种 Harness 的配置、运行方式与合规提示。
-->

# Claude Code 支持

SandLane 可以用 Anthropic Claude Code CLI（实测版本 2.1.301）代替 Codex 执行 Run。控制面在租约中用
`run.harness = "claude-code"` 选择它，`credentials.model_service.wire_api` 须为 `anthropic-messages`。
内核、控制面契约、沙箱和工具网关不变；新增的是 Claude Code Driver、模型网关的 Anthropic Messages 入口和 CLI 镜像。

## 合规提示（部署方负责）

- Claude Code 不是开源软件，使用受 Anthropic [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
  及 Claude Code 法律与合规说明约束。SandLane 只提供驱动能力，不分发 Claude Code，镜像由部署方自行构建。
- 允许：企业用自己的 Anthropic API key（或 Bedrock / Vertex / Foundry 凭据）为本企业的授权用户运行，用量计入 key 的所有者。
- 不允许：以 SaaS 形式用平台方的 key 为其他租户的用户提供 Claude Code（代付、转售或中介用量）。多租户部署须由每个租户自带 key（BYOK），或另与 Anthropic 签约。
- 经第三方中转访问模型是否属于合规的推理提供方，须部署方自行确认。
- 不得修改 Claude Code 二进制，不得以 Claude Code 的名称或标识作为产品品牌。

## 运行方式

- 每个 Run 一个 `claude -p` 进程（stream-json 双向流，`sessionPolicy: ephemeral`）。参数由
  `src/harness/claude-code/claude-code-launcher.ts` 生成，Broker 只按镜像映射启动、不理解 CLI：
  `--input-format stream-json --output-format stream-json --verbose --include-partial-messages --restricted
  --tools WebSearch --strict-mcp-config --mcp-config <工具网关> --permission-mode dontAsk
  --allowedTools WebSearch,<本 Run 的工具> --no-session-persistence --model <别名>`。
  - 不用 `--bare`（2026-10-16 起）：它把内置工具限制为 Bash/Edit/Read，WebSearch 不可用（实测）。改由 `--restricted`
    忽略用户、项目、本地设置文件（含 hooks），`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
    关闭 CLAUDE.md 与 auto-memory；print 模式下设置了 `ANTHROPIC_API_KEY` 时 CLI 用它以 `x-api-key` 发送本 Run 的模型
    capability（init 的 `apiKeySource` 为 `ANTHROPIC_API_KEY`），实测无网关以外的连接。
  - `--tools WebSearch` 只保留联网搜索（由模型网关按 Run 的联网策略保留、收窄或移除，见 [联网访问](./web-access.md)）。
  - `dontAsk` 拒绝一切未显式允许的工具，`--allowedTools` 列出 `WebSearch` 与本 Run 启用的 MCP 工具（`mcp__<server>__<tool>`）。
- 环境变量：`ANTHROPIC_BASE_URL`（模型网关 origin，不带 `/v1`）、`ANTHROPIC_API_KEY`（模型 capability）、
  `SANDLANE_TOOL_CAPABILITY`（MCP 头 `Authorization: Bearer ${SANDLANE_TOOL_CAPABILITY}` 由 CLI 展开，不进 argv）、
  `CLAUDE_CONFIG_DIR=/home/runner/.claude`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（同时关闭遥测、错误上报和更新检查）、
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`、`CLAUDE_CODE_ATTRIBUTION_HEADER=0`、`CLAUDE_CODE_MAX_RETRIES=2`。Broker 另设 `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE`
  指向系统证书包，原生二进制认 `NODE_EXTRA_CA_CERTS`（已实测）。
- Driver 先经 stdin 发 `initialize`（有 ContextProvider 指令时作为 `systemPrompt`，替换内置提示）和
  `apply_flag_settings{effortLevel}`（租约 `reasoning_effort`，缺省 `SANDLANE_REASONING_EFFORT`），然后等待 `beforeTurn`
  （Engine 确认 started）再写首条用户消息；历史与页面上下文与 Codex 一样在 prompt 信封中。
- 事件映射：`stream_event` 的 `text_delta` → `message.delta`；`assistant` 中的 `tool_use` / `user` 中的 `tool_result` →
  `item.started` / `item.completed`（与 Codex 相同的脱敏摘要；`WebSearch` 为 `webSearch` 摘要）；`result` →
  `run.completed` / `run.failed`（含 usage）。`system/init` 中 MCP 服务未连上、出现 `WebSearch` 以外的内置工具或权限模式
  不是 `dontAsk` 时 Run 立即失败。子代理（`parent_tool_use_id`）的输出不上报。
- 取消：stdin 写 `control_request{subtype:"interrupt"}`，等待中断结果（最多 5 秒）后停止进程。
- 页面动作与其他工具一样经 MCP 提供（`mcp__purefect__workspace_action`，本轮提供时才在 `--allowedTools` 中）；
  `MCP_TOOL_TIMEOUT=70000` 让 CLI 等得比网关的 55 秒上限更久（2.1.301 实测生效）。见 [工具与页面动作](./tools-and-page-actions.md)。

## 模型网关 Messages 入口

- `POST /v1/messages`（及 `?beta=true`）；`count_tokens` 等其他路径返回 404（CLI 退化为本地估算）。
  鉴权为本 Run 的模型 capability，`Authorization: Bearer` 或 `x-api-key` 均可（同时出现须一致）；
  capability 只能用于其 Run 协议的入口（Codex Run 不能调用 Messages，反之亦然）。
- 校验：`model` 必须是部署别名（换成租约中的模型）；`stream` 必须为 true；`max_tokens` 超过
  `SANDLANE_MODEL_MAX_OUTPUT_TOKENS` 时降到上限；`tools` 只能是函数清单中的客户端工具，外加按 Run 联网策略处理的
  服务端 `web_search_*`（见 [联网访问](./web-access.md)；code execution、web fetch 等其他服务端工具和 `mcp_servers`、
  `container` 字段一律拒绝），历史中的 `tool_use` 也须在清单内；带 `source` 的块（图片、文档等，包括 `tool_result`
  内嵌的）只在文件模式接受，且只收内联的 base64 图片与 PDF、纯文本文档，`url`、`file` 等远程来源一律拒绝（见
  [配置参考](./configuration.md)“文件模式”）。其余字段（thinking、output_config、
  context_management、cache_control、metadata 等）及 `anthropic-version`、`anthropic-beta` 头原样透传；CLI 的鉴权头不透传。
- 上游鉴权：租约的 key，按 `SANDLANE_MODEL_MESSAGES_AUTH` 发送：`x-api-key`（默认，Anthropic 官方）、`bearer`
  或 `both`（中转站不确定时使用）。
- 流式：逐事件转发（含 `ping`），不缓冲；与 Responses 入口相同，可能是凭据前缀的文本暂缓、出现第一个工具调用后
  其余事件等记账完成再发，`message_stop` 总在记账之后。用量取自 `message_start`（输入 = 非缓存 + 缓存写 + 缓存读）
  与 `message_delta`（输出）。上游 HTTP 错误（状态、JSON 错误体、`retry-after`）与流中 `error` 事件原样交给 CLI，
  以便它按自身逻辑重试或报错；含凭据或非 JSON 的错误体换成通用错误体。

## 配置

- Broker：`SANDLANE_BROKER_RUN_IMAGES` 加入 `"claude-code":"<镜像>@sha256:<digest>"`。没有配置镜像的 harness 会被拒绝，
  Run 以 `harness_unavailable` 结算。
- Worker：无需新增必填变量；`SANDLANE_MODEL_MESSAGES_AUTH` 按上游选择；`SANDLANE_MODEL_FUNCTION_INVENTORY`（可选）
  为按 harness 的 JSON 对象。
- Engine：执行档案 `harness: claude-code`，连接器 `wire_api: anthropic-messages`，可单独配置队列 lane。

## 镜像

```bash
docker build -f Dockerfile.cli-claude \
  --build-arg NODE_IMAGE=node@sha256:<digest> \
  --build-arg CLAUDE_CODE_VERSION=2.1.301 \
  -t <registry>/native-claude-code:2.1.301 .
```

镜像只安装对应平台的原生包（`@anthropic-ai/claude-code-linux-<arch>`，不运行任何安装脚本），构建时用 `claude --version`
确认是可执行的二进制而非占位脚本。只读根文件系统、uid 1000 下运行，只需 `/tmp` 与 `CLAUDE_CONFIG_DIR` 可写（Broker 均以 tmpfs 提供）。
镜像同时预装 python3 与固定版本的文档库（pypdf、pdfplumber、openpyxl、pandas、python-pptx、python-docx、matplotlib），
供带会话文件的 Run（文件模式）使用，构建时需要联网；详见 [配置参考](./configuration.md) 的“文件模式”与“镜像里的文档工具”。
网关使用自签证书时，与 Codex 一样在其上构建 `Dockerfile.cli-ca`。
