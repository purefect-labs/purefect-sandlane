<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  Docker 沙箱实现边界与目标节点验证清单。
-->

# 沙箱验证

SandLane 的单元测试覆盖 Broker 生命周期、Docker API 交互、Relay、Harness transport、资源参数和安全
校验，其中 Docker API 与 Harness 使用 fake 实现。公共 CI 另行使用真实 Docker、Broker、Relay、TLS
模型网关和 MCP 网关运行独立 fixture，覆盖成功、取消与租约丢失；fixture 仍使用模拟 CLI 和模型。
这些检查通过不代表目标 Linux kernel、真实 CLI、真实模型、Purefect 控制面、网络、cgroup 或生产故障路径
已经完成端到端验收。

## 已实现边界

- Broker 是独立的 Linux 节点进程，独占 Docker socket、私有 state 目录和 Unix socket；Worker 只能
  通过 service token 调用固定的 allocate/inspect/renew/input/process/terminate 协议。
- CLI 镜像必须按 sha256 digest 固定，由内置 Harness launcher 决定 entrypoint 和环境；调用方不能
  覆盖镜像、命令、宿主挂载或任意环境变量。
- 容器使用非 root uid、只读根文件系统、capability drop、`no-new-privileges`、有限 tmpfs、内存、
  CPU 和 PID；每个 Run 使用新的容器与 CLI 状态。
- 当前 Worker composition 只接受 managed gateways ready 的 Broker。CLI 使用隔离 Docker 网络，经
  Relay 的固定 TCP routes 到模型和 MCP TLS 网关，不能直连互联网。
- Broker 在 Docker create 前持久化 allocation intent；重复请求返回同一记录，启动时按归属标签和
  ledger 对账。旧分配会终止，不会自动重放业务任务。
- CLI 只有本 Run 的模型和工具 capability；Provider key、agent token、签名文件 URL 和 Broker token
  不进入容器。输入文件只能在进程启动前通过 Broker 写入。
- terminate、租约到期和 Broker shutdown 都会清理归属容器。容器停止只证明执行停止，不证明业务
  成功；最终状态由 Worker 事件与控制面 complete 仲裁。

## 仓库检查

```bash
npm ci
env -u NODE_OPTIONS npm run check
npm run format:runtime:check
npm test
```

这些命令不启动真实容器。无凭据 Docker fixture 使用 `npm run demo`，公共 CI 分别运行 `success`、
`cancel` 和 `lease-loss` 场景。`scripts/` 中的其他网络、attach、session process 和原生 CLI validation
脚本是显式集成工具；运行前逐个阅读其参数与副作用，不要对生产或共享 Docker daemon 执行。

## Linux 节点配置

Broker 的完整变量见[配置参考](./configuration.md#broker)。关键要求：

- `SANDLANE_BROKER_RUN_IMAGES` 的每个 harness 都使用完整 `@sha256:<digest>` 引用；
- state 与 socket 父目录由专用服务账号拥有、权限 0700；socket group 只授予 Worker 身份；
- `SANDLANE_BROKER_SERVICE_TOKEN_FILE` 使用该账号拥有的 0600/0400 文件；
- `SANDLANE_BROKER_NETWORK_MODE=isolated`，Relay binding 和 managed gateway URL 与实际容器网络一致；
- 工作区 tmpfs 小于相应容器内存限制，并为文档解析峰值预留宿主内存；
- 同一 state 目录只运行一个 Broker。已有 socket 或 state lock 时先证明旧进程已停止，不要直接删除。

启动示例：

```bash
node --env-file=/absolute/broker.env dist/bin/broker.js
```

## 目标环境验收

在不含生产数据的测试节点至少验证：

1. Broker 重启能对账并清理旧 allocation，第二实例不能抢同一 state lock；
2. 不在镜像映射中的 harness、非 digest 镜像、越权 allocation ref 和错误 token 都被拒绝；
3. 容器内 uid、只读根、capability、`no-new-privileges`、tmpfs、内存、CPU、PID 限制符合配置；
4. CLI 不能连接公网、宿主或任意同网容器，只能经 Relay 到两个指定 TLS 网关；
5. 证书主机名错误、过期 capability、租约丢失和 Relay 中断会失败关闭，不回退到明文或直连；
6. 文件输入只能在 CLI 启动前写入，重名、路径穿越、数量/大小超限和重复内容冲突均被拒绝；
7. SIGTERM、Worker 崩溃、Broker 崩溃、Docker API 超时和磁盘/内存耗尽后，不遗留可继续调用网关的
   capability 或失去归属的容器；
8. 日志与状态面板不出现 prompt、文件 URL、Provider key、agent token、capability 或工具参数/结果。

## 仍需部署方承担

- Docker 与共享 Linux kernel 不是 microVM；敌对或高敏感租户应使用独立节点或更强隔离。
- 镜像签名、SBOM、漏洞扫描、seccomp/LSM、rootless 模式和 daemon hardening 取决于部署供应链。
- Broker 的节点容量不是全局公平调度；多节点 admission 与业务租约权威仍在控制面。
- state ledger 不是业务事件存储。损坏或出现未知归属资源时应隔离节点并人工核查，不能自动认领。
- 日志保留、磁盘/inode 告警、备份、Secret 轮换和节点撤销需要部署平台配置。

Codex App Server 协议参考：<https://developers.openai.com/codex/app-server/>。实际兼容性必须针对固定的
CLI 镜像版本验证。
