<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  Worker、Broker、Relay 与网关的环境变量参考。
-->

# 配置参考

第三方 MCP：Purefect Worker 可用 `SANDLANE_MCP_CONFIG_FILE` 指定管理员 HTTP / stdio MCP 配置，
与现有工具并存。文件挂载、Secret、用户绑定及工具白名单见 [MCP 接入指南](./mcp.md)。

DeepSeek、智谱、Qwen 等上游的协议、地址前缀、认证和实际验收方式见[模型接入指南](./model-providers.md)。
模型 Key 不放进 CLI 环境；`SANDLANE_MODEL_MESSAGES_AUTH` 控制 Worker 到 Messages 上游的认证。

本页 Worker 环境变量对应 Purefect 专用入口。独立 Demo 自动生成受限配置，无需复制
`.env.example`；第三方通过 [managed API](./standalone.md) 显式传参，API 不读取环境变量。

当前入口为 `dist/bin/worker.js`、`dist/bin/broker.js` 和 `dist/bin/relay.js`。三者只读取进程环境，
不会自动加载 `.env.local`；使用 `node --env-file=.env.local ...`、systemd `EnvironmentFile` 或容器
平台配置显式注入。仓库 `.env.example` 是可复制的占位模板，不得写入真实 Secret。

核心配置使用 `SANDLANE_*`，Purefect 插件使用 `PUREFECT_*`。通过 `readSecret` 读取的 Secret
优先使用 `_FILE`：文件必须是绝对路径、当前 uid 拥有的 0600/0400 普通文件，大小不超过 4096
字节；内联值与 `_FILE` 不能同时配置。TLS key/cert 文件也必须是私有普通文件。

## 会话文件与沙箱资源（当前 `runtime:purefect` 链路）

### 会话文件怎样进沙箱

- **来源**：租约 `credentials.files`（Engine 领取时下发，从新到旧），每项 `file_id`、`name`、`content_type`、`size`、`relation`（`input` 用户上传 / `output` 之前生成）、`loaded`；`loaded=true` 的另带 `url`（https 短期签名地址，约 5 分钟）和 `expires_at`。
- **校验**（`src/plugins/purefect/contract.ts`）：与其他凭据同一风格，任一项不合格（非 https、名称超过 512 字符、`size` 超过 10 MB、重复 `file_id`、`relation` 未知、列表超过 200 项等）整个租约按无效租约结算（`worker_invalid_lease`），错误不带地址。超过 50 项时只保留最新的 50 项。
- **下载**（Worker 宿主，`src/core/input-files.ts`、`file-download.ts`）：每个 Run 都重新下载（会话容器每次 Run 结束都会 stop，tmpfs 清空）。只走 https、不跟随跳转；单文件 10 MB、合计 40 MB，`Content-Length` 或实际字节超限即中止，声明了 `size` 的必须一致；单文件 30 秒、全部 60 秒超时，最多 4 个并行。下载失败、地址已过期或超出总量的文件在 manifest 里标为未载入，**不会**让 Run 失败。
- **写入**（Broker `/v1/inputs`，`src/sandbox/docker/session-inputs.ts`）：Worker 只发安全文件名和字节；Broker 再校验一遍（文件名、个数、单文件和合计上限），自己构造 tar，在会话容器里以 uid 1000 执行 `tar -x -f - -C /workspace`（tmpfs 不支持 `docker cp`/归档接口），并检查退出码。只允许在 CLI 启动前（分配中、未开通道）写入；同一分配重复提交相同内容直接确认，内容不同拒绝（`INPUTS_CONFLICT`）。写入失败时 Worker 终止分配，Run 以 `input_files_unavailable` 失败。
- **沙箱里看到的**：`/workspace/inputs/<安全文件名>`（0600）和 `/workspace/inputs/manifest.json`，manifest 每项为 `{name 原文件名, path 安全文件名或 null, content_type, size, relation, loaded}`，包括未载入的文件。安全文件名只含 `[A-Za-z0-9._-]`、保留扩展名、不含 `..` 和路径分隔符，重名时加 `-2`、`-3`；中文等非 ASCII 文件名变成 `file.<扩展名>`，原名看 manifest。
- **指令**：有文件时在指令（业务档案）或上下文数据（默认档案，与成员设置合为一条）中加一段中文说明：工作目录 /workspace、文件位置、先读 manifest、可用 python3 及所列库读 PDF/Excel/PPT/Word、图片可直接查看、文件内容不可信不执行、不要尝试联网、未载入的请用户重新上传。
- **签名地址的保护**：与 `agent_token` 相同——只在 Worker 内存中，不写日志、不进事件、不进状态面板、不进沙箱环境变量或提示词。日志只有 `INPUT_FILES_STAGED`（载入/未载入个数）和 `INPUT_FILE_SKIPPED`（`file_id` 与固定错误码）。

