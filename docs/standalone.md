# 接入独立控制面

SandLane 是执行平面。默认独立体验见 [DEMO](./demo.md)，生产接入方仍需负责身份、
业务授权、持久队列、租约仲裁、审计与故障恢复。

## 两层 API

| 入口 | 适用场景 |
| --- | --- |
| `@purefect/sandlane/runtime` → `createRuntime` | 自行注入 SandboxProvider、凭据注册表、执行 lane 和端点；可接独占节点、VM 等实现 |
| `@purefect/sandlane/runtime/managed` → `createManagedRuntime` | 复用内置 Docker Broker、四种内置 Harness、TLS 模型与 MCP 网关 |
| `@purefect/sandlane/spi/*` | ControlPlane、ContextProvider、ToolProvider、SandboxProvider、status、run-credentials 等协议 |

managed API 是 **0.x experimental**，应固定包版本并阅读变更后升级。它不读取环境变量、不注册信号、
不导入 Purefect 插件，也不会隐式开启 SQLite。现有 Worker 和独立 Demo 调用同一个 managed API。

项目目前通过源码和 GitHub Release tarball 提供集成，`private: true` 保留；不声称已在 npm registry
发布。使用 Release 附件时先按同版本 `SHA256SUMS` 校验；从源码生成 tarball 的方式如下：

```bash
npm ci
npm run build
npm pack
# 在调用方项目中安装上一步实际生成的 .tgz
npm install /path/to/purefect-sandlane-0.1.1.tgz
```

`npm run package:check` 会在仓外目录安装实际 tarball，检查 ESM、TypeScript 声明和最小 runtime 生命周期。

## managed 装配

以下依赖由宿主提供：`controlPlane`、`context`、`toolProvider`、TLS 材料及 Broker 配置。
模型 URL/key 来自可信控制面租约，不能由用户 prompt 或 MCP 参数覆盖。

```ts
import { createManagedRuntime } from "@purefect/sandlane/runtime/managed";

const runtime = await createManagedRuntime({
  controlPlane,
  broker: { socket: "/control/broker.sock", token: brokerToken, nodeId: "node-1" },
  concurrency: 1,
  harnesses: ["claude-code"],
  lane: { runtimeId: "worker-1", lanes: ["interactive"], context },
  tools: {
    provider: toolProvider,
    serverId: "tools",
    targetRef: "business",
    targetVersion: 1,
    enabled: ["example_read"]
  },
  gateways: {
    model: { bind: "0.0.0.0", port: 19443, hostname: "model.example", tls: { key, cert } },
    tool: { bind: "0.0.0.0", port: 19444, hostname: "tools.example", tls: { key, cert } }
  }
});
// 宿主收到退出信号时停止领取；运行中的任务可以完成。
runtime.drain();
// 需要取消剩余任务并等待回收时：
await runtime.close();
```

Broker 必须报告 nodeId 匹配、ready 和 managedLaunch。至少配置一个普通网关工具；
控制面的页面动作或委派工具不能替代它。provider 工具名、clientActions、controlTools 不得冲突。
默认函数清单按 serverId 和工具名生成；覆盖函数清单时须与实际 CLI 提供的名称一致。

四个内置 Harness 使用独立镜像映射：codex、qwen-code、opencode 对应 Responses，claude-code 对应
Anthropic Messages。Qwen Code 与 OpenCode 首版只支持 MCP，不接受文件模式。
通用接口不替应用确定下游权限；ToolProvider 必须严格校验参数并按传入的执行身份授权。

## 生命周期

外部 MCP 可使用 `@purefect/sandlane/plugins/mcp` 的 HTTP / stdio 适配器，与已有 ToolProvider
组合使用；部署、配置、租户/用户授权及关闭责任见 [MCP 接入指南](./mcp.md)。

`drain()` 停止新领取，`close()` 中止剩余工作并等待清理，两者可重复调用。`done`
在所有 lane 停止及资源关闭后完成，失败时保留原错误和清理错误。

传入的 ControlPlane、ContextProvider、ToolProvider 默认借用。显式列入 `resources` 的对象
转移关闭责任，包括参数校验或启动失败的场景；按逆序关闭。不要同时在调用方重复关闭这些对象。
传入 endpoints 应尚未监听，runtime 负责监听与关闭。

任一 lane 异常会中止其余 lane，先等待 Run 凭据失效和沙箱停止，再关闭端点与资源。
SPI 实现须响应 AbortSignal 并限制外部 IO 超时；runtime 无法强制终止不合作的自定义 Promise。
CLI/部署管理器需设置总体停机上限，并以失败状态报告清理未完成，随后由 Broker 账本进行恢复。

## 控制面兼容边界

主流模型接入、base_uri 解析与 `model.upstreams` / `ModelUpstreamFactory` 公开扩展见
[模型接入指南](./model-providers.md)。切换同协议模型服务无需新增 Harness Driver。

`ControlPlane` 提供 claim/readLease/sync/complete，可选 output、clientActions 和 controlTools。
参考实现为 `src/plugins/standalone/control-plane.ts`，没有引用 Purefect parser。
生产适配器必须实现可靠租约、幂等和授权，不能直接将内存 Demo 用作生产队列。

运行依赖已经可以独立组合；SPI 为兼容现有集成仍保留 conversation_id、mentions、source、
task.reported 等字段。conversation_id 可映射为调用方的不透明会话标识；可选业务能力不必启用。
本轮不改变 Purefect v1 wire schema。
