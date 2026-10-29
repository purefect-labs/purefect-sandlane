# Purefect SandLane 产品定位与能力边界

> 适用版本：当前 `main` 工作树，更新日期 2026-10-29。
> 本文用于产品定位、能力沟通和对外表述校准，不替代安装、安全或 API 文档。
> “当前能力”以本仓库实现与验证为准；扩展接口不等于对应实现已经交付。

## 一句话定位

**Purefect SandLane 是面向企业数字员工与多租户控制面的开源、自托管、无头 Agent CLI 执行平面。**

它把 Codex、Claude Code、Qwen Code 和 OpenCode 等 Agent CLI 放进按 Run 创建的临时沙箱，通过受控网关连接模型和业务工具，
让长期 API Key、用户令牌和业务系统访问凭据保留在可信 Worker 一侧。

从产品形态看，它是一套 **Headless Agent Harness**：不强绑定终端用户界面、账号体系或工作流产品，
而是通过控制面契约接收 Run，统一约束 Agent CLI、模型、工具和沙箱生命周期。
它同时保持轻量、可组合的边界：不在执行层重复建设上层平台已经拥有的 IAM、业务数据库、消息队列和流程产品。

更简短的对外副标题可以使用：

> 为企业数字员工提供可嵌入、可治理的 Agent CLI 执行底座。

## 产品类别与边界

SandLane 位于业务控制面与实际执行环境之间：

```text
业务控制面
身份、租户、授权、队列、审计策略、计费
        │
        │ Run / lease / user context
        ▼
SandLane 执行平面
领取与同步、临时沙箱、CLI Driver、模型网关、工具网关、清理
        │
        ├──────────► 模型服务
        └──────────► MCP / 企业业务 API
```

SandLane **不是**完整的 AI SaaS、聊天界面、通用工作流编排器或模型服务；它也不替代控制面的用户体系、
业务授权和持久化队列。它解决的是多用户 Agent CLI 被云端化以后，如何执行、隔离、授权、撤销和回收的问题。

这一区分是产品定位的关键：SandLane 不是把一个本地 CLI 简单装进容器，而是把 CLI 变成可由控制面治理的
执行单元。

### 如何理解“无头企业 Agent Harness”

- **无头（Headless）**：不要求采用 SandLane 自己的聊天界面、门户、IAM 或流程系统；Web、移动端、工单、IM、
  定时任务和工作流都可以成为上层入口。
- **企业（Enterprise-oriented）**：这里不是笼统的安全等级承诺，而是指多租户上下文、Run 级权限、租约与取消、
  容量限制、确认策略、私有部署和可观测性等面向企业集成的机制。
- **Harness**：将不同 Agent CLI 的启动、原生协议、事件、模型、工具和清理统一收束为控制面可调用的 Run。

推荐使用“面向企业控制面的无头 Agent Harness”或“面向企业数字员工的 Agent 执行底座”，不建议脱离具体
能力单独使用“企业级 Harness”。

## 面向谁

- 正在构建企业数字员工、智能岗位或人机协同工作体系的产品与平台团队
- 正在建设企业 AI 工作台、Agent 平台或内部 Copilot 的平台团队
- 需要在 SaaS 中代表不同租户、不同用户执行 Agent CLI 的产品团队
- 希望私有部署，并统一管理模型、工具、凭据和运行资源的组织
- 需要同时兼容国际模型、国内模型及多种 CLI，又不希望把平台绑定到单一厂商的团队

它不是面向个人开发者的 IDE 替代品，也不是开箱即用的终端聊天产品。个人用户可以运行 Demo，但产品价值主要
体现在被控制面集成后的多用户执行场景。数字员工的岗位定义、组织关系、记忆、流程编排、排班和绩效仍由上层
平台负责；SandLane 负责安全、可控地执行其中一次次 Agent Run。

## 解决的核心问题

### 1. 本地 Agent CLI 如何成为多用户云能力