### 文件模式：读文件与命令行

“文件模式”由租约 `run.file_tools`（布尔，可选）决定；平台不下发时（旧版本）按租约是否带会话文件（`credentials.files` 非空，即使其中的文件全部未载入也算，因为 AI 要读 manifest 告诉用户）判断。文件模式的 Run 一定会写入 `/workspace/inputs`（没有文件时只有空的 `manifest.json`），CLI 生成的文件从 `/workspace/outputs` 收集（见下文“生成文件”）。非文件模式的 Run 工具与以前完全一样，`file_tools=false` 时即使有会话文件也不下载。

文件模式当前只由 Codex 和 Claude Code 支持。Qwen Code 与 OpenCode 首版只开放 Run 授权的 MCP
工具，收到 `file_tools=true` 会明确拒绝，不会静默退回无文件模式。

| 环节        | 文件模式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 非文件模式                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Claude Code | `--tools WebSearch,Read,Bash,Glob,Grep`，`--allowedTools` 同时列出这四个（`dontAsk` 下不弹确认）；`--restricted`、`--strict-mcp-config` 等不变；工作目录 /workspace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `--tools WebSearch`                                                                                 |
| Codex       | `features.shell_tool=true`、`features.view_image=true`，`shell_environment_policy.exclude=["SANDLANE_*"]`（命令不继承 capability 变量）；线程 `cwd=/workspace`、`sandbox=danger-full-access`、`approvalPolicy=never`（容器本身就是沙箱，Codex 自带的沙箱在容器里起不来且会挡住 python 写临时文件）；其余 feature 仍关闭                                                                                                                                                                                                                                                                                                                                                                                 | shell / view_image 关闭，`sandbox=read-only`                                                        |
| 模型网关    | 额外放行该 harness 的文件函数：Claude Code `Read`、`Bash`、`Glob`、`Grep`；Codex `exec_command`、`write_stdin`、`shell`、`shell_command`、`view_image`（0.154 起命令工具固定为统一执行 `exec_command`/`write_stdin`，`features.unified_exec=false` 不再生效；更早版本按模型族叫 `shell` 或 `shell_command`）。请求上限放宽到 8 MB；只接受内联内容：Responses 入口只收 `data:image/(png\|jpeg\|gif\|webp);base64` 图片（用户消息或工具输出里）；Messages 入口带 `source` 的块（含 `tool_result.content` 里嵌套的）只收 `image` 的 `base64`（png/jpeg/gif/webp）、`document` 的 `base64`（`application/pdf`）或 `text`（`text/plain`），`url`、`file`、`content` 等来源与 `search_result` 一律拒绝（400） | 发来这些函数、内联图片或任何带 `source` 的块即 400，请求上限不变（Responses 256 KB、Messages 1 MB） |
| Broker      | 授权里带 `fileTools: true`（计入启动摘要）；只允许会话分配，且 `/v1/inputs` 写入成功后才能开通道启动 CLI；CLI 结束后可经 `/v1/outputs` 读取生成文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `/v1/outputs` 拒绝（`OUTPUTS_DENIED`）                                                              |

