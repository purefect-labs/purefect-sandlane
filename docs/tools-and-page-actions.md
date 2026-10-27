# 工具与页面动作

2026-10-16 起，工具与页面动作**默认全部开放**。数据权限不在 Worker 判断：平台调用一律使用执行人
（Run 发起人）的短期令牌，平台按该用户本人的权限决定允许什么；Engine 另外禁止这类令牌调用
`pf.ai.*` / `sys.ai.*`（防递归）。Worker 只负责鉴权到 Run、并发、超时、大小上限和审计。

## 工具清单

所有工具都由工具网关（MCP Streamable HTTP，TLS）提供，CLI 以同一个 MCP 服务注册（服务名
`purefect`）。模型侧名字按各 CLI 的 MCP 命名：Codex 为命名空间 `mcp__purefect` 下的函数
（网关函数清单写作 `mcp__purefect.<tool>`），Claude Code 为 `mcp__purefect__<tool>`。

| 工具 | 只读 | 说明 |
| --- | --- | --- |
| `purefect_call` | 否 | 调用任意平台 API：`api_code`（`{domain}::{method}`）、`params`（对象，≤32 KB）、可选 `site`（同租户另一站点，由平台校验）。以 managed 模式的 purefect-client、执行人令牌调用，不重试、不刷新令牌。描述沿用 purefect-client MCP（含 `MetaManager::replace` 全量替换铁律） |
| `list_api_docs` | 是 | 列出 purefect-client `apis/` 下的 Markdown 文档，可按模块过滤 |
| `read_api_doc` | 是 | 分页读取一篇文档（`start_line`、`line_count` ≤500） |
| `workspace_action` | 否 | 页面动作（见下文）；只在本轮提供时出现 |
| `propose_task` | 否 | 会话内委派：把事情交给本条消息 @ 的成员（见下文）；只在对话类 Run、有提及成员时出现 |
| `report_task` | 否 | 任务类 Run 向派单人回报结果（见下文）；只在任务类 Run 出现 |

原 `metadata.get_raw` / `metadata.get_meta` 已删除：`purefect_call` 调
`pf.designer.meta.MetaManager::get_raw` / `get_meta` 完全覆盖。

文档工具的边界：文档根目录取 `PUREFECT_CLIENT_MODULE` 所在模块的 `../apis`（即 purefect-client 的
`apis/`），启动时解析真实路径，缺失则启动失败。只读 `.md` 文件；路径解析符号链接后必须仍在根目录内
（`..`、绝对路径、指向外部的链接都拒绝）；单文件 ≤1 MiB；每次返回 ≤48 KB，超出时提示从哪一行继续。

失败反馈：参数不符合 schema 时返回 “Invalid arguments…”；平台明确拒绝或失败时返回错误码
（`PLATFORM_API_FAILED`、`PLATFORM_HTTP_REJECTED`、`API_CODE_REJECTED`、`REQUEST_TOO_LARGE`、`TOKEN_EXPIRED`；
未获用户确认时为 `CONFIRMATION_REJECTED` / `CONFIRMATION_TIMEOUT` / `CONFIRMATION_UNAVAILABLE`，见“审批桥接”），
传输超时等结果不确定时返回 “outcome is unknown” 并要求不要自动重试。只传错误码，不传依赖的错误正文、URL 或凭据。
managed 模式的 purefect-client 不透出平台 fault 码，所以模型只能看到 `PLATFORM_API_FAILED` 这一级。
结果超过 64 KB 时调用照常记为成功，返回 `{result_omitted:"TOOL_RESULT_TOO_LARGE", bytes, limit, hint}`，
让模型缩小查询范围。

## 页面动作（workspace_action）

链路对两种 CLI 相同：CLI 经 MCP 调用 → 工具网关按 Run 的工具 capability 找到该 Run → 该 Run 的
lane 把请求放进下一次 sync 的 `action_requests` → Engine 转给认领的浏览器 → lane 以
`awaiting_actions` + `wait_ms` 长轮询回执 → 校验回执后作为工具结果返回。原 Codex app-server
dynamic tool 路径已删除（Codex Driver 不再声明 `experimentalApi`、不注册 `dynamicTools`，
`item/tool/call` 反向请求一律回错误）。

