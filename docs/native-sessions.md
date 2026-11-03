# 原生会话复用（实验性）

连续对话可以选择恢复 CLI 自己的会话历史，包括此前的工具调用上下文。每轮仍创建新的 CLI 进程和 Run 凭据；不复用正在运行的任务，也不把多个请求并成一个 Run。默认关闭，未命中时沿用平台历史回放。

## 开启方式

更新 Worker 与 Broker 后，在 Worker 环境中设置：

```dotenv
SANDLANE_NATIVE_SESSIONS=true
```

Compose 已传入此变量。自定义组合根使用 `createManagedRuntime({ nativeSessions: true, ... })`。当前固定支持 Codex **0.154.0**、Claude Code **2.1.301**、Qwen Code **0.26.3** 和 OpenCode **1.19.5**。不支持该状态类型的旧 Broker 不会收到新授权字段，本轮按平台历史冷启动。

CLI 版本是经过验证的协议边界，不是兼容范围提示。开关开启后，镜像中的 Qwen Code、OpenCode 或 Claude Code 版本不匹配会让该 Run 失败关闭，不会用未知格式静默恢复；Codex 同样校验 app-server 版本。升级 CLI 前须重新完成兼容验证并更新实现，紧急回滚时关闭开关、重启 Worker 清空内存缓存，即恢复默认平台历史路径。

控制面须明确声明 `serialAppendOnlyConversations: true`：同会话串行执行，`run_no` 单调递增，历史只追加。上下文提供器须声明 `nativeSessionSafe: true`，遵守该 SPI 的输入构造契约。内置 Purefect 控制面与基础上下文已接入；个人记忆装饰器不启用此能力。将来增加历史编辑、删除或重新生成时，必须先补充失效协议或关闭该模式。

## 何时会复用

- 同一 Worker、租户、用户、成员身份及会话；来源为 `conversation`，本轮 `run_no` 恰好等于已缓存轮次加一。
- 前轮成功，沙箱确认停止，平台明确返回 `ACCEPTED`。失败、取消、租约丢失或结算不确定均不保留缓存。
- 原容器仍由同一 Broker 管理；容器释放、Worker/Broker 重启或换节点均退回平台历史。
- 模型、联网和审批策略兼容；之前开放过的工具在本轮仍存在且声明兼容。工具收窄或页面工具变化可能冷启动。
- 不处于文件模式，也未接入个人记忆装饰器。会话中已有文件或配置强制文件模式时不会启用。

本轮指令、页面上下文及工具授权仍按当前 Run 提供。历史内容不授予工具权限。命中后只追加当前问题，避免再次注入平台历史。

## 状态与资源边界

Worker 仅在内存中缓存一个受限的原生状态，不复制凭据、配置目录、数据库或整个工作区。Broker 在 CLI 通道关闭前读取状态，下轮启动前写入 tmpfs；路径白名单、禁止符号链接、字节限制与超时共同约束传输。

| Harness     | 受控状态                 | 恢复方式                    |
| ----------- | ------------------------ | --------------------------- |
| Codex       | 单个 rollout JSONL       | `thread/resume`             |
| Claude Code | 单个 session JSONL       | `--resume <session-id>`     |
| Qwen Code   | 单个 chat JSONL          | `--resume <session-id>`     |
| OpenCode    | 官方导出的单个 JSON 文件 | `import` 后 `run --session` |

状态带有 Harness kind，Broker 同时校验 Harness、会话 ID 和固定路径；不同 CLI 的状态不能互用。OpenCode 不复制内部 SQLite。Qwen Code 和 OpenCode 由镜像内受信任 shim 在原生模式下执行精确版本检查；Claude Code 从 init 帧校验版本；Codex 从 app-server 初始化结果校验版本。

| 项目               | 当前限制                                                        |
| ------------------ | --------------------------------------------------------------- |
| 单份原生状态       | 1 MiB，超限不缓存                                               |
| Worker 缓存预算    | 32 MiB；单租户 16 MiB                                           |
| 活跃传输预留       | 每轮 8 MiB，计入上述预算；另计缓存元数据预算                    |
| 空闲 TTL           | 5 分钟                                                          |
| 同一恢复链最长寿命 | 1 小时                                                          |
| 请求预算保护       | 任一模型请求超过 128,000 字节或 256 个 input item，本轮不再缓存 |
| 终局回答预算       | JSON 编码超过 32,000 字节或被 Worker 截断，本轮不再缓存         |

预算用于约束本功能的缓存和传输，并非整个 Worker RSS 上限。预算不足时淘汰闲置缓存或不启用本轮缓存。缓存不落盘、不跨 Worker 共享，也不新增卷或持久化 ledger。

恢复写入异常或 resume 失败时，本轮报错，不自动重新执行用户任务；尤其不能在业务工具可能已执行后自动重放。明确的容器/进程代次不匹配则可在执行前直接冷启动。导出失败只丢弃缓存，不改变已经成功的业务结果。

原生历史可能含此前授权读取的原始工具结果。当前授权收窄、取消和过期会触发失效，但不提供逐条数据权限撤销通知，也不保证内存物理清零。要求权限变化后立即撤回全部历史数据的环境应保持关闭。

## 验证与运维

日志中的 `NATIVE_SESSION_CANDIDATE` 表示找到候选缓存，仍须 Broker 和 CLI 验证；`NATIVE_SESSION_COLD` 表示走冷启动，不等于故障。部署时先更新 Broker 和 Worker，保持开关关闭完成普通 Run 验收，再开启 Worker 开关。回滚时先关闭开关并重启 Worker 以清空缓存；不需要清理 Broker ledger 或 CLI 容器状态。

Codex 可使用本地已安装的固定 CLI 镜像运行无付费模型探针：

```sh
docker image inspect YOUR_CODEX_IMAGE --format '{{.Id}}'
NATIVE_SESSION_IMAGE=sha256:YOUR_LOCAL_IMAGE_ID npm run native:check
```

探针使用隔离 Docker 网络、真实 SandLane 模型网关、fixture 上游及假 MCP，并清理自己创建的资源。2026-11-03 在 linux/arm64、Codex 0.154.0 上验证了：跨进程恢复工具历史、新凭据和配置生效、恢复阶段无模型/工具执行、手动及自动压缩、生产 Driver 和状态读写辅助程序、符号链接拒绝。

同日使用本地 fixture 上游和固定 linux/arm64 镜像验证了 Claude Code 2.1.301、Qwen Code 0.26.3 和 OpenCode 1.19.5：两个独立 CLI 进程恢复同一 session，第二轮状态同时保留前后两轮内容，新的模型凭据不写入受控状态；OpenCode 使用官方 export/import。该验证不调用付费模型，不代表长期压力测试或生产认证。OpenCode 当前关闭其 compaction agent，因此只承诺有界状态内的历史延续，不承诺长会话自动压缩。

Codex 的压缩走自定义 provider 的 `/v1/responses`，未新增 `/compact` 路由；自动压缩阈值为 8,000 token。这不是字节限额保证，单个巨大工具结果仍可能使当前 Run 超限失败。默认测试覆盖缓存、隔离、停止与结算等组件边界；上述探针不替代真实 Engine 联调、目标 amd64 环境验收或长期压力测试。

平台历史回放与长期记忆扩展见[会话上下文与记忆](./memory.md)。