- `SANDLANE_MODEL_FILE_FUNCTION_INVENTORY`（Worker，可选）：按 harness 覆盖文件模式放行的函数，JSON 对象，例如 `{"codex":["shell","view_image"],"claude-code":["Read","Bash","Glob","Grep"]}`，每个 harness 最多 8 个。Codex 版本更换后若 shell 工具改名（如 `exec_command`），在这里调整，不用改代码。
- 内置工具的调用不进活动面板（只显示 MCP 工具与联网搜索），命令与参数不上报。
- CLI 镜像预装 python3 与 pypdf、pdfplumber、openpyxl、pandas、python-pptx、python-docx、matplotlib（版本固定，见下文“镜像里的文档工具”）。

### 文件模式的安全说明

**为什么只在文件模式开**：读文件和执行命令是本方案里最大的能力扩张。没有文件的对话用不到它们，保持只有 MCP 工具的最小面；有文件时，不能执行命令就无法解析 PDF、Excel 等格式（设计 §2：文档只在沙箱里由 CLI 处理，Engine 不解析）。

**仍然约束它们的**：

- 网络：沙箱不能访问互联网，只能经 Relay 到达模型网关和 MCP 网关；联网搜索仍由模型网关按 Run 的联网策略放行或移除。
- 文件系统：根文件系统只读，以 uid 1000、丢弃全部 capability、`no-new-privileges` 运行；可写的只有 /workspace（96 MiB）、/tmp（32 MiB，noexec）和 CLI 状态目录，均为 tmpfs，每次 Run 结束随容器 stop 清空。
- 资源：容器内存（默认 512 MiB，含 swap）、1 CPU、128 个进程、Run 截止时间与 Broker 看门狗。
- 授权：容器里只有本 Run 的两个 43 位 capability，随 Run 结束撤销、最长不超过 Run 截止时间；模型网关、MCP 网关逐次校验，平台按执行人自己的权限判定每个业务调用，需要确认的接口仍走浏览器确认（`confirm_api_codes`）。签名下载地址、模型 key、执行令牌都不进沙箱。

**残余风险**：

- 文件里的提示注入可以诱导 CLI 在沙箱里执行任意命令、读写工作区里的文件。指令要求文件内容不可信，但这只是约束模型，不是技术隔离。
- 命令能看到本 Run 的 capability：Claude Code 的 `ANTHROPIC_API_KEY`（即模型 capability）和 `SANDLANE_TOOL_CAPABILITY` 会被 Bash 子进程继承（2.1.301 的子进程环境清理依赖 bubblewrap，容器里用不了；Codex 已用 `shell_environment_policy` 排除）。拿到它们最多做到 CLI 本来就能做的事：以执行人身份调用本 Run 放行的工具和模型，仍受网关校验、确认桥接和 Run 截止时间约束；主要影响是被诱导后多花模型用量。命令也可以绕过 CLI 直接向网关发请求，所以网关不信任请求内容：两个入口都只收内联图片和文档，不能借远程地址（`url` 来源、远程图片）让上游服务方替沙箱抓取网络内容、把数据带出去，也不能引用上游存储的文件（`file` 来源）。仍然存在的外带途径：Run 有联网权限时，联网搜索的查询由上游执行，查询词可以带出数据（按 Run 的联网策略放行，见 [联网访问](./web-access.md)）；以及被诱导调用的业务接口（下一条）。（2026-10-27 前 Messages 入口未检查 `source`，`url` 来源会被原样转发，已修正。）
- 被诱导调用业务接口的风险与没有文件时相同（执行人自己的权限，写操作按配置需确认），文件模式不额外放大。

### 生成文件（F3，`/workspace/outputs`）

设计见工作区 `purefect-docs/digital-employee/conversation-files.md` §5.1、§12。