Codex、Claude Code、Qwen Code、OpenCode 等工具原本面向本地交互。云端平台需要补齐任务领取、租约、并发、取消、事件同步、资源限制
和异常清理。SandLane 将这些执行语义放在统一 runtime 中，控制面不必直接管理每个 CLI 进程和容器细节。

### 2. 如何不把长期凭据交给不可信执行环境

模型 API Key、用户令牌保留在可信 Worker 内存。沙箱只获得当前 Run 的短期 capability；模型和工具网关逐次检查
Run、用途、协议、运行时分配和租约。Run 完成、租约丢失或撤销后，capability 随即失效。

### 3. 如何让不同 CLI、模型和业务工具组合，而不是彼此绑定

CLI Driver、模型上游和工具 Provider 是分开的扩展点。当前内置 Codex、Claude Code、Qwen Code 与
OpenCode；模型侧支持 Responses 和 Anthropic Messages 两条协议；工具侧支持 Purefect 工具以及管理员配置的 HTTP / stdio MCP。

### 4. 如何让 Agent 使用业务能力，但不获得任意网络访问

内置隔离拓扑下，沙箱没有直接互联网访问。模型请求、MCP 工具调用和受策略约束的模型联网搜索走固定 Relay 与
可信网关。身份来自 Run，不允许工具参数自行声明租户或用户来提升权限。

### 5. 如何融入企业已有 IT，而不是形成新的系统孤岛

企业通常已经拥有门户、IAM、租户与用户体系、审批流程、业务 API、日志平台和调度系统。SandLane 采用无头设计：
上层系统保留身份和业务决策权，通过控制面 SPI 驱动 Run；现有业务能力通过 MCP 或 `ToolProvider` 接入；执行层只
负责 CLI、模型、工具和沙箱生命周期。接入不要求企业迁移到一套新的终端界面或重建业务权限模型。

## 当前产品特性

### 面向控制面的执行语义

- `claim / readLease / sync / complete` 控制面 SPI
- Run 领取幂等、租约续期、取消和最终状态仲裁
- 增量事件同步、背压、断连恢复及用量归集
- Worker lane、节点并发、每租户容量和宿主内存准入
- 进程 drain、沙箱终止和遗留资源对账
- Purefect 平台参考集成，以及不依赖 Purefect 的 experimental managed runtime API

### Agent CLI Harness

- 内置 Codex Driver，使用 Responses 协议
- 内置 Claude Code Driver，使用 Anthropic Messages 协议
- 内置 Qwen Code 与 OpenCode Driver，使用 Responses；首版只开放 Run 授权的 MCP 工具
- 解析原生流式事件，统一输出文本、工具活动、用量和结束状态
- CLI 镜像按 digest 固定，启动配置由 SandLane 生成，而不是信任用户任意命令
- 可通过 `HarnessDriver` 与启动镜像约定扩展其他 CLI；新增 CLI 仍需开发和协议验证

### 模型接入与国内模型兼容

- CLI 与模型服务分开选择，同一 CLI 不固定绑定某个模型品牌
- 支持 Responses 和 Anthropic Messages 兼容上游，认证和上游地址由可信 Worker 管理
- DeepSeek `deepseek-flash` 已完成 Codex、Claude Code、Qwen Code 与 OpenCode 四种 CLI 的真实文本与 MCP 工具调用验证
- 智谱 GLM、通义千问 Qwen 已通过离线协议兼容测试，真实服务仍需按具体地域、套餐和模型验收
- `ModelUpstreamFactory` 可扩展不同认证方式或原生协议；Kimi、Gemini 等不能仅凭品牌名称宣称即插即用
- 模型凭据是 Run 级数据，因此底层能够执行不同用户使用不同 Key 的 Run；具体 Key 的存储、选择和下发由控制面负责

### MCP 与企业工具