- **是否提供**：由 ControlPlane 的 `clientActions.offer()` 按本轮 prompt 信封判断：`ui_context`
  的协议为 `purefect-workspace-interaction/1`、`interaction === 1`、`surface` 不是 `mobile`，且有可用操作。
  未提供时 tools/list 里没有该工具，调用被拒绝；CLI 配置（Codex `enabled_tools`、Claude
  `--allowedTools`）也只在提供时列出它。
- **绑定到 Run**：动作只能由发起它的 Run 调用（按 Run 的工具 capability 找到绑定，闭包指向该 Run 的
  lane）；Run 结束即撤销 capability。动作名不能与网关工具重名。
- **可用操作**：协议全部操作（open/close/describe/focus/query/read/create/patch/invoke）∩ 本轮
  `ui_context.operations`。浏览器只声明自己能执行的操作，且已与 Engine 能力
  （`purefect.ai.run.workspace-operations`，默认全部 9 种）取交集；Engine 在 sync 时也再校验一次。
  工具 schema 的 `op` 枚举、属性和描述都按本轮操作生成。
- **参数校验**（文档 50 §3）：每种操作只接受自己的参数及必需组合（如 close 的 `targets` 与
  `createdBy:"task"` 二选一，read 的 `row` 与 `rowSet` 互斥，create 的整页草稿与子表追加二选一），
  总大小 ≤64 KiB、嵌套 ≤8 层、字段 ≤20、行数 ≤100、`limit` ≤50、`pageSize` ≤200。不通过时不发给浏览器，
  直接回 `failed/invalid_argument` 回执并附原因，模型可据此改正。浏览器执行器仍做最终校验。
- **顺序与上限**：同一 Run 的动作按调用顺序逐个执行（同时排队 ≤4 个，每个 Run ≤64 次）。
- **超时**：每个动作（含排队）最多等 45 秒（lane 选项 `clientActionTimeoutMs`，上限 55 秒），到时回
  `failed/timeout`。MCP 请求对动作单独放宽到 58 秒；Codex `tool_timeout_sec=70`、Claude Code
  `MCP_TOOL_TIMEOUT=70000`（两者已实测生效）。上限受 relay 的连接空闲超时（60 秒）约束，要更长须先调 relay。
- **回执**：浏览器回执经 Engine 校验后，Worker 再校验形状（≤32 KiB、`actionId` 一致、状态与错误码合法）；
  `VOID`、取消、租约丢失都转为 `failed/unavailable`。

## 审批桥接（敏感操作由用户确认）

运维在 Engine 配置 `purefect.ai.run.confirm-api-codes`（接口编码，`*` 通配，默认空），提交时冻结，租约下发
`run.confirm_api_codes`（缺省、`null`、空列表都按空处理）。清单为空时 Worker 不登记确认通道，也不调用插件的匹配逻辑，
所有调用照常直接执行。

- **谁需要确认**：Purefect 插件判断。`purefect_call` 的 `api_code` 与任一模式**整串**匹配（大小写敏感，`*` 匹配任意
  字符串，`.` 是普通字符）即需要确认，如 `*::delete`、`pf.designer.meta.MetaManager::*`。
  嵌套调用（`Domain::成员::服务`）与 `子Domain::服务` 指向同一服务，Worker 无法确定是哪个子 Domain，因此保守匹配：
  除按调用原样比较外，还用模式中最后一个 `::` 之后的服务名比较调用的服务名，例如 `pf.x.MailManager::delete` 同样拦住
  `pf.basis.user.UserDomain::mail::delete`。宁可多问也不能被绕过。仍无法识别的别名：Domain 以**不同的成员名**引用同一服务
  （例如 `UserDomain::fetchMyPermissionList` → `sys.auth.getAcl`），需要把调用者实际使用的编码也写进清单。
- **等待不占并发名额**：等待用户确认期间，该调用让出工具网关的全局并发名额，同一 Run 或其他 Run 的调用照常执行；
  允许后恢复执行（等待中的调用数以同时等待确认的 Run 数为上限）。
- **何时问**：工具网关在保留调用、校验参数之后、读取执行人令牌之前询问。未获允许时不读令牌、不派发、不调用平台；
  审计记 `FAILED` 和下列错误码。等待确认的时间不计入单次调用的 30 秒；允许后重新计时。