- **指令**：文件模式的说明里要求 CLI 把交给用户的文件直接存到 `/workspace/outputs/`（不存在时 `mkdir -p`，不建子目录、不放中间文件），回答里用 `[文件名](outputs/文件名)` 引用；最多 10 个、单个 10 MB；列出可接受的类型，说明宏、可执行文件、脚本、压缩包不被接受。`/workspace` 是 uid 1000 所有、0700 的 tmpfs，CLI 自己就能建目录，Broker 不预建。
- **读取**（Broker `POST /v1/outputs`，`src/sandbox/docker/session-outputs.ts`）：
  - 请求 `{ref}`（JSON，与其他操作同一鉴权）；只对仍在运行、写过 inputs（即文件模式）的会话分配开放，否则 `OUTPUTS_DENIED`。检查在 Broker 操作队列里做，读取本身不占队列，不拖慢其他 Run 的续约。
  - 在容器里以 uid 1000、不带环境变量、不经 shell 执行两条命令：先 `find /workspace -mindepth 1 -maxdepth 2 ( -path /workspace/outputs -o -path '/workspace/outputs/*' ) -printf '%d %y %s %P\0'` 列出 outputs 目录本身与一级条目（类型、大小、原始文件名字节；`find -P` 不跟随符号链接，outputs 本身是链接时视为没有；输出最多读 256 KiB）；再只对选中的普通文件执行 `tar -c -f - --format=pax --no-recursion -C /workspace/outputs -- <文件名…>`。要求 CLI 镜像里是 GNU find 与 GNU tar（Debian 系的 Node 基础镜像自带）。
  - 选择规则：按文件名排序；文件名不安全（非 UTF-8、超过 80 个字符、含 `/`、`\`、控制字符，以 `.`、`-` 或空白开头，以 `.` 或空白结尾）→ `invalid_name`；不是普通文件（目录、符号链接、设备、管道等）→ `not_regular_file`；超过单个上限 → `too_large`；超过个数 → `too_many`；累计超过合计上限 → `too_large`。被拒条目最多报 32 个。
  - tar 输出由 Broker 自己解析（只认 POSIX ustar 魔数与 pax 扩展头，校验和、截断、GNU 扩展头都使整个读取失败）；只返回与选中名称完全一致、类型为普通文件、大小仍在上限内的条目，其余条目（其他名称、嵌套或越界路径）报 `invalid_name`，链接等报 `not_regular_file`。tar 输出上限按列出的大小加固定开销计算，文件在列出后变大即失败；tar 退出码非 0（例如读取时文件被改动）也失败。没有 outputs 目录时返回空结果。
  - 响应与 inputs 同样分帧：4 字节大端头长度 + 头部 JSON `{files:[{name,size}], rejected:[{name,reason}]}` + 依次的文件字节（`application/octet-stream`）；出错时是 JSON `{error}`。与 `/v1/inputs` 共用“同时最多 2 个大传输”的限制。
- **校验**（Worker，`src/core/output-files.ts`）：
  - 扩展名白名单与魔数（与平台 `FilePurposePolicy.matchesContent` 一致）：`pdf`（`%PDF-`）、`docx`/`xlsx`/`pptx`（`PK\3\4`，且 ZIP 中央目录里有 `[Content_Types].xml` 和对应的 `word/`、`xl/`、`ppt/` 部件）、`png`、`jpg`/`jpeg`、`gif`、`webp`；`csv`、`txt`、`md`、`json` 须是不含 NUL 的 UTF-8，`json` 须能解析。不符 → `content_mismatch`，空文件也是。
  - 宏：`docm`、`xlsm`、`xlsb`、`pptm` 等启用宏的扩展名直接 `macro`；OOXML 包的中央目录里有 `vbaProject.bin`、`vbaProjectSignature`、`vbaData.xml`、`macrosheets/` 或 `activeX/` 部件也是 `macro`；此外解析 `[Content_Types].xml`（存储或 deflate，最大 1 MiB，UTF-8 或带 BOM 的 UTF-16，先解开数字字符引用；部件名按 OPC 不区分大小写，所有拼法都检查），声明了 VBA 工程（`application/vnd.ms-office.vbaProject`）、`vbaData`、`macroEnabled` 主部件、`macrosheet` 或 `activeX` 类型的也是 `macro`（部件可以起任意名字，所以同时看声明的类型）；读不出来（加密、其他压缩方式、数据损坏、带 DTD）→ `content_mismatch`。
  - 其他扩展名（可执行文件、脚本、压缩包、html、svg 等）→ `type_not_allowed`。
  - CSV 防公式注入（OWASP）：以 `=`、`+`、`-`、`@`、制表符、回车开头且不是数字的单元格加单引号前缀（带引号的单元格加在引号内）；`-5`、`3.2`、`+1e3` 等数字不动，其余字节（引号、分隔符、换行、BOM）原样保留。逗号、分号、Tab 都当作分隔符（表格软件按区域设置或内容猜测分隔符，按任一种读法都不会出现公式；代价是逗号文件里单元格内 `;` 后的 `=`/`-` 等也会加前缀）；首行（可连续多行、可带引号）是 `sep=…` 指令时去掉，文件不能自选分隔符，去掉后没有内容则 `content_mismatch`。xlsx 里的公式是正常功能，不处理。
- **上报**：见 [执行内核与 Engine 契约](./control-plane.md)“生成文件”。日志只有代码与计数。
- **剩余风险**：文件内容来自可能被提示注入影响的 CLI；类型检查只保证“是声明的格式、不含宏”，不保证内容无害（例如 PDF 里的链接、docx 里的外部引用）。下载时平台按受限文件签名并强制 `attachment`（图片、PDF 除外）。

| 变量                                   | 所在进程 | 默认值 | 说明                                                           |
| -------------------------------------- | -------- | ------ | -------------------------------------------------------------- |
| `SANDLANE_BROKER_OUTPUT_MAX_FILES`     | Broker   | `10`   | 每个 Run 读出的生成文件个数（1–10，平台每个 Run 最多收 10 个） |
| `SANDLANE_BROKER_OUTPUT_FILE_MAX_MIB`  | Broker   | `10`   | 单个生成文件上限（MiB，1–10，平台单个上限 10 MiB）             |
| `SANDLANE_BROKER_OUTPUT_TOTAL_MAX_MIB` | Broker   | `30`   | 一个 Run 的生成文件合计上限（MiB，1–64，且不超过工作区大小）   |

### 镜像里的文档工具

- `deploy/Dockerfile.cli`（Codex）与 `deploy/Dockerfile.cli-claude` 在构建时用 apt 装 python3，再用 pip（`--only-binary=:all:`，只用预编译 wheel，不需要编译工具）装到系统 site-packages：`pypdf==5.4.0 pdfplumber==0.11.6 openpyxl==3.1.5 pandas==2.2.3 numpy==2.2.4 python-pptx==1.0.2 python-docx==1.1.2 matplotlib==3.10.1`。两份列表须一致（`test/architecture.test.js` 检查），升级时同改。构建完成后卸掉 pip，运行时不能也不需要联网安装。
- 只读根文件系统下：`MPLCONFIGDIR=/tmp/matplotlib`（matplotlib 缓存写到 /tmp tmpfs）、`MPLBACKEND=Agg`（无显示）、`PYTHONDONTWRITEBYTECODE=1`；镜像仍以 uid 1000 运行。构建时会实际 import 一遍这些库确认可用。
- 体积估计：python3 约 50 MB，numpy、pandas、matplotlib 及其依赖（pillow、fonttools、lxml、pdfminer.six、pypdfium2、cryptography 等）约 250 MB，每个 CLI 镜像解压后增加约 300 MB（压缩层约 100 MB）。以实际构建为准。
- 使用文件模式前须按 [Claude Code 支持](./claude-code.md) 与 Codex 镜像的构建方式构建镜像、在其上构建 `deploy/Dockerfile.cli-ca`，执行镜像漏洞与许可证检查，并更新 `SANDLANE_BROKER_RUN_IMAGES` 的 digest。

### 资源与按内存接活

| 变量                             | 所在进程 | 默认值           | 说明                                                                                                                                                                                                                                          |
| -------------------------------- | -------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANDLANE_BROKER_WORKSPACE_MIB`  | Broker   | `96`             | 沙箱 `/workspace` tmpfs 大小（MiB，64–4096），计入容器内存；原固定值 64                                                                                                                                                                       |
| `SANDLANE_BROKER_RUN_MEMORY_MIB` | Broker   | 不设（全部 512） | 按 harness 的容器内存上限 JSON，例如 `{"codex":256,"claude-code":512}`；只能写 `SANDLANE_BROKER_RUN_IMAGES` 里有的 harness，128–65536 且须大于工作区大小；未列出的仍为 512 MiB（含 swap）                                                     |
| `SANDLANE_ADMISSION_MEMORY_MIB`  | Worker   | `0`（关闭）      | lane 每次领取 Run **之前**读宿主 `/proc/meminfo` 的 `MemAvailable`，低于此值（MiB）就不领取，每 2 秒再查；状态面板上该 lane 显示 `MEMORY_LOW`，日志 `CLAIM_DEFERRED` 只打一次。读不到（非 Linux 等）时照常领取并记 `ADMISSION_MEMORY_UNKNOWN` |

