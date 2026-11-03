<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  Worker、Broker 与 Relay 的健康检查、日志、更新和排障指南。
-->

# 日常运维

## 统一运维入口

使用仓库内置 managed Compose 时，从仓库根目录执行：

```bash
npm run server -- status
npm run server -- doctor
npm run server -- logs
npm run server -- logs --follow
```

工具优先读取 `/etc/sandlane`，并兼容既有 `/etc/purefect/sandlane`；也可通过
`--config-dir` 或 `SANDLANE_SERVER_CONFIG_DIR` 显式选择。`doctor` 不修改容器，检查 Compose、三个
长期服务、Broker health、Relay 实际身份与已保存 binding，以及已启用的本机状态面板。

`npm run server -- up` 会刷新 Relay binding 并可能在配置发生变化时重建服务。更新或变更 Relay、
镜像、网络、证书前仍须先从控制面停止新任务并 drain；统一入口不把业务生命周期判断隐藏在自动化里。
下文的底层检查和停止顺序仍是故障恢复依据。

## 进程与就绪状态

运行拓扑包含 Worker、Linux 节点 Broker，以及 `isolated` 网络模式下的 Relay。当前 Worker 组合要求
Broker 提供 managed gateways，因此实际部署需要 Relay。三个进程都应由 systemd、容器编排器或等价
进程管理器监督，不要依赖交互式 shell。

Worker 成功启动会输出结构化日志 `RUNTIME_STARTED`。在此之前它已确认 Broker ready、node id 匹配、
managed gateway 可用，并已监听模型和 MCP TLS 网关。Relay 启动失败只输出
`SANDLANE_RELAY_UNAVAILABLE`，Broker 启动错误应视为节点不可接活。

可选状态面板由 `SANDLANE_STATUS_PORT` 开启，提供 lane、Broker 容量、最近 Run 和网关计数；它是
只读运维界面，不是旧 `/health` 或任务 API。默认只绑定 loopback，共享网络必须配置 token。具体接口
和字段见[状态面板](./status-panel.md)。

## 日志与告警

Worker 将结构化执行日志写到 stdout，包括 `RUNTIME_STARTED`、`TIMING`、`TOOL_CALL`、输入文件结果、
内存准入和关闭事件。日志不应包含 prompt、工具参数/结果、Provider key、agent token、capability 或
签名下载 URL。由进程管理器收集、限制访问和轮转 stdout/stderr。

重点告警：

- `SANDLANE_STARTUP_FAILED`：配置、TLS 文件、PurefectClient 或 Broker 前置条件不满足；
- `CLAIM_DEFERRED`：宿主可用内存低于 `SANDLANE_ADMISSION_MEMORY_MIB`；
- `ADMISSION_MEMORY_UNKNOWN`：无法读取 Linux `/proc/meminfo`，内存准入未生效但仍会接活；
- `Broker reconciliation failed` / `Broker cleanup incomplete`：停止新调度并人工检查 Docker 资源与 state lock；
- `SANDLANE_RELAY_UNAVAILABLE`：隔离沙箱无法到达模型/MCP 网关。

排障输出中不要打印环境、Secret 文件内容、租约原文或上游响应正文。

## 安全停止与更新

先停止领取或从调度中摘除实例，再向 Worker 发送 SIGTERM。Worker 进入 drain：允许进行中 Run 完成，
超过 `SANDLANE_DRAIN_MS` 后取消剩余执行。Worker 退出后再停止 Broker；Broker 会停止其拥有的分配并
释放 state lock。最后停止 Relay。强杀 Worker 可能让已上报 `started` 的 Run 结果不确定，由控制面
仲裁，Worker 不会从本地重放 prompt。

更新前：

```bash
env -u NODE_OPTIONS npm run check
npm run format:runtime:check
npm test
```

部署时固定源码版本、npm lockfile 和 CLI 镜像 digest。契约升级须先按
[契约同步流程](./control-plane.md#契约同步流程)更新并验证仓库副本。不要在有活动 Run 时替换 Broker
state 目录、socket、Relay binding 或镜像映射。

启用原生会话复用的节点升级 CLI 时，先 drain，再关闭 `SANDLANE_NATIVE_SESSIONS` 并更新 Broker、Worker
和固定 digest 镜像；普通 Run 验收通过后才重新开启。CLI 版本不匹配会失败关闭，不应通过保留旧缓存或
放宽版本检查规避。关闭开关并重启 Worker 即可回滚该优化，不要删除 Broker state 目录。

## 持久化与恢复

- Worker 的 Run 凭据、事件缓冲和执行状态只在内存中，不做本地作业持久化。
- Broker 的 `SANDLANE_BROKER_STATE_DIR` 保存分配 ledger 和锁，用于启动对账；只允许 Broker 身份访问。
- CLI 的 `/workspace`、`/tmp` 和状态目录是每个 Run 的 tmpfs，容器停止即清空。
- 可选原生会话状态只在 Worker 有界内存缓存中，不跨 Worker/Broker 重启，也不是 Run 恢复或业务备份。
- 可选单机记忆存储位于 `SANDLANE_MEMORY_DIRECTORY/memory/memory.sqlite`；启用时单独备份并限制权限。
- 对话、Run 和最终状态的事实源在控制面，不在 SandLane 节点。

Broker state 不是业务备份，也不能复制到另一节点后并行启动。恢复时先确认旧 Broker 已停止，再由
同一节点的 Broker 持锁启动并对账 Docker 资源。

## 常见问题

### Worker 启动即失败

根据 `SANDLANE_STARTUP_FAILED` 中的变量名检查配置，不要输出变量值。常见原因是 Secret/TLS 文件
不是绝对路径、权限不是 0600/0400、Worker 与 Broker token 和 Purefect Secret 相同、node id 不匹配，
或 Broker 没有 managed gateway policy。

### Broker 拒绝 harness

确认 `SANDLANE_BROKER_RUN_IMAGES` 包含租约所选 harness，镜像引用带完整 sha256 digest，并且该
harness 是当前 build 内置的 Codex、Claude Code、Qwen Code 或 OpenCode launcher。Broker 不会回退到
宿主安装的 CLI，也不会在请求的 Harness 镜像缺失时自动改用其他 CLI。

### CLI 无法调用模型或工具

依次检查 Relay 进程和固定 routes、Broker relay binding、managed gateway URL、证书 SAN/hostname，
以及 Run 是否仍在租约期。不要为了排障关闭 TLS 验证或临时开放沙箱互联网。

### Run 在重启后没有恢复

这是当前语义。Worker 不持久化 prompt 或继续执行已开始 Run；控制面应把结果不确定的 Run 标记并
由产品流程决定重试。不要从 Broker ledger 推断业务完成状态。
