<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  Purefect SandLane 的项目概览、架构与使用指南。
-->

# Purefect SandLane

[English](./README.en.md) | [简体中文](./README.md)

Purefect SandLane 是面向多租户、多用户控制面的自托管 Agent CLI 执行平面。它在临时容器中运行 Codex、Claude Code 等工具，同时将模型服务商 API key 和用户令牌保留在可信的 Worker 进程内。

Worker 从控制面领取 Run，只向每个沙箱提供短期且限定于当前 Run 的 capability。模型请求和 MCP 工具调用经过网关校验后才会转发到上游。SandLane 由此将不可信的 CLI 执行与长期凭据、业务系统隔离，并且不需要向 CLI 容器开放直接互联网访问。

[![CI](https://github.com/purefect-labs/purefect-sandlane/actions/workflows/ci.yml/badge.svg)](https://github.com/purefect-labs/purefect-sandlane/actions/workflows/ci.yml)

## SandLane 解决什么问题

当控制面需要代表不同用户或租户运行 Agent CLI 时，SandLane 提供以下执行层能力：

- 为每个 Run 提供临时、受资源约束的工作区
- 通过 Run 级 capability 访问获准的模型和 MCP 工具
- 将模型服务商凭据和用户令牌与沙箱进程隔离
- 感知租约的取消、清理与容量控制
- 与具体控制面无关的 runtime composition API
- 开箱即用的 Purefect 控制面集成

SandLane 适用于企业内部 AI 平台、云端开发环境、工作流自动化系统，以及需要为不同用户执行 Agent CLI，同时集中管理身份、授权、模型、工具和资源策略的 SaaS 产品。

## 运行组件

先执行 `npm ci && npm run build`，再按部署拓扑启动所需进程。

| 进程            | 入口                       | 职责                                                                                  |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| Purefect Worker | `npm run runtime:purefect` | claim、sync、complete，管理 Run 凭据，承载模型与 MCP TLS 网关，驱动 Agent CLI harness |
| Broker          | `npm run broker`           | 管理 Linux 节点上的 Docker 分配、容量、租约、输入文件写入和清理                       |
| Relay           | `node dist/bin/relay.js`   | 提供从隔离 Docker 网络到 Worker 两个网关的固定 TCP 路由                               |

版本 tag 会通过 GitHub Actions 发布多架构镜像：

- `ghcr.io/purefect-labs/purefect-sandlane-runtime`
- `ghcr.io/purefect-labs/purefect-sandlane-relay`

这些入口不会自动读取 `.env.local`。请使用 `node --env-file=.env.local ...`、systemd `EnvironmentFile` 或容器平台 Secret 显式注入配置。当前部署要求见[安装与启动](./docs/installation.md)和[配置参考](./docs/configuration.md)。

可选状态面板是只读运维界面，不是 Run 提交 API。

## 架构

```text
控制面（claim / sync / complete）
                  │
                  ▼
Worker 进程
  ├── 执行 lane + 内存 Run 凭据注册表
  ├── TLS 模型网关 ─────────────────────► 租约指定的上游模型
  ├── TLS MCP 网关 ──────────────────────► 已授权的工具与 API
  └── Unix socket ──────────────────────► 节点本地 Broker
                                            │
                                            ▼
                                  临时 CLI 容器
                                  - 只读根文件系统
                                  - tmpfs 工作区与状态目录
                                  - 仅持有模型和工具 capability
                                  - 无直接互联网访问
                                            │
                                      隔离网络
                                            │
                                            ▼
                                      固定路由 Relay
                                            │
                                  模型网关 + MCP 网关
```

## 接入其他控制面

`@purefect/sandlane/runtime` 导出 `createRuntime(options)`。调用方显式提供 `ControlPlane`、`ContextProvider`、`SandboxProvider`、凭据注册表、执行 lane、网关端点，以及需要随 runtime 关闭的资源。返回的 handle 提供 `drain()`、`close()` 和 `done`。

协议类型从 `@purefect/sandlane/spi/*` 子路径导出。通用 runtime 只负责组装进程生命周期和执行 lane，不替调用方选择上游模型、工具实现、网络拓扑或业务提示，也不会读取环境变量或导入 Purefect 插件。

本仓库同时提供 Purefect composition root。当前命令行 Worker `dist/bin/worker.js`（`npm run runtime:purefect`）是 Purefect 专用入口。

## 隔离与凭据

仓库内置的 Broker 使用按 digest 固定的 CLI 镜像。容器以非 root 用户运行，根文件系统只读，丢弃 Linux capabilities，并启用 `no-new-privileges`。工作区、临时目录和 CLI 状态使用有容量限制的 tmpfs。Broker 按配置执行资源、并发和每租户容量限制。

控制面下发的 `agent_token` 和模型 API key 只保存在 Worker 内存。Worker 为每个 Run 创建相互独立的模型与工具 capability。网关将 capability 绑定到 Run、协议、用途和租约有效期；Run 完成、租约丢失或被撤销时，capability 随即失效。

Broker 支持 `none` 和 `isolated` 网络模式。仓库内置的 Worker composition 使用隔离网络、Relay binding 和 managed gateway policy。Relay 不持有模型服务商 key、用户令牌或 Run 凭据。模型托管的联网搜索由模型网关按租约策略收窄，不会赋予沙箱任意网络访问能力。

默认沙箱实现使用 Docker，提供容器级隔离边界。处理敌对租户或高度敏感任务的部署，可以实现 `SandboxProvider` SPI 并自定义 composition，引入租户独占节点、虚拟机、microVM 或其他更强的隔离机制。这些实现不包含在本仓库中，部署方必须独立验证资源约束、网络隔离、凭据清理、取消、租约丢失和故障恢复。

## 文件模式

只有租约包含会话文件时才启用文件模式。Worker 在宿主机下载短期 HTTPS 文件，Broker 在启动 CLI 前将文件及 manifest 写入 `/workspace/inputs`。此时 CLI 可以读取暂存文件并使用命令行工具。

文件内容不可信。提示注入仍可能诱导 CLI 修改当前 Run 的工作区，或调用已经为当前 Run 授权的 capability。信任边界和残余风险见 [Security](./SECURITY.md) 与[文件模式配置参考](./docs/configuration.md#文件模式读文件与命令行)。

## 快速验证

```bash
npm ci
env -u NODE_OPTIONS npm run check
npm run format:runtime:check
npm test
```

`npm test` 会先构建项目，再运行 `node:test` 测试套件。它不会启动 Docker 容器，也不会调用真实模型或 Purefect 服务。仓库中的 Docker 和原生 CLI 验证脚本属于显式集成工具，不在默认测试命令中运行。

## 文档

- [安装与启动](./docs/installation.md)
- [配置参考](./docs/configuration.md)
- [日常运维](./docs/operations.md)
- [执行内核与 Purefect 契约](./docs/control-plane.md)
- [联网访问](./docs/web-access.md)
- [Claude Code 支持](./docs/claude-code.md)
- [工具与页面动作](./docs/tools-and-page-actions.md)
- [状态面板](./docs/status-panel.md)
- [记忆接入](./docs/memory.md)
- [安全说明](./SECURITY.md)
- [开发与贡献](./CONTRIBUTING.md)

## 项目范围与当前限制

SandLane 是执行平面，不是完整的云平台。接入方控制面仍需负责身份、业务授权、持久化队列、计费、审计策略和通用调度。

- 仓库内置的命令行 Worker 直接装配 Purefect 插件；其他控制面需要使用通用 runtime API 自行组装。
- Worker 不持久化或重放 Run 状态。进程中止后不会重放 prompt；已经开始的 Run 由控制面仲裁最终状态。
- 内置 SQLite 记忆实现只适用于单主机；共享部署需要外部实现。
- 默认 CI 不包含端到端 Docker 与控制面验收。投入生产前，必须在目标 Linux 环境验证镜像、Relay、TLS、资源限制、关停行为、租约丢失路径和故障恢复。

## 许可证

Purefect SandLane 使用 [Apache License 2.0](./LICENSE)，其他归属与声明见 [NOTICE](./NOTICE)。

SandLane 只启动由部署者安装的第三方 Agent CLI。这些 CLI、模型服务商和所连接的服务仍受各自许可证与条款约束。Claude Code 多租户使用的相关事项见 [Claude Code 支持](./docs/claude-code.md)。