- **怎么问**：经 lane 的客户端动作通道（与 `workspace_action` 同一 sync 上报、长轮询回执机制和串行队列）发一个动作：
  `op: "confirm"`，`arguments: { kind: "tool_call", tool, title, summary }`。
  - `tool` 由网关填写（工具名）。`title` 为接口编码（单行，≤200 字）。
  - `summary` 为纯文本（≤1024 字），按行给出 `api_code`、`site`（如有）和 `params`：最多 20 个顶层字段，字符串截断到
    48 字，嵌套值只给数量（`{3 fields}` / `[5 items]`）。名称像凭据的字段（password、token、secret、auth、key、
    cookie、session 等）和形如 JWT / `Bearer` 的值显示为 `***`。执行人令牌不在工具参数中，不会出现。
  - `confirm` 不属于页面操作，Engine 不按 `workspace-operations` 限制，也不要求本轮提供 `workspace_action`
    （移动端、没有页面操作、`SANDLANE_ENABLED_TOOLS` 去掉页面工具时同样可以确认）。
- **回执与判定**（只有第一种允许执行）：

  | 浏览器回执 | 判定 | 模型看到的错误码 |
  | --- | --- | --- |
  | `{status:"succeeded", result:{approved:true}}` | 允许 | — |
  | `{status:"failed", error:{code:"rejected"}}`（拒绝、关闭、卸载、认领撤销），`cancelled`，`succeeded` 但 `approved` 不为 `true` | 拒绝 | `CONFIRMATION_REJECTED` |
  | 无回执至超时（无人点击或没有窗口认领），`failed/timeout` | 超时 | `CONFIRMATION_TIMEOUT` |
  | `{status:"failed", error:{code:"unavailable"}}`、其他失败、`VOID`、形状不合法、队列满 | 不可用 | `CONFIRMATION_UNAVAILABLE` |
  | 本轮不是工作台在交互协议（`purefect-workspace-interaction/1`）下提交的（如经 API 直接提交）：不发送，立即判定 | 不可用 | `CONFIRMATION_UNAVAILABLE` |
  | 任务类 Run（无人在线，见“任务类 Run 的工具差异”）：不发送，立即判定 | 无人确认 | `CONFIRMATION_UNATTENDED` |

- **时限**：等待复用页面动作的上限（`clientActionTimeoutMs`，默认 45 秒，含排队）。Run 有确认清单时，MCP 对网关工具的
  请求也放宽到 58 秒（同页面动作），以免 relay 60 秒空闲超时切断连接。代价：用户在接近 45 秒时才允许，平台调用只剩
  约 10 秒（受 58 秒请求时限和令牌有效期约束），超时结果为 UNKNOWN。要更长须先调 relay 与 CLI 的工具超时。
- **模型侧文案**：三个错误码分别说明“用户拒绝了 / 未在时限内确认 / 当前无法请求确认，调用未执行”，并要求如实告诉用户、
  不说成权限问题；拒绝后除非用户要求不再重试。lane 日志记 `TOOL_CONFIRMATION`（run、tool、outcome），不记参数。

## 会话内委派（propose_task / report_task）

平台设计见 `purefect-docs/digital-employee/assignment-and-scheduled-tasks.md` §18.4。两个工具都是**控制面工具**
（SPI `ControlTool`）：和页面动作一样经工具网关以 MCP 提供、只对提供它的 Run 可见，调用由该 Run 的 lane 完成；
不同的是 lane 不转给浏览器，而是用 Worker 的 SERVICE 主体加租约证明调用 Engine。执行令牌禁止调用任务接口，所以不走
`purefect_call`。

- **是否提供**：按租约判断。`propose_task` 需要 `run.source.type = conversation` 且本条消息有提及（`run.input.mentions`）；
  `report_task` 需要 `run.source.type = task`；其他来源或旧 Engine（没有 `run.source`）两者都不提供。
  `SANDLANE_ENABLED_TOOLS` 去掉即不提供；租约 `run.tools` 不收窄它们。提供时 CLI 配置（Codex `enabled_tools`、
  Claude `--allowedTools`）与模型函数清单都包含它们（默认清单由启用的工具推导）。
