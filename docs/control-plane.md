# 执行内核与 Engine 契约（claim / sync / complete）

当前对接 Engine 契约 `purefect-ai-execution/1`。本仓库版本化制品
`contract/ai-execution-v1.schema.json` 是 SandLane 构建和独立 CI 使用的唯一副本；插件解析测试始终
按该制品执行，不依赖兄弟仓库。存在同级 `purefect-platform` checkout 时，测试另与 Engine 副本逐字节
比较；也可用 `PUREFECT_AI_EXECUTION_CONTRACT` 指定平台 schema 文件。

## 契约同步流程

Purefect 平台升级契约后：

1. 从对应平台提交逐字节复制
   `purefect-engine/src/main/resources/purefect/contract/ai-execution-v1.schema.json` 到本仓库
   `contract/ai-execution-v1.schema.json`，不要手工重排或改写；
2. 同步 `contract/examples/` 中由两端共享的样例；
3. 更新 Purefect 插件解析实现和单测，使本地 schema 校验与插件解析对同一用例给出一致结论；
4. 在同级平台 checkout 下运行 `npm test`，或设置
   `PUREFECT_AI_EXECUTION_CONTRACT=/absolute/path/to/ai-execution-v1.schema.json npm test`，确认逐字节比较；
5. 将 SandLane 修改与平台契约提交号一同评审和记录。独立 CI 没有平台副本时会明确跳过跨仓库比较，
   但仍会执行本地 schema 与插件解析一致性测试。

## 入口与组成

`npm run runtime:purefect`（`dist/bin/worker.js`）是 Purefect composition 的运行入口，一个进程内包含：

| 组件 | 文件 | 说明 |
| --- | --- | --- |
| PAPI 客户端 | `src/plugins/purefect/control-plane.ts`（契约解析 `contract.ts`） | `POST {origin}/papi/{site}/{tenant}/pf.ai.worker.ExecutionDomain::{claim\|sync\|output\|propose\|complete}`，请求头 `X-Purefect-Service-Token: <id>:<secret>`，请求体即契约对象；解析平台 `Response` 信封，错误转为带 `fault` 的 `ControlPlaneError`（gap 附 `expected`），不带响应正文、URL 或凭据 |
| 执行 lane | `src/core/worker.ts` | 每条 lane：长轮询 claim（失败退避 ≤5 秒带抖动）→ 登记凭据 → Broker 按租约 `run.harness` 分配沙箱 → sync(`started`)（与 CLI 初始化并行）→ 驱动 CLI（Codex 或 Claude Code）→ ≤1 秒 sync（新增文字/页面动作立即触发）→（文件模式）回合结束、CLI 停止时读取生成文件 → 撤销凭据 →（文件模式）逐个 output → 停止沙箱 → complete（重试） |
| 凭据登记 | `src/core/credentials.ts` | 运行时内存，capability → Run；密钥在私有字段，`JSON.stringify` / `inspect` 不可见；sync 续发令牌即替换；撤销或租约过期即中止下游请求 |
| 模型网关 | `src/gateway/model/local-authority.ts` + `model-server`/`gateway` | 同一 TLS 监听两个入口：`/v1/responses`（Codex）与 `/v1/messages`（Claude Code，见 [Claude Code 支持](./claude-code.md)）；capability 只能用于其 Run 的协议入口；每个 (协议, `base_uri`) 一个上游客户端；累计用量供 complete |
| MCP 网关 | `src/gateway/tool/local-authority.ts` + 现有 `mcp-server`/`gateway` | Purefect 工具（`purefect_call` 与 API 文档，默认全部开放）使用执行人当前 `agent_token`，权限由平台按该用户判断；令牌过期或撤销后拒绝新调用并中止进行中的调用。页面动作 `workspace_action` 也在这里提供，经该 Run 的 lane 转给浏览器；会话内委派的 `propose_task` / `report_task` 同样经该 Run 的 lane 走控制面。见 [工具与页面动作](./tools-and-page-actions.md) |
| 沙箱 | `src/sandbox/docker/broker-sandbox.ts` | `BrokerClient.allocateManaged`（RunSpec v2 + RunAuthorization），容器内只有两个 43 位 capability；Broker 租约跟随 `lease_until` 续期 |

## 语义要点

