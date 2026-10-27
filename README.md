<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  Purefect SandLane 的项目入口、架构说明和使用导航。
-->

# Purefect SandLane

Purefect SandLane 在隔离容器中运行 Codex、Claude Code 等 Agent CLI。Worker 主动从控制面领取
Run；模型请求和 MCP 工具调用经过进程内网关，Provider key 与用户令牌不会进入沙箱。CLI
容器只持有当前 Run 的短期模型与工具 capability。

仓库同时提供控制面无关的 `@purefect/sandlane/runtime` composition API，以及开箱即用的 Purefect
composition root。通用入口由部署者注入 `ControlPlane`、`ContextProvider`、`SandboxProvider`、
模型/工具网关服务和资源生命周期；它不读取环境变量，也不导入 Purefect 插件。当前命令行 Worker
`dist/bin/worker.js`（`npm run runtime:purefect`）仍是 Purefect 专用入口。

项目采用 [Apache License 2.0](./LICENSE)，附加声明见 [NOTICE](./NOTICE)。SandLane 只启动由部署者
安装的第三方 Agent CLI；CLI、模型与服务仍受各自许可和条款约束。Claude Code 的多租户使用限制见
[Claude Code 支持](./docs/claude-code.md)。

[![CI](https://github.com/purefect-labs/purefect-sandlane/actions/workflows/ci.yml/badge.svg)](https://github.com/purefect-labs/purefect-sandlane/actions/workflows/ci.yml)

## 当前入口

先执行 `npm ci && npm run build`，再按部署拓扑启动：

| 进程            | 入口                       | 职责                                                                     |
| --------------- | -------------------------- | ------------------------------------------------------------------------ |
| Purefect Worker | `npm run runtime:purefect` | claim / sync / complete，Run 凭据登记，模型与 MCP TLS 网关，驱动 Harness |
| Broker          | `npm run broker`           | Linux 节点上的 Docker 分配、容量、租约、输入文件写入和清理               |
| Relay           | `node dist/bin/relay.js`   | 隔离 Docker 网络到 Worker 两个网关的固定 TCP 路由                        |

版本 tag 会通过 GitHub Actions 发布多架构镜像 `ghcr.io/purefect-labs/purefect-sandlane-runtime`
和 `ghcr.io/purefect-labs/purefect-sandlane-relay`。本地构建与发布规则见[安装与启动](./docs/installation.md)。

这些入口不自动读取 `.env.local`。使用 `node --env-file=.env.local ...`、systemd
`EnvironmentFile` 或容器平台 Secret 显式注入配置。完整变量与 Secret 文件规则见
[配置参考](./docs/configuration.md)，部署顺序见[安装与启动](./docs/installation.md)。

可选状态面板是只读运维界面，不是任务提交 API；运行入口以本节表格和 `package.json` 为准。

## 架构

```text
Purefect Engine (PAPI claim / sync / complete)
                  |
                  v
Worker process
  +-- execution lanes + in-memory Run credential registry
  +-- TLS model gateway ------> leased upstream model
  +-- TLS MCP gateway --------> Purefect APIs as the Run user
  +-- Unix socket ------------> node-local Broker
                                    |
                                    v
                              ephemeral CLI container
                              - read-only root filesystem
                              - tmpfs workspace/state
                              - model + tool capabilities only
                              - no direct Internet access
                                    |
                              isolated network
                                    |
                                    v
                              fixed-route Relay
                                    |
                          model gateway + MCP gateway
```

## 接入其他控制面

`@purefect/sandlane/runtime` 导出 `createRuntime(options)`。调用方显式提供控制面、沙箱、凭据登记表、
lane 配置、监听端点和其他需要随运行时关闭的资源；返回的 handle 提供 `drain()`、`close()` 和 `done`。
协议类型从 `@purefect/sandlane/spi/*` 子路径导入。该 API 只负责进程生命周期与执行 lane 组装，不替
调用方选择上游模型、工具实现、网络拓扑或业务提示。

Broker 本身支持 `none` 或 `isolated` 网络；当前 Worker composition 要求 managed gateways ready，
因此使用 `isolated`、Relay binding 和 managed gateway policy。Relay 不持有 Provider key、用户令牌
或 Run 凭据。模型联网搜索由模型网关按租约策略收窄，并不向沙箱开放任意网络。

控制面下发的 `agent_token` 与模型 API key 只保存在 Worker 内存。Worker 为每个 Run 生成相互独立的
模型和工具 capability，网关把 capability 绑定到 Run、协议、用途和租约有效期；Run 结束、租约丢失
或撤销时立即失效。

## 沙箱与文件模式

Broker 使用按 digest 固定的 CLI 镜像。容器以非 root 用户运行，根文件系统只读，丢弃 Linux
capabilities 并启用 `no-new-privileges`；工作区、临时目录和 CLI 状态使用有上限的 tmpfs。资源限制、
并发和每租户容量由 Broker 配置。

只有租约带会话文件时才进入文件模式。Worker 在宿主下载短期 HTTPS 文件，经 Broker 在 CLI 启动前
写入 `/workspace/inputs`，并附 manifest；此时 CLI 获得读文件与命令行工具。文件内容不可信，仍可能
通过提示注入诱导 CLI 操作当前 Run 的工作区或调用当前 Run 已获授权的能力。边界和残余风险见
[Security](./SECURITY.md) 与[配置参考](./docs/configuration.md#文件模式读文件与命令行)。

## 快速验证

```bash
npm ci
env -u NODE_OPTIONS npm run check
npm run format:runtime:check
npm test
```

`npm test` 会先构建再运行 `node:test` 测试。它不启动 Docker 容器，也不调用真实模型或 Purefect
服务。仓库中的 Docker/原生 CLI 验证脚本是显式的集成工具，不属于默认测试命令。

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

## 当前限制

- 随仓库提供的命令行 Worker 仍直接装配 Purefect 插件；其他控制面使用通用 composition API 自行组装。
- Worker 不持久化作业状态。进程中止后不重放 prompt；已开始 Run 的最终状态由控制面仲裁。
- 内置 SQLite 记忆实现只适用于单主机；共享部署需要外部实现。
- 当前端到端 Docker / Engine 验收不在默认 CI 中；上线前必须在目标 Linux 节点验证镜像、Relay、
  TLS、资源上限、关停和租约丢失路径。
