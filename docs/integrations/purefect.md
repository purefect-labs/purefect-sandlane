# Purefect 参考集成

Purefect 是 SandLane 的一个控制面集成，独立 Demo 和其他控制面接入不要求安装它。

## 平台调用链

Console 以登录用户身份通过 `pf.ai.assistant.ConversationDomain` 提交、取消、读取事件；
Engine 校验登录用户、服务权限和任务所有权，创建 Run/租约。
SandLane 的 Purefect Worker 通过 `pf.ai.worker.ExecutionDomain` 领取、同步、回传文件及结算。
模型和 MCP 请求在 Worker 内通过 Run capability 校验，工具调用使用执行人的短期令牌。

Console 入口与 `sys.ai.workbench/*` 是平台侧的集成细节，不是 SandLane 的通用提交 API。

## 配置与兼容

入口仍为 `npm run runtime:purefect` / `dist/bin/worker.js`，`runtime:execution` 保留为兼容别名。
Purefect 插件负责 ControlPlane、PurefectClient、API 文档、工具目录和业务提示；
通用 Docker/Harness/网关组装由 `createManagedRuntime` 完成。

`PUREFECT_*` 环境变量仅属于这个入口。`SANDLANE_*` 的现有名称、默认值、工具清单、
Context 注入规则、状态面板、memory 和 admission 配置保留。协议见 [控制面契约](../control-plane.md)。
独立模式不会加载这些平台凭据或客户端。

## managed Compose 参考部署

历史 `deploy/compose.runtime.yaml` 是基础清单，单独使用不能满足当前 Worker 要求。
新增 `deploy/compose.purefect.yaml` 叠加 isolated 网络、固定 IP Relay 和 Broker binding，
移除 Worker 网关的宿主端口发布。要求支持 `!reset` 的 Compose 2.24+。

部署前仍须准备基础清单要求的 runtime/CLI 镜像、PurefectClient、Engine CA、
网关 TLS 证书、SERVICE secret，按 [安装说明](../installation.md) 放入相应卷。
以下命令用于新测试部署；已有节点先 drain，再迁移，不能直接重建其正在使用的 Relay。

1. 在私有环境文件设置基础清单变量，以及 `SANDLANE_RELAY_IMAGE`（digest）、
   `SANDLANE_MANAGED_SUBNET`、`SANDLANE_WORKER_IP`，保证子网无冲突。
2. 设置 `SANDLANE_BROKER_MANAGED_GATEWAYS` 为 JSON，包含 `modelBaseUrl`、`mcpUrl`，
   与 Worker TLS hostname/端口完全一致。
3. 用实际 Worker IP 生成 route 配置文件，再启动 init 和 Relay：

```bash
npm run build
node scripts/relay-binding.js routes <worker-ip> 19443 19444 > /private/config/relay.env

docker compose --env-file /private/config/runtime.env --env-file /private/config/relay.env \
  -f deploy/compose.runtime.yaml -f deploy/compose.purefect.yaml up -d --no-deps init relay
```

4. 查看 Relay 的完整容器 ID，运行同一 confinement 校验后生成绑定文件：

```bash
docker compose --env-file /private/config/runtime.env --env-file /private/config/relay.env \
  -f deploy/compose.runtime.yaml -f deploy/compose.purefect.yaml ps -q relay

node scripts/relay-binding.js inspect <full-relay-container-id> > /private/config/binding.env

docker compose --env-file /private/config/runtime.env --env-file /private/config/relay.env \
  --env-file /private/config/binding.env -f deploy/compose.runtime.yaml -f deploy/compose.purefect.yaml \
  up -d --no-build broker execution
```

缺少 binding 时 Broker 不会形成可用 managed 链路；不能使用容器名代替不可变 ID。
Relay 重建后必须重新核对身份，并先让旧绑定完成旧 Run 网络清理。以上文件不含 Provider key，
仍应放在部署专用私有目录，不能提交带本机拓扑的配置。

这是平台参考部署清单，不是为现有部署自动执行迁移的脚本。完整、自动清理的无凭据体验使用
[独立 Demo](../demo.md)。

## 平台回归清单

升级候选 Worker 前至少验证两种 Harness 的提交、事件、结算和取消，以及工具权限拒绝。
同时按启用的功能验证文件输入/输出、页面动作、审批、任务委派、成员指导和 memory/status。
契约 schema 一致、单元测试或独立 fixture 通过，均不能单独证明实际平台链路正常。

使用隔离队列或受控测试窗口，避免新旧 Worker 抢走测试作业。保留上一镜像 digest 与配置，
切换前 drain，回滚时不清空 Broker 状态卷，也不重放已经开始的 prompt。

### 本次实现验收（2026-10-28）

| 范围 | 结果 |
| --- | --- |
| SandLane 单元测试 | 477 项通过，0 失败、0 跳过；包含文件、审批、页面动作、委派和生命周期测试 |
| Engine 租约 MySQL 集成测试 | 隔离源码构建运行 39 项，0 失败、0 错误、0 跳过；未覆盖运行中 Engine 的构建产物 |
| v1 schema | 两端逐字节一致，本次未修改协议 |
| 候选 Worker + 现有 Engine | 真实 Codex、Claude Code 均完成提交、领取、MCP 文档工具调用、事件回传和成功结算 |
| 运行中取消 | 真实 Codex 取消并结算；Claude Code 的运行中取消尚未单独实测 |
| 执行身份权限边界 | 真实工具调用受限 AI 接口返回 `ai_run_token_forbidden`，未放宽授权 |
| 独立 Docker fixture | 成功、取消、租约丢失均通过，使用实际 TLS 模型/MCP 网关；不代表真实 Provider 验收 |
| 公开分发和部署配置 | 实际 tarball 的 ESM/TypeScript 消费者通过；Purefect Compose 合并拓扑通过配置校验 |

以上平台冒烟使用候选 Worker 运行当前源码，未修改 Engine、Broker 或 Relay 配置。
浏览器交互、文件输入/输出、审批、任务委派、成员指导和 SQLite memory 的完整平台端到端验收
尚未逐项执行，不能把相应单元测试通过当作实际 UI/业务验收。新的 Purefect Compose 清单完成了
静态配置校验，尚未在全新 Purefect 部署中完成安装验收。CI 工作流已经加入，但远程运行结果
需要提交后由 GitHub Actions 给出。