- **领取幂等**：claim 失败（未拿到响应）时用同一 `claim_token` 重试，Engine 返回同一批作业；拿到响应后才换新凭证。
- **Harness**：租约 `run.harness`（缺省 `codex`）选择 Driver 与 Broker 上的 CLI 镜像；`model_service.wire_api` 须与之匹配（`codex`↔`responses`、`claude-code`↔`anthropic-messages`，Purefect 插件校验，不匹配按无效租约结算）。本 Worker 无对应 Driver、Broker 无对应镜像，或 Driver 的协议与租约不符时，以 `FAILED`（`harness_unavailable`）结算，不重试。
- **已开始**：沙箱分配成功（输入已交付）后用 `started: true` 上报一次。CLI 初始化（Codex 建线程；Claude Code 的 initialize 与推理强度控制请求）与上报并行，首个模型请求（Codex `turn/start`、Claude Code 首条用户消息）等 Engine 确认后才发送；未确认（取消、租约丢失、停机）则不开始回合。之前的失败不会执行任何东西。分配期间每 5 秒心跳续租；心跳收到 `cancel` 立即中止分配并以 `CANCELLED` 结算。
- **事件**：上报 `assistant.message.delta` 与脱敏的 `runtime.item.*`，`offset` 为第一条事件的连续序号；收到 `ai_event_offset_gap` 按 `expected` 从内存中重发。文字增量合并后上报，答案上限 200000 字节（JSON 转义后 UTF-8），超出部分丢弃但 Run 照常结束（日志 `ANSWER_TRUNCATED`）；工具活动事件上限 1024 条，超出视为输出无效。
- **联网访问**：租约 `run.web_access`（提交时冻结，缺省视为不能联网）解析为 SPI `WebAccessPolicy`（`open` / `allowlist` / `off`），登记在 Run 的凭据上；模型网关按 Run 保留、收窄或移除模型服务自带的联网搜索工具，沙箱本身始终不联网。详见 [联网访问](./web-access.md)。
- **页面动作**：`workspace_action` 是工具网关的 MCP 工具，Codex 与 Claude Code 通用；本轮是否提供、可用操作由 `ui_context` 决定。调用经该 Run 的 lane 放入下一次 sync 的 `action_requests`，之后以 `awaiting_actions` + `wait_ms` 长轮询回执；`VOID` 回执转为 `failed/unavailable`。详见 [工具与页面动作](./tools-and-page-actions.md)。
- **后台 Run**（`run.source.type` 为 `task`、`todo`、`schedule`、`mail`：派单服务派给数字员工的任务、计划触发的后台任务、待办、收到的邮件等）：没有浏览器在线。由 ControlPlane 的 `clientActions.attended()` 判定（Purefect 插件：只有 `source.type = conversation` 或没有来源（旧 Engine、不认识的类型）才算在线），lane 据此：不提供 `workspace_action`（即使输入里带页面上下文），指令里不写页面动作与动作链接；需要确认的接口不登记浏览器确认通道，调用立即判为 `unattended`（`CONFIRMATION_UNATTENDED`），不发 `action_requests`、不调用接口。对话类 Run 不变。见 [工具与页面动作](./tools-and-page-actions.md)“任务类 Run 的工具差异”。
- **Run 来源**（租约 `run.source`，可选）：`{type, ref}`，`type` 为 `conversation`、`task`、`todo`、`schedule`、`mail` 之一，`ref` 可以没有或为 `null`。旧 Engine 不下发、或类型不认识（更新的 Engine）时视为没有来源，不提供任何委派工具，Run 照常执行；`ref` 不是一行有界文字时丢弃 `ref`（Worker 不读它）。只有 `source` 不是对象时租约无效。容忍的内容记日志 `LEASE_ADJUSTED`（`adjustment` 为 `source_type_unknown`、`source_ref_invalid`、`mentions_truncated`、`mention_name_missing`），不记内容。
- **提及成员**（`run.input.mentions`）：超过 10 个时只保留前 10 个，名字缺失或为空时按空串处理（给模型的说明写“未提供姓名”），都不拒绝租约；名字中的控制字符、格式字符（含双向控制符、零宽字符）与行/段分隔符换成空格，按 JSON 字符串引用。
- **会话内委派**（平台设计 `purefect-docs/digital-employee/assignment-and-scheduled-tasks.md` §18.4）：两个控制面工具，经工具网关以 MCP 提供，由该 Run 的 lane 用 SERVICE 主体与租约证明完成，不用执行令牌（执行令牌不能调用任务接口）。
  - `propose_task`：只在 `source.type = conversation` 且 `run.input.mentions` 非空时提供。调用 `ExecutionDomain::propose`，请求体 `{job_id, generation, claim_token, request_id, assignee_member_id, title, description?, due_at?, review_required?}`；响应 `{protocol, result: "dispatched", task_id}`（数字员工，已派出）或 `{protocol, result: "proposed", proposal_id}`（真人，会话里生成待确认的建议卡片）。
  - `request_id`：同一次工具调用不变、不同调用不同。CLI 在 `tools/call` 的 `_meta` 里给出工具调用 ID 时由它得到（Claude Code 的 `claudecode/toolUseId`；合乎 `[A-Za-z0-9][A-Za-z0-9_-]{0,99}` 原样使用，否则取 SHA-256 摘要 `h<40 位>`），没有时 Worker 每次调用生成 `w<32 位>`。网络错误、超时（结果未知）时用同一个 `request_id` 重发两次（间隔 0.5、1.5 秒，每次 ≤10 秒）；平台按 Run 去重，同一键返回同一结果。
  - 定时 / 周期任务：请求体可带 `trigger_type`、`run_at`、`repeat_rule`、`time_of_day`、`weekdays`、`month_days`、`cron`、`timezone`、`end_at`、`max_runs`（契约 `proposeRequest`，与平台 531b179 逐字节一致），Worker 先做轻量格式校验（`src/plugins/purefect/task-schedule.ts`）；平台不论负责人是谁都返回 `{result: "proposed", proposal_id, next_fire_at}`。见 [工具与页面动作](./tools-and-page-actions.md)“定时 / 周期任务”。
  - 收到邮件触发：`trigger_type: mail` 带 `mail_senders`（数组，必填）、`mail_subject_contains?`、`mail_folder?`、`poll_minutes?`，不带 `mail_mode`（平台固定先确认再执行，带了就报 `task_plan_invalid`）；Worker 先做轻量校验（`src/plugins/purefect/task-mail.ts`）；平台返回 `{result: "proposed", proposal_id, mailbox_email}`。契约与平台 ecba933 逐字节一致。见 [工具与页面动作](./tools-and-page-actions.md)“收到邮件触发”。
  - 每个 Run 最多派出（`dispatched` 或 `proposed`）5 个任务，第 6 个起不调用平台、直接回固定文字；同一 Run 的调用逐个执行，不并发。同一次工具调用的重发（同一 `request_id`）不重复计数。
  - 平台的错误码转为给模型的一句话，不终止 Run，错误码只进日志：
    - 业务拒绝（`ai_*` 与 `task_*`，如 `ai_propose_assignee_not_mentioned`、`ai_actor_unavailable`、`task_execution_unsupported`、`task_forbidden`、`task_assignee_invalid`、`task_attachment_invalid`、`task_invalid`）各有说明，未列出的统一说“平台拒绝了这次请求”，不要再调用；
    - 其他平台错误（5xx、锁超时、`ai_execution_disabled` 等，平台已答复失败、没有生效）说“暂时失败，可以稍后再试一次”；
    - 没有答复（网络、超时，重发两次后）或答复无法解析时，任务可能已经派出：告诉模型结果未知、不要自动重试。模型重试是一次新的工具调用、新的 `request_id`，平台无法去重，所以这一类不说“可以重试”。参数（负责人须在提及里、标题 ≤200、说明 ≤4000、`due_at` 为 13 位毫秒数或 `yyyy-MM-dd HH:mm`、`review_required` 布尔）先在 Worker 校验，不合格不发给平台。
  - `report_task`：只在 `source.type = task` 时提供。参数 `{status: done|needs_input|failed, summary ≤2000}`，作为 sync 事件 `{type: "task.reported", data: {status, summary}}` 进入同一个事件队列（排在已产生的文字之后，按偏移连续送达），工具立即返回 “Recorded (…)”；多次调用都上报，平台以最后一次为准。
    - 送达：CLI 结束后，事件队列里还有未确认的回报时，lane 按退避（从 sync 间隔起翻倍，最长 2 秒）持续重发，直到送达，或租约、Run 截止时间只剩 5 秒（且最长 60 秒）为止；之后才停止沙箱、complete。仍未送达时记日志 `CONTROL_EVENTS_UNDELIVERED`（`pending` 为未确认的事件数）并照常结算，平台按没有回报处理（设计 §18.3 的兜底）。所以“在 complete 之前送达”只在 Engine 于租约内恢复时成立。
    - 上限：每个 Run 最多 32 条；达到上限后，新回报替换队列里最后一条尚未被 sync 带走的回报（保证最后一次是模型最终的回报），没有可替换的则回 “Not recorded”。CLI 退出、停止沙箱或租约丢失之后不再收。
  - 提供时在本轮输入里加一句说明（与提及成员说明放在一起：business 档案为系统指令，default 档案为上下文数据）；任务类 Run 说明这是同事派来的任务，结束前调用 `report_task`。
  - `SANDLANE_ENABLED_TOOLS` 去掉它们即不提供；租约 `run.tools`（成员设置）不收窄它们：是否提供已由 `run.source` 表达。lane 日志记 `CONTROL_TOOL_CALL`（run、tool、outcome、result 代码、耗时），不记参数与结果文字。