- **propose_task**：
  - 参数：`assignee_member_id`（schema 枚举本条消息提及的成员 ID）、`title`（≤200）、`description`（可选，≤4000）、
    `due_at`（可选，`yyyy-MM-dd HH:mm` 或 13 位毫秒数；平台按服务器时区解释字符串）、`review_required`（可选）。
    Worker 先校验，不合格时直接回 “Invalid arguments, not dispatched: …”。
  - 调用 `ExecutionDomain::propose`，带 `request_id`（同一次工具调用重发不变，见 [执行内核](./control-plane.md)“会话内委派”）。
  - 结果：派给数字员工回 “Dispatched: … (task ID …)”；派给真人回 “Suggestion card created (proposal ID …) … Ask the user to confirm it on the card”。
    平台拒绝时按错误码回一句话（负责人不在提及里、发起人已不能访问、没有指派权限、负责人不能接活、附件无效、参数无效等；
    文字里不带错误码），以 MCP `isError` 返回，Run 照常继续；其他平台错误回 “… failed temporarily. You may try once more later”；
    网络或超时重发两次仍无结果时回 “Outcome unknown … Do not automatically retry”。
  - 每个 Run 最多派出 5 个任务（含待确认的建议），超出回 “Not dispatched: one reply may hand out at most 5 tasks …”，不调用平台；
    同一 Run 的调用逐个执行。
  - 描述告诉模型：只在用户明确要求把事情交给被 @ 的人去做时用；派给数字员工会立即执行，派给真人先给用户一张确认卡片。
  - **定时 / 周期任务**（平台 4e，develop 531b179）：只在用户明确要求将来某个时间或周期执行（“明天 9 点”“每天”“每周一”“每月 1 号”）时填时间规则，否则一律不填（任务立即开始）。
    - 参数：`trigger_type`（`once` / `recurring`）；`once` 用 `run_at`（`yyyy-MM-dd HH:mm` 或 13 位毫秒数）；`recurring` 用 `repeat_rule`：
      `daily`、`weekdays`（周一至周五）、`weekly`（配 `weekdays`，1–7 逗号分隔，1=周一）、`monthly`（配 `month_days`，1–31），这四种都配
      `time_of_day`（`HH:mm`）；都不合适时才用 `cron`（5 段，或秒在前的 6 段）。可选 `timezone`（IANA，缺省 Asia/Shanghai）、
      周期任务可选 `end_at`、`max_runs`。不支持比 15 分钟更频繁。
    - Worker 先做与平台 `TaskSchedule` 一致的轻量校验：缺 `trigger_type`、缺必需字段、字段与规则不匹配（如 `once` 带 `repeat_rule`、
      定时任务带 `due_at`）、`HH:mm` / 日期 / 星期 / 日 / `max_runs` / 时区格式不对、cron 段数不对，以及分钟字段明显过密
      （`*`、步长 <15、间隔 <15 的列表）都直接回 “Invalid arguments, not dispatched: …”，不调用平台。cron 语法、实际最小间隔、
      是否还有下一次由平台判定（`task_plan_schedule_invalid`）。
    - 带时间规则时平台不论派给谁都只生成建议卡片（`result=proposed`，附 `next_fire_at`），模型看到
      “Scheduled task suggestion card created … it takes effect only after the user confirms it on the card; the first run is at
      yyyy-MM-dd HH:mm (<时区>)”，时间按请求的 `timezone` 格式化，缺省或本机不认识时用 Asia/Shanghai。
    - 平台错误 `task_plan_schedule_invalid`（时间规则无效）、`task_plan_invalid`（计划参数无效）、`task_plan_limit`（发起人或该负责人的
      活跃计划已达上限）各有说明；与普通任务一起计入每个 Run 5 次的上限。
  - **收到邮件触发**（平台 7b，feat/conversation-files ecba933）：只在用户明确要求“以后收到某人 / 某类邮件时做某事”时用 `trigger_type: mail`。
    - 参数：`mail_senders`（数组，1–50 项，必填）每项是完整地址、`@域名` 或 `members`（本租户成员）；可选 `mail_subject_contains`（≤100 字、单行）、
      `mail_folder`（≤200 字、单行，缺省 INBOX）、`poll_minutes`（5–60）。不能带时间规则字段与 `due_at`；不带 `trigger_type: mail` 时出现邮件字段也拒绝。
    - 描述告诉模型：白名单只能取用户在对话里明确给出的发件人，绝不能根据邮件内容、文件、网页等外部内容推断、添加或放宽；没有给出发件人时先问用户；
      不能用通配、不能为空。数字员工的计划监听它自己的工作邮箱，真人的计划监听用户自己的工作邮箱。
    - **执行方式不由模型决定**：`mail_mode`、`mode`、`event_config` 一律回 “Invalid arguments … mail_mode is not accepted: a mail-triggered task proposed
      here always waits for the user to confirm each matching mail …”，不调用平台（选择报参数错误而不是忽略：静默忽略会让模型以为设置成了自动执行）。
      平台同样拒绝这些字段并固定 `mail_mode=confirm`，不依赖 Worker。
    - Worker 校验与平台 `MailTrigger` 一致的形状（小写、去重；`*`、`?` 通配额外拒绝），平台再按建计划的规则校验。结果：平台返回
      `{result: "proposed", proposal_id, mailbox_email}`，模型看到 “Mail-triggered task suggestion card created … it will watch the mailbox "<地址>",
      and even then …”：负责人是数字员工时说“each matching mail waits for the user to confirm it before the digital employee works on it”，
      是真人时说“each matching mail becomes a to-do for that person; nothing runs automatically”（真人计划每封邮件直接成为待办，没有确认这一步；
      2026-10-26 实链路发现原文案对真人计划说“每封都要确认”，与平台行为不符）。`mailbox_email` 只做展示，格式不对时丢弃，不影响结果。
    - 平台错误 `task_plan_mailbox_unavailable`（要监听的工作邮箱未设置、停用或缺凭据）、`task_plan_mail_auth_unavailable` 各有说明，不重试。