- 外部 Streamable HTTP MCP Server
- Worker 内预安装或只读挂载的 stdio MCP 程序
- 多个沙箱可共享同一 MCP 服务或安装，同时按租户、用户 binding 选择凭据和工具白名单
- 支持组合已有 `ToolProvider`，Purefect Client 原有工具路径可继续使用
- 写操作可与控制面确认策略衔接；工具调用结果保留明确失败与未知结果的差异
- 提供把现有 Node.js 业务 SDK 包装成独立 HTTP MCP 服务的最小模板

### 沙箱、网络与凭据

- 当前内置 Docker 沙箱，每个 Run 使用独立临时容器
- 非 root 用户、只读根文件系统、丢弃 Linux capabilities、`no-new-privileges`
- 工作区、临时目录和 CLI 状态使用有容量限制的 tmpfs
- 模型和工具 capability 彼此分离，只对当前 Run、协议和租约有效
- `isolated` 网络模式下，沙箱只经 Relay 到达模型与工具网关
- 文件输入由 Worker 下载、Broker 写入；输出在 CLI 停止后按限制收集并交回控制面
- `SandboxProvider` 可用于接入独立节点、虚拟机或 microVM，但本仓库当前没有内置这些实现

### 策略与可观测性

- 模型托管的联网搜索按 Run 策略关闭、开放或收窄到域名 allowlist
- 可选只读状态面板展示 lane、Run 阶段、资源和活动摘要
- 日志避免输出 API Key、用户令牌、prompt、工具参数和模型正文
- 无凭据 Docker Demo 覆盖真实 Broker、Relay、TLS 网关、模型流和 MCP 工具链路
- 交互 Demo 可显式使用实际 CLI 镜像和用户配置的模型服务

### 开源与部署

- Apache License 2.0
- 自托管，核心执行路径不依赖 Purefect Engine 或同级私有仓库
- 提供带类型的 Node.js 包导出、Dockerfile、Compose 参考拓扑和多架构容器发布工作流
- Purefect 是参考控制面，不是 SandLane 唯一可以连接的控制面

### 无头嵌入与企业 IT 集成

- 不内置或强制终端用户门户，允许现有 Web、移动端、IM、工单和自动化流程作为入口
- 控制面 SPI 让既有平台继续负责 IAM、租户、用户、业务授权、队列、审计策略和计费
- Run 携带的身份与授权上下文驱动模型、工具、文件和联网策略，不由沙箱自行选择身份
- HTTP / stdio MCP、`ToolProvider` 和 SDK-to-MCP 模板用于连接现有业务系统
- 自托管部署便于纳入企业自己的网络、Secret 管理、镜像治理和运维体系
- 实际集成仍需开发控制面适配器，并按企业 IAM、审计和高可用要求完成部署验收

## 最值得突出的八个亮点

### 1. 凭据不进入 Agent 沙箱

很多沙箱产品解决“代码不能碰宿主机”，但企业 Agent 还存在另一层问题：执行环境需要调用模型和业务系统。
SandLane 将长期模型 Key、用户令牌留在 Worker，只给沙箱短期、限 Run 的 capability。这是它相对于通用代码沙箱
最有辨识度的能力。

推荐表达：

> 沙箱拿到的是本次运行的临时能力，而不是平台的长期密钥。

### 2. 无头 Harness，嵌入已有入口而不是另建一套门户

SandLane 没有要求企业采用新的聊天 UI、账号体系或工作流。门户、IM、工单、定时任务或数字员工平台可以继续
作为控制面，通过统一 Run 契约调用执行能力。这让 SandLane 更像企业 AI 基础设施，而不是另一个业务应用。

### 3. 为 Agent CLI 设计，而不是只提供一个空容器

SandLane 理解四种内置 CLI 固定版本的结构化事件、工具调用、取消和用量语义。平台得到的是可治理的 Run，
不只是一个需要自行远程执行命令的容器。

### 4. CLI、模型、控制面三者解耦

控制面决定谁可以运行以及 Run 的上下文；Harness Driver 决定如何驱动 CLI；模型网关决定如何访问上游。
这使平台可以保留不同 Agent CLI 的交互能力，同时选择 DeepSeek 等兼容模型，也可以通过显式 Driver 扩展新 CLI、
新模型协议或新控制面。