- **助理档案指导**（`run.input.instructions`，可选）：
  - 内容是 Engine 按成员的智能体档案冻结的指导，包括发布的智能体定义和成员个人偏好。
  - Worker 截断到 6000 字节，作为带标签的上下文数据交给模型，**不作为系统指令**，所以不会替换 CLI 自带的系统提示，也不授予权限。
  - 上下文数据的上限因此从 2 条调为 3 条（另外 2 条留给记忆）。
- **会话文件**（租约 `credentials.files`，可选）：分配沙箱前，Worker 在宿主上下载 `loaded` 的文件（https、单文件 10 MB、合计 40 MB），经 Broker `/v1/inputs` 在 CLI 启动前写到 `/workspace/inputs/`，并附 `manifest.json`（原文件名、安全文件名、类型、大小、来源、是否载入）；下载失败只标为未载入，写入沙箱失败则以 `input_files_unavailable` 结算。这类 Run 进入文件模式：CLI 额外获得读文件与命令行工具（只在沙箱内）。签名地址与 `agent_token` 同等保护。详见 [配置参考](./configuration.md) 的“会话文件与沙箱资源”。
- **文件模式开关**（租约 `run.file_tools`，可选布尔）：平台按 `purefect.ai.run.file-tools`（`auto` 有会话文件才开 / `always`）下发；`false` 时即使有会话文件也不进文件模式、不下载；旧平台不下发时按是否有 `credentials.files` 判断。文件模式但没有会话文件时只写入空的 `manifest.json`（Broker 要求文件模式的 CLI 在写入之后才能启动）。
- **生成文件**（`ExecutionDomain::output`，设计 `purefect-docs/digital-employee/conversation-files.md` §5.1、§12）：
  - 时机：文件模式的 Run，CLI 自己结束回合（成功或失败都收集）时读取：Driver 回合结束即停止 transport，读取在 CLI 通道关闭之前进行（通道关闭即终止分配、清空工作区），此时 CLI 进程仍在、网关凭据尚未撤销，读取最长 35 秒。上报在撤销网关凭据之后、确认停止沙箱之前、complete 之前，所以平台的 `run.file.created` 排在 `run.completed` 之前；期间心跳续 Engine 租约。
  - 由 Worker 结束 CLI 的 Run（取消、Worker 停机、到达截止时间、租约丢失、sync 被明确拒绝）不读取也不上报：停止 transport 时跳过读取，已在进行的读取立即放弃，不会为读取拖住 CLI。上报期间心跳收到 `cancel`，当前这个调用结束后不再发起新的上报（Run 的结果已确定，不改变）。
  - 读取：经 Broker `POST /v1/outputs` 读 `/workspace/outputs` 的一级普通文件（见 [配置参考](./configuration.md)“生成文件”）。
  - 校验（Worker，`src/core/output-files.ts`）：扩展名白名单 + 魔数（与平台 `ai_output` 用途的 `FilePurposePolicy` 一致）、OOXML 宏、CSV 防公式注入，见配置参考。
  - 上报：先逐个上报通过的文件 `{job_id, generation, claim_token, path: "outputs/<name>", name, content_type, content_base64}`，再逐个上报被拒的 `{…, path, name, rejected}`（原因 `too_large`、`too_many`、`type_not_allowed`、`content_mismatch`、`macro`、`not_regular_file`、`invalid_name`、`upload_failed`）。响应 `{protocol, file_id, name, content_type, size}`，被拒的只有 `{protocol}`。
  - 上传不重试（丢失的响应可能已经保存了文件）：平台明确拒绝（返回错误信封）时补报一次 `rejected = upload_failed`；结果未知（网络中断、超时、响应无法解析）时不补报，只计入日志 `OUTPUT_FILES_DELIVERED` 的 `uncertain`，以免平台已保存的文件又显示为失败；平台报 `ai_output_limit` 时该文件及其后的文件都报 `too_many`；`ai_lease_lost` 立即停止。每次调用不超过 60 秒，且只在租约与 Run 截止时间还剩 5 秒以上时发起，整段最长 120 秒。
  - 这一步的任何失败都不改变 Run 的结果，日志只有代码与计数（`OUTPUT_FILES_COLLECTED`、`OUTPUT_FILES_DELIVERED`、`OUTPUT_FILE_REPORT_FAILED`、`OUTPUT_FILES_UNAVAILABLE`、`OUTPUT_FILES_INCOMPLETE`、`OUTPUT_FILES_SKIPPED`），不记文件名、内容或地址。
  - 请求体上限：`output` 单独放宽到 14 MiB（10 MiB 文件的 base64 约 13.4 MiB），其余操作仍是 512 KiB。