- **report_task**：
  - 参数：`status`（`done` / `needs_input` / `failed`）、`summary`（1–2000 字，给派单人看的结果说明）。
  - lane 把它作为 sync 事件 `task.reported {status, summary}` 放进事件队列（与回答文字同一偏移序列），工具立即回
    “Recorded (…)”。可以多次调用，平台以最后一次为准。CLI 结束时还未确认的回报会在租约内持续重发后再 complete，
    租约将尽仍未送达则记 `CONTROL_EVENTS_UNDELIVERED` 后照常结算；每个 Run 32 条上限，满了以后新回报替换最后一条未送出的
    （见 [执行内核](./control-plane.md)“会话内委派”）。
  - 描述告诉模型：完成任务时必须调用一次，用 summary 写清结果；缺信息无法继续时用 `needs_input` 说明需要什么。
- **说明**：提供时在本轮输入里加一句（与提及成员说明同处）。任务类 Run：“这是同事派给你的任务 … 结束前必须调用一次
  report_task”；对话类 Run：用户明确要求把事情交给被提及的成员时用 propose_task。
- **语言**：工具描述、参数说明和返回给模型的文字是英文（与其他工具一致）；本轮输入里的说明与提及成员说明同为中文。
- **CLI 工具调用 ID**：MCP 网关从 `tools/call` 的 `_meta` 取 Claude Code 的 `claudecode/toolUseId` 交给 lane；
  没有时 lane 每次调用生成一个。Codex 0.154（2026-10-25 核查，未重新抓包）：已有抓包 `/private/tmp/codex-capture/req-1.json`
  只有模型请求，其中的 `x-codex-turn-metadata` 是回合级字段（session、thread、turn 等），没有工具调用 ID；二进制字符串里
  `x-codex-turn-metadata` 与 `call_id` 出现在 MCP 审批相关代码附近，但无法确认 `tools/call` 的 `_meta` 是否带调用级 ID、用什么键。
  误用回合级 ID 会让同一回合的多次调用共用一个 `request_id`（平台返回第一次的结果），所以暂不读取 Codex 的 `_meta`；
  Codex 自己重发同一调用时会得到新的 `request_id`（lane 内的重发不受影响）。

## 任务类 Run 的工具差异

`run.source.type = task` 的 Run（派单服务派给数字员工的任务，包括计划触发的后台任务）执行时没有浏览器在线；`todo`、`schedule`、`mail` 来源的 Run 同样视为无人在线（`workspace_action` 与确认通道同下表任务类一列；`report_task` 仍只给 `task`）。只有 `conversation` 或没有来源的 Run 算有人在线：