- 容器内存上限是 cgroup 的天花板，不是预留；空闲会话容器只跑 `sleep`。并发仍由 `SANDLANE_CONCURRENCY`（lane 数）和 Broker 的 `SANDLANE_BROKER_MAX_CONCURRENT` / `SANDLANE_BROKER_PER_TENANT` 决定，按内存接活只在其上兜底。
- 阈值取“典型峰值 + 安全余量”，具体数值待在 demo 机上用 10 MB PDF/Excel 实测（`docker stats`）后再定。2 GB 的 demo 机建议 `SANDLANE_CONCURRENCY=1`。
- Worker 跑在容器里时 `/proc/meminfo` 反映的是宿主（Docker Desktop 下是其虚拟机）的内存，这正是沙箱容器共享的内存池。

## Worker 与 Purefect 插件

| 变量                                                | 必填 | 说明                                                                                                                                                                                                                |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANDLANE_RUNTIME_ID`                               | 是   | claim 上报的稳定 runtime id                                                                                                                                                                                         |
| `SANDLANE_LANES`                                    | 否   | 逗号分隔的领取队列，默认 `interactive`。Engine 配置了 `purefect.ai.run.background-lane`（例如 `background`）后，这里须同时包含该通道（如 `interactive,background`），否则后台 Run 无人领取；Engine 未配置时不需要改 |
| `SANDLANE_CONCURRENCY`                              | 否   | 执行 lane 数，1–16，默认 1                                                                                                                                                                                          |
| `SANDLANE_ADMISSION_MEMORY_MIB`                     | 否   | 领取前要求的宿主可用内存，默认 0（关闭）                                                                                                                                                                            |
| `SANDLANE_DRAIN_MS`                                 | 否   | SIGTERM/SIGINT 的 drain 宽限，默认 60000 ms                                                                                                                                                                         |
| `PUREFECT_ENGINE_ORIGIN`                            | 是   | HTTPS Engine origin，不带路径、query 或 userinfo                                                                                                                                                                    |
| `PUREFECT_CONTROL_SITE` / `PUREFECT_CONTROL_TENANT` | 是   | PAPI 路径的控制站点和租户                                                                                                                                                                                           |
| `PUREFECT_SERVICE_PRINCIPAL`                        | 是   | Purefect SERVICE 主体 ID                                                                                                                                                                                            |
| `PUREFECT_SERVICE_SECRET[_FILE]`                    | 是   | SERVICE 主体 Secret                                                                                                                                                                                                 |
| `PUREFECT_CLIENT_MODULE`                            | 是   | PurefectClient 模块绝对路径；API 文档须位于相邻 `apis/`                                                                                                                                                             |
| `PUREFECT_TOOL_ORIGIN`                              | 否   | 工具调用 origin，默认等于 Engine origin                                                                                                                                                                             |
| `PUREFECT_INSTRUCTION_PROFILE`                      | 否   | `default` 或 `business`，默认 `default`                                                                                                                                                                             |
| `SANDLANE_ENABLED_TOOLS`                            | 否   | 逗号分隔工具白名单；只能从内置 Purefect catalog 收紧（含页面动作与会话内委派的 `propose_task`、`report_task`）                                                                                                      |
| `SANDLANE_REASONING_EFFORT`                         | 否   | `low`、`medium` 或 `high`；租约值优先                                                                                                                                                                               |
| `SANDLANE_MODEL_ALIAS`                              | 否   | CLI 使用的网关模型别名，默认 `sandlane`                                                                                                                                                                             |

控制面调用是 Worker 主动发起的 PAPI `claim` / `sync` / `complete`。

## Worker 到 Broker

| 变量                                   | 必填 | 说明                                                   |
| -------------------------------------- | ---- | ------------------------------------------------------ |
| `SANDLANE_BROKER_SOCKET`               | 是   | Broker Unix socket 绝对路径                            |
| `SANDLANE_BROKER_SERVICE_TOKEN[_FILE]` | 是   | Worker/Broker 共享 Secret；必须与 Purefect Secret 不同 |
| `SANDLANE_BROKER_NODE_ID`              | 是   | Worker 期望 Broker 报告的 node id                      |

当前 `runtime:purefect` 要求 Broker 报告 managed gateways ready，因此配套 Broker 必须使用
`isolated` 网络、Relay binding 和 managed gateway policy。

## 模型与工具网关

| 变量                                                     | 必填 | 说明                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANDLANE_MODEL_GATEWAY_BIND` / `_PORT`                  | 是   | 模型 TLS 服务监听 IP 和端口                                                                                                                                                                                                                                                                                                                                                                       |
| `SANDLANE_MODEL_GATEWAY_HOSTNAME`                        | 是   | 沙箱请求使用、并由服务校验的主机名                                                                                                                                                                                                                                                                                                                                                                |
| `SANDLANE_MODEL_GATEWAY_TLS_KEY_FILE` / `_TLS_CERT_FILE` | 是   | 模型网关 TLS 文件                                                                                                                                                                                                                                                                                                                                                                                 |
| `SANDLANE_TOOL_MCP_BIND` / `_PORT`                       | 是   | MCP TLS 服务监听 IP 和端口                                                                                                                                                                                                                                                                                                                                                                        |
| `SANDLANE_TOOL_MCP_HOSTNAME`                             | 是   | 沙箱请求使用、并由服务校验的主机名                                                                                                                                                                                                                                                                                                                                                                |
| `SANDLANE_TOOL_MCP_TLS_KEY_FILE` / `_TLS_CERT_FILE`      | 是   | MCP 网关 TLS 文件                                                                                                                                                                                                                                                                                                                                                                                 |
| `SANDLANE_MODEL_FUNCTION_INVENTORY`                      | 否   | 每个 harness 的模型可见 MCP 函数 JSON；默认由启用工具推导。命名分别为 Codex `mcp__server.tool`、Claude Code/Qwen Code `mcp__server__tool`、OpenCode `server_tool`（工具名中的点转下划线）。显式配置时必须包含各 Harness 启用的控制面工具，否则 Worker 启动失败并列出缺少函数；不用时从 `SANDLANE_ENABLED_TOOLS` 去掉。没有列出的 harness 不检查（它没有任何可用函数） |
| `SANDLANE_MODEL_FILE_FUNCTION_INVENTORY`                 | 否   | 每个 harness 在文件模式额外放行的内置函数 JSON                                                                                                                                                                                                                                                                                                                                                    |
| `SANDLANE_MODEL_MESSAGES_AUTH`                           | 否   | `x-api-key`、`bearer` 或 `both`，默认 `x-api-key`                                                                                                                                                                                                                                                                                                                                                 |
| `SANDLANE_MODEL_MAX_OUTPUT_TOKENS`                       | 否   | 单次模型输出上限，默认 32000                                                                                                                                                                                                                                                                                                                                                                      |
| `SANDLANE_MODEL_GATEWAY_TIMEOUT_MS`                      | 否   | 单次流式模型调用超时，默认 600000 ms                                                                                                                                                                                                                                                                                                                                                              |
| `SANDLANE_TOOL_TARGET_REF` / `_VERSION`                  | 否   | 工具部署审计标识，version 默认 1                                                                                                                                                                                                                                                                                                                                                                  |