### 5. 企业工具沿受控通道接入

MCP 和 Purefect 工具经统一工具网关调用，身份取自 Run，凭据在可信侧选择。业务系统不需要向沙箱暴露长期 token，
平台也能继续执行用户权限和确认策略。

### 6. 默认关闭沙箱任意出网

模型、工具和联网搜索各走明确路径。相比“把 API Key 注入容器，再允许容器访问互联网”，这一设计更容易说明
数据流向、撤销权限和审计责任。

### 7. 为数字员工提供执行底座，而不是替代数字员工平台

数字员工需要岗位身份、任务来源、记忆、流程和业务权限，也需要一个真正执行模型推理、文件处理与系统操作的
运行环境。SandLane 聚焦后者：已有平台实现控制面 SPI，即可复用执行 lane、网关、Driver、Broker 与沙箱生命周期。
这种克制的边界使它适合作为数字员工平台的基础组件，而不是要求企业更换上层产品。

### 8. 轻量、可组合，可以渐进式引入

SandLane 不捆绑门户、IAM、业务数据库或消息队列。开发和体验可以从 Node.js、Docker 与 Compose 起步；已有平台
可以先接一个控制面适配器，再按需要增加 MCP、模型适配和更强沙箱后端。这里的“轻量”指职责边界和部署起点，
不代表生产环境零依赖，也不代表已经证明其镜像体积、资源占用或启动速度优于其他产品。

## 典型使用场景

### 企业数字员工执行底座

数字员工平台负责岗位、组织、记忆、任务编排和人机协同；SandLane 接收其中的具体 Run，在临时沙箱中驱动 Agent
CLI，按该 Run 的身份访问模型、文件和获准业务工具，并回传过程事件与结果。适用于需要连接 CRM、ERP、知识库、
工单或数据服务的运营、财务、销售支持、客户服务和内部协作场景。

SandLane 本身不定义“某个数字员工是谁”，也不保证某项业务动作天然有权限；这些仍由控制面与业务系统决定。

### 企业多用户 AI 工作台

用户从统一入口发起任务，控制面决定模型、工具、文件和权限；SandLane 在独立沙箱中运行 CLI，并持续回传结果。
适合知识工作、数据分析、文档处理和需要调用内部系统的综合任务。

### SaaS 内嵌 Agent 能力

SaaS 厂商保留自己的租户、用户和计费体系，只把每次 Agent 执行交给 SandLane。不同租户可以使用不同模型配置、
工具绑定和容量策略。

### 国内模型与既有 Agent CLI 组合

在服务商提供兼容协议且通过实际验收时，Responses 路径可复用 Codex、Qwen Code 或 OpenCode Driver，
Anthropic Messages 路径可复用 Claude Code Driver，减少为每个模型品牌重新开发一套 Agent runtime 的成本。
DeepSeek 已完成四种内置 CLI 的真实冒烟；GLM、Qwen 模型服务仍须按地域、套餐和具体模型验收。

### 私有化业务工具接入

通过 HTTP / stdio MCP 或既有 ToolProvider 连接 CRM、ERP、知识库和内部 API。共享安装与按身份绑定可以并存，
避免每个沙箱重复安装完整工具链。

### 受控文件处理

控制面向 Run 提供临时文件，CLI 在隔离工作区内读取、转换和生成结果；文件工具只在明确启用的 Run 中开放。

## 与相邻产品的客观比较

比较基于各项目截至 2026-10-28 的官方公开说明。不同产品覆盖层级不同，不宜用单一“优于”关系概括。