| | 对话类 Run | 任务类 Run |
| --- | --- | --- |
| `workspace_action` | 本轮 `ui_context` 声明交互协议时提供 | 不提供（即使输入带页面上下文），指令里也不写页面动作与动作链接 |
| 确认清单命中的 `purefect_call` | 经 `op=confirm` 请浏览器确认，等回执 | 立即返回 `CONFIRMATION_UNATTENDED`：“This call needs a person's confirmation, which an assigned task cannot ask for … in the summary of your task report (report_task) say who needs to confirm what.”；不发 `action_requests`、不读令牌、不调用接口，审计记 `FAILED` |
| `report_task` / `propose_task` | `propose_task`（有提及时） | `report_task` |

business 档案下，确认清单的说明也改为：这些接口在派来的任务里不能执行，返回 `CONFIRMATION_UNATTENDED` 时不要重试，在任务回报里写明需要谁确认什么。
判定由 ControlPlane 的 `clientActions.attended(lease)` 给出（SPI，缺省视为在线）；lane 日志 `TOOL_CONFIRMATION` 的 `outcome` 为 `unattended`。

## 指令

Purefect 插件的 ContextProvider 装饰器（`PurefectContext`）只在 business 指令档案下追加（default 档案保留
CLI 自带的系统提示）：

- 启用 `purefect_call` 时：说明它以当前用户权限调用任意平台 API、不确定时先用文档工具查、写操作前确认用户确有此意、
  失败如实说明且不原样重试；工具失败时如实转述错误码与信息，不要推测为账号权限问题。
- Run 有确认清单时：说明哪些接口（最多列 10 个模式）需要用户在工作台确认，以及三个 `CONFIRMATION_*` 错误码的含义与转述方式。
- 本轮有工作区上下文时：动作链接协议（文档 49），`p-open://mpage/...`、`p-close://mpage/...`、
  `p-close://session`；链接是命令，只在动作确实应执行时输出，可选建议用普通文本；页面编码与对象 ID 只能来自上下文
  或用 `purefect_call` 查到的元数据。移动端只给打开链接；协商了 `navigation=1` 时说明 `__tab` / `__anchor`。
- 本轮提供页面动作工具时：说明可用操作，并要求这些操作优先用工具（有回执），工具不提供的再用链接。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SANDLANE_ENABLED_TOOLS` | 全部：`purefect_call,list_api_docs,read_api_doc,read_skill,workspace_action,propose_task,report_task` | 逗号分隔，用于收紧。去掉 `workspace_action` 即不提供页面动作，去掉 `propose_task` / `report_task` 即不提供会话内委派；至少保留一个网关工具；未知名称启动失败 |
| `PUREFECT_CLIENT_MODULE` | 必填 | 受管 PurefectClient 模块绝对路径；文档目录取其 `../apis` |
| `PUREFECT_INSTRUCTION_PROFILE` | `default` | `business` 时追加上述指令 |
| Engine `purefect.ai.run.workspace-operations` | 全部 9 种 | 收紧页面动作操作（浏览器据此声明） |
| Engine `purefect.ai.run.confirm-api-codes` | 空 | 需要用户确认后才执行的接口编码（`*` 通配，≤200 项），见“审批桥接” |

`SANDLANE_MODEL_FUNCTION_INVENTORY` 缺省按启用的工具和各 CLI 命名推导（页面动作、`propose_task`、`report_task` 也在内）；显式配置时须自行加入，否则模型网关会拒绝带这些函数的请求。

## 审计

每次到达工具授权的调用记一行 `TOOL_CALL`：`run`、`tool`、工具给出的标识（`purefect_call` 为 `api_code`，
文档工具为 `module` / `doc`）、`outcome`（SUCCEEDED / FAILED / UNKNOWN / REJECTED）、错误码与耗时。
未获确认的调用记 `FAILED` 与 `CONFIRMATION_*` 错误码。
不记参数值和返回内容。页面动作本身由 Engine 的动作记录审计。控制面工具不经工具授权，lane 记一行 `CONTROL_TOOL_CALL`
（run、tool、outcome、result 代码如 `dispatched` / 平台错误码、耗时）。