网关并发按 `SANDLANE_CONCURRENCY × 4` 推导，模型最多 64、MCP 最多 32。`NODE_EXTRA_CA_CERTS`
可用于受信任的私有 CA；禁止设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`，Purefect 控制面会拒绝这种配置。

## Broker

| 变量                                   | 必填             | 说明                                                               |
| -------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `SANDLANE_BROKER_NODE_ID`              | 是               | 节点 ID                                                            |
| `SANDLANE_BROKER_SOCKET`               | 是               | 对 Worker 提供的 Unix socket 绝对路径                              |
| `SANDLANE_BROKER_SERVICE_TOKEN[_FILE]` | 是               | Unix socket 应用层认证 Secret                                      |
| `SANDLANE_BROKER_STATE_DIR`            | 是               | 分配 ledger 与锁目录的绝对路径                                     |
| `SANDLANE_BROKER_DOCKER_SOCKET`        | 是               | Docker Unix socket 绝对路径                                        |
| `SANDLANE_BROKER_RUN_IMAGES`           | 是               | harness 到 sha256 固定镜像的 JSON 对象                             |
| `SANDLANE_BROKER_NETWORK_MODE`         | 否               | `none` 或 `isolated`，默认 `none`；当前 Worker 组合要求 `isolated` |
| `SANDLANE_BROKER_RELAY_BINDING`        | isolated 必填    | Relay 容器绑定 JSON                                                |
| `SANDLANE_BROKER_MANAGED_GATEWAYS`     | 当前 Worker 必填 | `modelBaseUrl` 与 `mcpUrl` 的固定网关 policy JSON                  |
| `SANDLANE_BROKER_MAX_CONCURRENT`       | 否               | 节点并发，默认 5                                                   |
| `SANDLANE_BROKER_PER_TENANT`           | 否               | 每租户并发，默认 2 且不超过节点并发                                |
| `SANDLANE_BROKER_WORKSPACE_MIB`        | 否               | `/workspace` tmpfs，64–4096 MiB，默认 96                           |
| `SANDLANE_BROKER_RUN_MEMORY_MIB`       | 否               | harness 到容器内存 MiB 的 JSON；未列出默认 512                     |
| `SANDLANE_BROKER_SOCKET_GROUP_ID`      | 否               | 允许连接 socket 的数值 gid；默认只有 owner                         |
| `SANDLANE_BROKER_DOCKER_API_VERSION`   | 否               | Docker API 版本，默认 `v1.45`                                      |
| `SANDLANE_LABEL_PREFIX`                | 否               | Docker 资源标签前缀，默认 `cn.purefect.sandlane`                   |

Broker 只在 Linux 运行。镜像未配置、未固定 digest 或 harness 未内置时拒绝分配；不回退到宿主 CLI。

## Relay

`SANDLANE_RELAY_ROUTES` 是路由数组：

```json
[{ "listenHost": "0.0.0.0", "listenPort": 19443, "upstreamHost": "worker", "upstreamPort": 19443 }]
```

每项只能包含 `listenHost`、`listenPort`、`upstreamHost`、`upstreamPort`。Relay 只转发配置好的
TCP 目的地，不读取 Run capability、Provider key 或 Purefect token。

## 状态面板与记忆

状态面板默认关闭；设置 `SANDLANE_STATUS_PORT` 后启用。`SANDLANE_STATUS_BIND` 默认
`127.0.0.1`，`SANDLANE_STATUS_RUN_IDS` 默认 `hash`，`SANDLANE_STATUS_RECENT_RUNS` 默认 50。
非 IP Host header 需列入 `SANDLANE_STATUS_HOSTS`。公网或共享网络部署必须设置
`SANDLANE_STATUS_TOKEN[_FILE]`，并参阅[状态面板](./status-panel.md)。

内置记忆默认关闭。启用需同时设置 `SANDLANE_MEMORY_ENABLED=true`、绝对路径
`SANDLANE_MEMORY_DIRECTORY` 与 `SANDLANE_MEMORY_TOPOLOGY=single-host`。可选摘要模型使用
`SANDLANE_MEMORY_SUMMARY_BASE_URL`、`_MODEL` 和 `SANDLANE_MEMORY_SUMMARY_KEY[_FILE]`；任一摘要
配置存在时三项都必须有效。详见[记忆接入](./memory.md)和[轻量实现](./memory-lite.md)。
