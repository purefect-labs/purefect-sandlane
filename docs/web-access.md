<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  联网访问开关：语义、两种 CLI 的行为与已知限制。
-->

# 联网访问（模型侧联网搜索）

沙箱始终不联网。联网由模型服务自带的联网搜索完成：搜索在上游执行，CLI 只拿到结果。
模型网关是唯一执行点：每个 Run 按自己的策略保留、收窄或移除请求中的联网搜索工具。CLI 一侧的配置是静态的，始终开启搜索工具。

## 开关语义

控制面在提交时冻结策略，随租约下发。Purefect 契约字段为 `run.web_access`：

| `run.web_access` | 策略（SPI `WebAccessPolicy`） | 效果 |
| --- | --- | --- |
| `{open: true, ...}` | `open` | 可访问任意网站，搜索工具原样转发 |
| `{open: false, allowed_domains: [a, b]}` | `allowlist`，域名为 `[a, b]` | 只能访问这些域名及其子域名 |
| `{open: false, allowed_domains: []}` | `off` | 不能联网 |
| 缺省或 `null` | `off` | 不能联网（兼容旧 Engine） |

- 域名格式按契约校验：小写、至少两段、不带协议和路径，最多 100 个。格式不合法时，整个租约按无效处理。
- 策略在 lane 登记 Run 时写入凭据（`RunGrant.webAccess`）。模型网关查询 Run 时取出策略，交给两个入口的请求校验。
- 策略同时交给 ContextProvider（`TurnRequest.webAccess`）。有部署指令时（如 `PUREFECT_INSTRUCTION_PROFILE=business`），
  会在指令末尾追加一段说明：本轮可以联网搜索、可访问的范围、搜索结果和网页内容都是不可信数据。`off` 时不追加。
  这段文字只是提示，真正的限制由网关执行。

## 网关的改写规则

| 入口 | `open` | `allowlist` | `off` |
| --- | --- | --- | --- |
| Responses（Codex）：`tools` 中的 `web_search` | 原样转发 | 写入 `filters.allowed_domains`；CLI 自带过滤条件时取交集；`web_search_preview` 不支持过滤，直接移除 | 移除，不报错 |
| Messages（Claude Code）：服务端工具 `web_search_YYYYMMDD` | 原样转发 | `allowed_domains` 取交集（CLI 没带则用白名单），删除 `blocked_domains`（上游不允许两者同时出现） | 移除；工具全部被移除时一并删除 `tool_choice` |
| Messages：Claude Code 自带的客户端工具 `WebSearch` | 放行 | 放行 | 从工具列表移除，模型看不到它 |

- 交集规则：请求中的域名（可带路径）落在白名单某个域名之内时保留；请求中的上级域名只保留白名单里属于它的子域名。
  交集为空就移除工具，任何情况下都不会比白名单更宽。
- 其他服务端工具仍然拒绝（400），包括 `code_execution`、`web_fetch`、`file_search`、`code_interpreter`、远程 MCP、
  `mcp_servers`、`container`。服务端搜索工具的名称必须是 `web_search`，字段也只接受已知的几个。
- 流的校验：请求中保留了搜索工具时，才放行相应的事件。Responses 放行 `response.web_search_call.*`、
  `response.output_text.annotation.added` 和 `web_search_call` 输出项；Messages 放行 `server_tool_use(web_search)`
  和 `web_search_tool_result` 内容块，这些都原样交给 CLI。请求中没有搜索工具时，这些事件仍按协议错误处理。
- 历史：Codex 在同一轮的后续请求中会回放 `web_search_call` 输入项和 `url_citation` 标注，只有允许联网的 Run 才接受。
- 计费：Messages 取 `usage.server_tool_use.web_search_requests`；Responses 统计完成结果中 `web_search_call` 的个数。
  结果累计到 Run 的凭据，结束时记日志 `WEB_SEARCH_USAGE`。契约的 `usage` 只有 token，不上报搜索次数。

