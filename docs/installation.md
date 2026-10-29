<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  Worker、Broker 与 Relay 的安装和启动指南。
-->

# 安装与启动

当前 SandLane 由 Worker、Linux 节点 Broker，以及隔离网络模式下的 Relay 组成。仓库没有一条命令
自动部署整套生产拓扑；部署者需要提供 CLI 镜像、TLS 证书、Secret 和所选控制面配置。

首次体验请用[独立 Demo](./demo.md)：`npm ci && npm run demo`，不需要 Purefect 或模型凭据。
第三方接入见[公共 API](./standalone.md)。以下环境模板和 Worker 启动步骤针对
[Purefect 参考集成](./integrations/purefect.md)，不是独立运行的必需条件。

## 1. 环境要求

- 通用 runtime 支持 Node.js 20+；完整测试、Demo 和 SQLite 记忆使用 Node.js 22+；
- `npm ci` 所需的 npm registry 访问；
- Broker 所在节点为 Linux，安装 Docker Engine 28+，并允许 Broker 访问 Docker Unix socket；
- 按 sha256 digest 固定的 Codex、Claude Code、Qwen Code 或 OpenCode CLI 镜像；
- Worker 模型网关和 MCP 网关使用的 TLS 私钥与证书；
- 可访问的 Purefect Engine HTTPS origin 和 PurefectClient 模块。

Agent CLI 运行在 Broker 创建的临时容器中。不要在 Worker 主机安装、登录或挂载个人
`CODEX_HOME` 作为运行凭据；模型凭据由每个租约提供并只保留在 Worker 内存。

## 2. 获取和构建

```bash
git clone https://github.com/purefect-labs/purefect-sandlane.git
cd purefect-sandlane
npm ci
env -u NODE_OPTIONS npm run check
npm test
```

`npm test` 已包含 TypeScript 构建。仅构建发行 JavaScript 可运行 `npm run build`。

runtime 与 relay Dockerfile 已提供按 digest 固定的 Node 基础镜像默认值；本机构建不需要额外传参：

构建与Compose文件位于[`deploy/`](../deploy/README.md)，以下命令从仓库根目录执行，构建上下文仍是根目录。

```bash
docker build -f deploy/Dockerfile.runtime -t purefect/ai-runtime:local .
docker build -f deploy/Dockerfile.relay -t purefect/sandlane-relay:local .
```

如需使用经过内部镜像仓库同步的基础镜像，可用 `--build-arg NODE_IMAGE=<image@sha256:digest>` 覆盖，
但生产构建仍应固定 digest，不能使用浮动 tag。

仓库的 `Container images` GitHub Actions 工作流会在推送与 `package.json` 版本一致的 `vX.Y.Z` tag
时发布以下 amd64/arm64 镜像，并生成 SBOM 与 provenance：

- `ghcr.io/purefect-labs/purefect-sandlane-runtime:<version>`；
- `ghcr.io/purefect-labs/purefect-sandlane-relay:<version>`；
- `ghcr.io/purefect-labs/purefect-sandlane-qwen-code:<version>`；
- `ghcr.io/purefect-labs/purefect-sandlane-opencode:<version>`。

仓库管理员也可从 Actions 手动触发并指定临时 tag。Qwen Code 和 OpenCode 使用固定的上游版本；
它们的镜像 tag 与 SandLane 发布版本一致，实际 CLI 版本见镜像 label 和发布说明。Codex 与 Claude Code
CLI 镜像不会由该流程公开发布；部署者须确认第三方版本和分发条款后自行构建并固定 digest。

## 3. 配置

`.env.example` 列出当前入口读取的变量和占位值：

```bash
cp .env.example .env.local
chmod 600 .env.local
```

应用不会自动读取该文件。生产环境优先通过容器平台 Secret 或 systemd `EnvironmentFile` 注入；
本地进程可使用 Node 的 `--env-file`：

```bash
node --env-file=.env.local dist/bin/worker.js
```

所有 `*_FILE` Secret 必须是绝对路径、由当前 uid 拥有的 0600/0400 普通文件；同一个 Secret
不能同时设置内联值与 `_FILE`。Worker 的 Purefect service secret 与 Worker/Broker service token
必须不同。具体变量见[配置参考](./configuration.md)。

## 4. 启动顺序

Compose 部署须同时使用 `deploy/compose.runtime.yaml` 和 `deploy/compose.purefect.yaml`，按照
[参考部署](./integrations/purefect.md#managed-compose-参考部署)先启动 Relay、核验并生成 binding，
再启动 Broker 和 Worker。基础清单不能单独满足 managed 网络要求。

### Relay（仅 isolated 网络）

Relay 部署在可以同时连接 CLI 隔离网络和 Worker 网关的基础设施容器中。配置固定的
`SANDLANE_RELAY_ROUTES` 后运行：

```bash
node --env-file=.env.local dist/bin/relay.js
```

### Broker

Broker 必须在 Linux 执行节点启动。`SANDLANE_BROKER_RUN_IMAGES` 中每个镜像都必须固定到
`@sha256:<digest>`：

```bash
node --env-file=.env.local dist/bin/broker.js
```

Broker 创建 Unix socket 后执行启动对账。`isolated` 网络还必须配置
`SANDLANE_BROKER_RELAY_BINDING` 和 `SANDLANE_BROKER_MANAGED_GATEWAYS`；`none` 模式不允许这些配置。

### Worker

Broker ready 后启动 Worker：

```bash
node --env-file=.env.local dist/bin/worker.js
```

对应 npm scripts 为 `npm run broker` 和 `npm run runtime:purefect`；旧的 `runtime:execution` 暂作兼容
别名。npm scripts 本身不会加载
`.env.local`。Worker 启动时会验证 Broker node id、managed gateway 能力、TLS 文件权限、PurefectClient
模块与 API 文档目录，然后监听模型和 MCP 网关。成功日志包含 `RUNTIME_STARTED`。

## 5. 安装验收

不访问外部服务的仓库检查：

```bash
env -u NODE_OPTIONS npm run check
npm run format:runtime:check
npm test
```

部署验收至少确认：

1. Broker 启动后完成对账，Unix socket 权限只授予 Worker 身份；
2. Worker 能校验 Broker node id 并输出 `RUNTIME_STARTED`；
3. 模型和 MCP 网关证书主机名与 sandbox 使用的 URL 一致；
4. 测试 Run 能 claim、上报 `started`、sync 事件并 complete；
5. CLI 容器不能直连公网，只能在 isolated 模式经 Relay 到指定网关；
6. SIGTERM 先 drain，超过 `SANDLANE_DRAIN_MS` 后取消剩余 Run；
7. 启用状态面板时只发布到受控地址，并按需要配置访问 token。

不要用生产任务或生产凭据做破坏性验收。