| 产品                               | 主要定位                                                                                             | 与 SandLane 的共同点                         | 主要差异                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E2B**                          | 云端隔离沙箱基础设施；SDK 提供命令、代码解释器和桌面能力，使用 Firecracker microVM，也提供自托管 runtime 指引                          | 都面向不可信 AI 代码执行，支持隔离环境和程序化生命周期           | E2B 首要抽象是通用 Sandbox；SandLane 首要抽象是带租约、CLI 协议、模型与工具 capability 的 Run。E2B 直接提供 microVM 云服务、代码解释器和桌面 SDK；SandLane 当前不提供这些产品面，更强调控制面身份、模型 Key 和业务 token 不进入 CLI 容器 |
| **Daytona**                      | AI 生成代码和 Agent workflow 的完整 sandbox 平台，提供持久环境、快照、SDK、终端、VNC、Computer Use 和平台治理                   | 都支持自托管语境、多会话／多用户执行和资源治理                 | Daytona 更接近功能丰富的“远程计算机平台”，持久化与交互能力更全面；SandLane 范围更窄，聚焦 Agent CLI 的短期 Run、模型／工具网关和凭据撤销。其原开源仓库已声明自 2026-06 起停止维护、核心转为私有代码，比较开源能力时需要注明这一变化                        |
| **Modal Sandboxes**              | Modal 托管云上的可编程隔离计算，覆盖镜像、资源、命令、超时、网络、Secret 和文件系统快照                                               | 都能按任务创建受资源约束的临时环境                       | Modal 是通用托管计算能力，弹性基础设施和 SDK 体验更完整；SandLane 可完全自托管、开源，并内置 Agent CLI Driver、Run capability、模型代理和 MCP 权限链路                                                        |
| **Kubernetes SIG Agent Sandbox** | Kubernetes 上隔离、持久、单例 workload 的标准化 CRD 和控制器，支持稳定身份、持久卷、Warm Pool，并委托 gVisor/Kata 等 runtime 做底层隔离 | 都为 Agent workload 管理生命周期，并允许替换更强隔离实现    | Kubernetes 项目解决 Sandbox 编排与持久状态，不理解具体 CLI、模型或业务工具授权；SandLane 解决 Agent Run 语义和可信网关，当前 Docker 实现更容易起步但隔离强度较低。两者可以组合，由后者充当未来的 `SandboxProvider` 后端                |
| **OpenHands Agent Canvas**       | 自托管的开发者控制中心，可运行 OpenHands、Claude Code、Codex、Gemini 及 ACP Agent，并提供 UI、自动化和多种后端                   | 都支持多种 coding agent / CLI、自托管和 Docker 执行 | OpenHands 更靠近最终用户和工作流控制面，包含会话 UI 与自动化；SandLane 更靠近平台基础设施，不提供产品 UI，重点是多租户 Run、凭据隔离和模型／工具网关。两者存在竞争面，也存在将 Canvas 类产品作为上层控制面的组合空间                                  |
| **Agent-Sandbox**                | 基于 Kubernetes 的自托管 sandbox API，强调多租户、持久化、Pool、暂停恢复、快照、桌面和 E2B 兼容                                 | 都是开源、自托管并面向多租户 Agent 执行                 | Agent-Sandbox 提供更通用、更丰富的 sandbox 生命周期和桌面能力；SandLane 不追求 E2B API 或通用远程桌面，优势仍在 Agent CLI 原生协议及模型／MCP 凭据治理。需要 Kubernetes 的前者与当前可在单机 Docker 起步的 SandLane，部署门槛也不同   |

### 不是完全同类、但经常被一起评估的方案

- 直接使用 Docker / Kubernetes Job：能启动容器，但 Agent CLI 协议、Run 租约、凭据网关、工具授权和事件同步需要平台自行建设。
- Agent 框架（如 LangGraph、AutoGen 一类）：主要编排 Agent 逻辑，不自动提供 SandLane 的 CLI 容器隔离与可信凭据边界。
- 模型 API Gateway：能统一模型认证和路由，但通常不负责 Agent CLI 进程、工具 capability、文件工作区和沙箱回收。
- 工作流系统：擅长持久任务和重试，可以成为控制面的一部分，但不是执行不可信 Agent CLI 的完整安全边界。