- **取消**：sync 返回 `cancel: true` 时先撤销本 Run 的网关凭据（沙箱里进行中的模型、工具调用随即中止，之后的调用被拒），再停止 Driver，以 `CANCELLED` 结算；停机与到达截止时间同样先撤销再停止。已自然完成的 Run 照实上报，由 Engine 仲裁。
  - Run 主体失去业务准入（成员停用、改为外部）时，Engine 以 `cancel: true` 下发，并**省略 `agent_token`**：不再续发。
  - Worker 立即丢弃手上的令牌（`RunCredential.renew` 不带令牌即清除），工具调用随即被拒，同时按取消流程终止执行。
  - 只有 `cancel: true` 时可以省略令牌；`cancel: false` 却缺令牌按协议错误处理。
  - 两端共享样例 `contract/examples/sync-response-subject-withdrawn.json`：Engine 测试用它核对真实响应，SandLane 测试用它驱动解析与 Worker 终止。
- **租约丢失**：`ai_lease_lost` 或本地租约到期未续上，立即撤销凭据（中止进行中的模型/工具调用），再停止 Driver、终止容器，**不** complete。
- **明确拒绝**：sync 返回 `ai_*` 业务 fault（`ai_lease_lost`、`ai_event_offset_gap`、`ai_execution_disabled` 以外，如 `ai_invalid_input`）时不再重试，立即停止并以 `FAILED`（`sync_rejected`）结算。
- **停止沙箱**：未确认时重新向 Broker 发 terminate 并校验回执，退避 1/2/4 秒最多 4 次，且不超过租约；期间心跳续 Engine 租约但不续 Broker 租约，仍未确认则不结算，由 Broker 看门狗收尾。
- **结算**：`SUCCEEDED`/`FAILED`/`CANCELLED` + `answer` + `usage{input_tokens,output_tokens}`；网络、协议错误及其他 fault 按退避重试到租约到期后 5 秒，`ai_complete_rejected`/`ai_lease_lost`/`ai_invalid_input` 立即放弃；相同内容重复提交返回 `ALREADY_ACCEPTED`。
- 不在本地持久化任何作业状态：Worker 崩溃后不重放 prompt，已开始的作业由 Engine 标记为 UNKNOWN。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SANDLANE_RUNTIME_ID` | 是 | claim 的 `runtime_id`，也是网关绑定中的 runtimeId |
| `PUREFECT_ENGINE_ORIGIN` | 是 | Engine HTTPS origin（无路径） |
| `PUREFECT_CONTROL_SITE` / `PUREFECT_CONTROL_TENANT` | 是 | PAPI 路径中固定的控制站点/租户 |
| `PUREFECT_SERVICE_PRINCIPAL` | 是 | SERVICE 主体 ID |
| `PUREFECT_SERVICE_SECRET` 或 `_FILE` | 是 | SERVICE 主体密钥（文件需 0600） |
| `SANDLANE_LANES` | 否 | 领取的队列 lane，逗号分隔，默认 `interactive` |
| `SANDLANE_CONCURRENCY` | 否 | 并行执行 lane 数，默认 1，最大 16 |
| `SANDLANE_ADMISSION_MEMORY_MIB` | 否 | 按内存接活：宿主 `MemAvailable` 低于此值（MiB）时 lane 暂不领取，默认 0（关闭），见 [配置参考](./configuration.md) |
| `SANDLANE_ENABLED_TOOLS` | 否 | 启用的工具，默认全部（`purefect_call,list_api_docs,read_api_doc,read_skill,workspace_action,propose_task,report_task`），配置后收紧 |
| `SANDLANE_REASONING_EFFORT` / `PUREFECT_INSTRUCTION_PROFILE` | 否 | 默认推理强度（low/medium/high，租约中的值优先，Codex 与 Claude Code 通用）与指令档案（default/business） |
| `SANDLANE_DRAIN_MS` | 否 | SIGTERM 后等待进行中 Run 的时间，默认 60000 |
| `SANDLANE_BROKER_SOCKET` / `SANDLANE_BROKER_SERVICE_TOKEN[_FILE]` / `SANDLANE_BROKER_NODE_ID` | 是 | 节点本地 Broker；Broker 须配置 `SANDLANE_BROKER_MANAGED_GATEWAYS` |
| `SANDLANE_MODEL_GATEWAY_BIND` / `_PORT` / `_HOSTNAME` / `_TLS_KEY_FILE` / `_TLS_CERT_FILE` | 是 | 模型网关 TLS 监听（与 `SANDLANE_BROKER_MANAGED_GATEWAYS.modelBaseUrl` 对应） |
| `SANDLANE_MODEL_FUNCTION_INVENTORY` | 否 | 按 harness 的模型可见函数 JSON 对象（`{"codex":[...],"claude-code":[...]}`）；默认由启用的工具（含 `workspace_action`、`propose_task`、`report_task`）按各 CLI 的 MCP 命名推导；显式配置时，列出的每个 harness 都必须包含启用的 `propose_task` / `report_task`，否则启动失败 |
| `SANDLANE_MODEL_FILE_FUNCTION_INVENTORY` | 否 | 文件模式（租约 `run.file_tools`，旧平台按是否带会话文件）额外放行的 CLI 内置函数，按 harness 的 JSON 对象；默认 Codex `exec_command,write_stdin,shell,shell_command,view_image`、Claude Code `Read,Bash,Glob,Grep`，见 [配置参考](./configuration.md) 的“文件模式” |
| `SANDLANE_MODEL_MESSAGES_AUTH` | 否 | Messages 上游的密钥头：`x-api-key`（默认）、`bearer` 或 `both` |
| `SANDLANE_MODEL_MAX_OUTPUT_TOKENS` | 否 | 默认 32000 |
| `SANDLANE_MODEL_GATEWAY_TIMEOUT_MS` | 否 | 单次模型调用（含流式输出）上限，默认 600000（10 分钟），范围 10000–1800000；Run 截止时间仍优先。模型/MCP 网关并发按 `SANDLANE_CONCURRENCY × 4` 推导（模型 ≤64、MCP ≤32） |
| `SANDLANE_TOOL_MCP_BIND` / `_PORT` / `_HOSTNAME` / `_TLS_KEY_FILE` / `_TLS_CERT_FILE` | 是 | MCP 网关 TLS 监听（与 `mcpUrl` 对应） |
| `PUREFECT_CLIENT_MODULE` | 是 | 受管 PurefectClient 模块绝对路径；API 文档目录取其 `../apis` |
| `PUREFECT_TOOL_ORIGIN` | 否 | Purefect API origin，默认同 `PUREFECT_ENGINE_ORIGIN` |
| `SANDLANE_TOOL_TARGET_REF` / `SANDLANE_TOOL_TARGET_VERSION` | 否 | 工具部署标识，默认为工具服务名 / `1` |
| `SANDLANE_MODEL_ALIAS` | 否 | CLI 中配置的模型别名，默认 `sandlane` |

## 当前限制

- 租约中的身份没有成员 ID（t_aid），工具许可中暂以 user_id 占位（下游适配器仅做形状校验，实际权限由 agent_token 决定）。
- 长期记忆（`src/plugins/memory`）作为 ContextProvider 装饰器可选接入（`SANDLANE_MEMORY_ENABLED=true` + `SANDLANE_MEMORY_DIRECTORY`），默认关闭；对话历史由 Engine 在输入中冻结。
- 未在真实 Docker / Engine 上做端到端验收；Docker 验证脚本中依赖旧链路的 `sandbox-docker-validation`、`broker-channel-validation` 已删除，待按新内核重写。