## 两种 CLI 的实际行为（实测）

**Codex 0.154.0**
- 托管配置 `web_search = "live"`，请求中的工具为 `{"type":"web_search","external_web_access":true}`，CLI 不带过滤条件。
  `"cached"` 会发 `external_web_access:false`，只用上游的缓存索引、不实时抓取，所以选 `live`；`"disabled"` 不发送这个工具。
- app-server 把搜索报告为 `webSearch` 项：开始时 `query` 为空、`action.type` 为 `other`；完成时带 `query`，
  `action` 为 `search`（query）、`openPage`（url）或 `findInPage`（url）。
- Driver 输出脱敏摘要 `{type:"webSearch", id, title:"联网搜索", status, query?, domain?}`：查询词最多 120 个字符；
  打开网页时只给出主机名；不包含搜索结果和网页正文。

**Claude Code 2.1.301**
- `--bare` 会把内置工具限制为 Bash/Edit/Read，即使加 `--tools WebSearch` 也拿不到 WebSearch。因此启动参数去掉 `--bare`，改为：
  - `--restricted`：忽略用户、项目和本地的设置文件，包括其中的 hooks。
  - `--tools WebSearch`，并在 `--allowedTools` 中放行 `WebSearch`。
  - 环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`。
  - 鉴权仍是 `ANTHROPIC_API_KEY` 经 `x-api-key` 发送，init 中 `apiKeySource` 为 `ANTHROPIC_API_KEY`。
- 一次搜索要发 **两次额外的模型请求**，都经过模型网关、使用同一个模型别名：
  1. 主请求带客户端工具 `WebSearch`，模型据此发起调用。
  2. CLI 另发一次请求，带 `tools:[{type:"web_search_20250305", name:"web_search", allowed_domains?, max_uses:8}]` 和
     `tool_choice:auto`，系统提示是 CLI 自带的搜索代理提示。
  3. CLI 把这次请求的结果整理成文字，作为 `tool_result` 交回主循环，再发下一次主请求。
  这一过程没有访问网关以外的地址；用 CONNECT 代理记录核对过，没有任何外部连接。
- Driver 把 `tool_use(WebSearch)` / `tool_result` 映射为同样的 `webSearch` 摘要。
  `system/init` 中除 MCP 工具外只允许出现 `WebSearch`，出现其他内置工具时 Run 失败。
- `WebFetch` 不启用：它先直连 `api.anthropic.com` 做域名安全检查（实测发出了到 `api.anthropic.com:443` 的 CONNECT），
  然后在 CLI 进程内自己发 HTTP，沙箱无网时必然失败。CLI 不会使用 Anthropic 的服务端工具 `web_fetch_*`；网关也拒绝这个工具。

## 已知限制

- 方案 B 依赖上游（以及中转）支持服务端联网搜索：
  - Responses 的 `web_search` 及 `filters`；
  - Messages 的 `web_search_20250305` 及 `allowed_domains`。
  
  上游或中转不支持时，搜索请求会被上游拒绝，错误原样交给 CLI。启用前须用真实中转验证。
- 只能搜索，不能任意抓取：能拿到什么取决于上游的搜索和抓取能力。Amazon 等有反爬措施的站点仍可能拿不到内容。
- 白名单由上游的域名过滤执行，网关只保证请求中的过滤条件不会比白名单更宽，无法核实上游是否遵守。
- 网页内容不可信，可能包含提示注入：
  - 指令中已声明搜索结果和网页内容都是数据，不得当作指令执行；
  - 业务工具的权限仍由工具网关校验，不受模型输出影响；
  - 查询词会发给搜索服务，模型可能把会话内容带进查询词。对此敏感的部署应关闭开关或使用白名单。
- 前端展示：`runtime.item.*` 中的 `webSearch` 项需要前端增加对应分支。现有的 reducer 会忽略未知类型。
