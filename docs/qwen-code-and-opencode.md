# Qwen Code 与 OpenCode

SandLane 内置四个显式维护的 Harness：Codex、Claude Code、Qwen Code 和 OpenCode。Qwen Code 与
OpenCode 提供可公开构建和分发的开源 CLI 路径，但并不替换前两个 Harness；控制面按 Run 的
`harness` 和模型协议选择其中之一。

| Harness | 认证版本 | 许可证 | 模型协议 | 文本事件 | v1 工具范围 |
| --- | --- | --- | --- | --- | --- |
| `qwen-code` | `0.26.3` | Apache-2.0 | Responses | partial stream | 仅 Run 授权的 MCP |
| `opencode` | `1.19.5` | MIT | Responses | completed block | 仅 Run 授权的 MCP |

版本认证不表示未来版本自动兼容。升级 CLI 后必须重新验证模型请求、MCP 函数名、JSONL 事件、取消、
配置隔离和资源消耗，再更新镜像 digest。

## 受管运行方式

两个 Harness 都复用 SandLane 的 Responses 网关和 MCP 网关。沙箱只收到两个短期 Run capability，
不会收到模型服务商 Key、用户 token 或 Broker token。镜像内的 `harness-launch-shim.mjs` 在 Run
admission 后读取一个有界启动帧，把 prompt 写入子进程 stdin 并关闭 stdin；prompt 不进入容器或进程
argv。shim 不解析模型协议、不重试请求，也不承担控制面职责。

Qwen Code 使用 `--bare`、显式 MCP 配置、server/tool allowlist 和内置工具 denylist。固定版本探针确认
模型可见函数只有 `mcp__<server>__<tool>`。不能改成 `--safe-mode`：该模式会连接但不向模型公开显式
MCP 工具。`low`、`medium`、`high` 被写入隔离 `QWEN_HOME/settings.json`；最终是否发送 reasoning 字段
仍取决于所选模型的 Qwen Code 配置和上游支持。

OpenCode 使用 pure mode、隔离 XDG 目录、禁用项目配置、默认插件、外部 skills、LSP 下载、模型目录
拉取和自动更新。权限默认 deny，只允许 `<server>_*`；`title`、`summary`、`compaction` 内置 agent 被
禁用，避免主任务之外的模型调用。固定版本探针确认 MCP 函数名为 `<server>_<tool>`。

## 构建镜像

在仓库根目录执行：

```bash
docker build -f deploy/Dockerfile.cli-qwen \
  --build-arg QWEN_CODE_VERSION=0.26.3 \
  -t sandlane/qwen-code:0.26.3 .

docker build -f deploy/Dockerfile.cli-opencode \
  --build-arg OPENCODE_VERSION=1.19.5 \
  -t sandlane/opencode:1.19.5 .
```

OpenCode 镜像直接安装目标架构的官方平台包，不运行 npm lifecycle script。两个 Dockerfile 都在构建期
执行真实 `--version`，以非 root UID/GID 1000 运行，并包含 SandLane `LICENSE` 和 `NOTICE`。
发布到生产前应扫描镜像和 SBOM，并把部署配置固定到 registry digest：

```json
{
  "qwen-code": "ghcr.io/example/sandlane-qwen-code@sha256:<digest>",
  "opencode": "ghcr.io/example/sandlane-opencode@sha256:<digest>"
}
```

若网关使用私有 CA，在原生镜像之上按 Demo/部署流程构建 `deploy/Dockerfile.cli-ca` 派生镜像，再固定
派生镜像 digest。不要在镜像层中写入 API Key 或个人 CLI 登录状态。

## 控制面配置

两个 Harness 的 `credentials.model_service.wire_api` 都必须是 `responses`。Purefect 执行档案示意：

```yaml
purefect:
  ai:
    run:
      profiles:
        qwen-code:
          harness: qwen-code
          lane: default
          model-connector: <responses-connector>
          model: <model-id>
        opencode:
          harness: opencode
          lane: default
          model-connector: <responses-connector>
          model: <model-id>
```

Engine 仍负责按用户和租户选择连接器、模型和 Key；SandLane 只消费已授权的 Run 租约。不同用户可由
控制面下发不同模型凭据，Worker 会为每个 Run 创建独立 capability。Broker 节点必须同时配置相应
Harness 的 digest 镜像，否则该 Run 以 `harness_unavailable` 失败，不会回退到其他 CLI。

## 当前边界

- 首版明确拒绝 `fileTools=true`，不提供 CLI 内置 shell、编辑、文件或 web 工具。
- 工具仅来自 Worker MCP catalog，并继续受 Run grant、用户绑定和网关授权约束。
- Qwen Code 已验证 partial text；OpenCode 固定版本只把完成的 text block 映射为 delta，不能宣称逐 token。
- 本地固定版本探针已覆盖 Responses 两轮、MCP list/call/result、函数名和终态。2026-10-29 又在
  linux/arm64 上使用 DeepSeek `deepseek-flash` 完成真实端到端冒烟：两个 Harness 均各调用一次
  `demo_echo`、返回指定 nonce、成功结算并清理沙箱。该结果只覆盖固定版本的简短文本与 MCP 任务，
  不代表其他模型、复杂任务、长期稳定性或生产验收。
- linux/amd64 发布镜像、公开 registry digest、目标 Purefect 部署和取消/资源压力仍须单独验收。
- SandLane 不提供动态加载第三方 Harness 代码的机制。新增 CLI 应新增显式 Driver、Launcher、固定镜像和
  兼容测试，避免把不可信插件装入 Worker 进程。

Demo 命令见[独立 Demo](./demo.md)，模型端点见[模型接入指南](./model-providers.md)，生产变量见
[配置参考](./configuration.md)。