## SandLane 的竞争优势

### 优势成立的前提

SandLane 的优势不在“沙箱数量最多”“启动最快”或“隔离最强”。目前没有跨产品基准支持这些结论。其优势是
**围绕企业 Agent CLI 云端化，把执行语义、凭据边界、模型接入和业务工具通道放在一个可自托管的开源执行层中**。

具体表现为：

1. **Agent 专用而不是通用容器 API**：控制面直接处理 Run、事件、租约、取消和用量。
2. **双重隔离思路**：容器隔离执行代码，可信网关隔离长期凭据与业务身份。
3. **模型与 CLI 可独立演进**：兼容协议模型可以复用 Driver，特殊协议可增加上游适配器。
4. **业务工具不是沙箱内的静态 Secret**：MCP / ToolProvider 在可信侧按 Run 身份选择 binding。
5. **对现有平台侵入较小**：控制面 SPI 保留上层产品的身份、授权、队列和界面主权。
6. **国内模型接入路径清楚**：不笼统宣称“兼容所有 OpenAI API”，而是区分 Responses、Messages 与仅 Chat Completions 的差异。
7. **可从单机 Docker 起步**：无需先部署 Kubernetes；需要更强隔离时再实现其他 `SandboxProvider`。
8. **适合作为数字员工执行底座**：上层定义岗位与流程，SandLane 复用同一受控 Harness 执行不同类型的 Run。
9. **轻量且可组合**：不重复捆绑 UI、IAM、业务数据库、消息队列和工作流，可按现有 IT 边界渐进接入。

## 当前短板与不应夸大的地方

- Docker 容器不是 microVM 安全边界。敌对租户或高敏感任务应采用独立节点、VM、microVM 或其他已验证隔离方案。
- 内置沙箱是临时 Run，不提供 E2B、Daytona、Agent-Sandbox 那类完整持久计算机、暂停恢复和快照产品能力。
- 当前没有通用 Browser / Desktop / VNC / SSH 产品面。
- 当前不提供 Kubernetes 编排器、跨区域调度、自动扩缩容或托管云服务。
- 当前内置四种 CLI；新增 CLI 仍须实现显式 Driver、固定镜像并完成真实协议验证，不支持运行时加载任意 Harness 插件。
- 不是所有“OpenAI compatible”模型都支持 Responses，也不是所有模型都正确实现 Claude Code 所需的 Messages 与工具语义。
- managed runtime API 仍标注 experimental；投入生产前需要在目标 Linux、控制面、CLI 版本和故障场景下验收。
- 多租户身份、用户模型 Key 配置、计费和审计策略最终仍由上层控制面提供。
- “轻量”不等于生产零依赖：仍需 Docker、TLS、Secret 管理、控制面和目标环境运维。

对外介绍应同时说明这些边界。客观陈述比使用“企业级安全”“支持所有模型”等不可验证的口号更容易建立可信度。

## 参考资料

### SandLane 当前实现与文档

- [项目概览](../README.md)
- [架构与控制面契约](./control-plane.md)
- [独立控制面接入](./standalone.md)
- [模型接入与验证状态](./model-providers.md)
- [MCP 安装与接入](./mcp.md)
- [配置与安全约束](./configuration.md)
- [独立 Demo](./demo.md)
- [安全说明](../SECURITY.md)

### 相邻产品官方资料

- [E2B README](https://github.com/e2b-dev/E2B) 与 [Security](https://e2b.dev/docs/security)
- [Daytona README](https://github.com/daytonaio/daytona)（包含 2026-06 后原开源仓库停止维护的声明）
- [Modal Sandboxes](https://modal.com/docs/guide/sandbox)
- [Kubernetes SIG Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
- [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands)
- [Agent-Sandbox](https://github.com/agent-sandbox/agent-sandbox)

竞品功能和许可状态会变化。若长期公开展示比较表，应标注核对日期，并在发布前重新检查对应官方资料。
