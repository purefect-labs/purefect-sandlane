<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  本地诊断页面的人工验证流程。
-->

# Purefect SandLane 使用 Demo

> **2026-10-15**：旧 8787/8788 Worker（`src/server.js` 及 `npm start`/`npm run dev`/`npm run acceptance`）和 `managed-claim-*` 链路已随 Engine 旧接口一并删除。当前运行入口是 `npm run runtime:execution`，契约与配置见 [执行内核与 Engine 契约](./docs/control-plane.md)。本文其余涉及旧 Worker 的内容仅作历史参考，待重写。

这篇说明用于实际观察一次任务如何从 Web 页面进入 Worker，再由 Codex Harness 调用 Shell，最后通过事件流回到浏览器。

## 1. 选择入口

完整竖切应从 Purefect Console 顶部 AI 入口打开：浏览器只调用 `sys.ai.workbench/*`，由 Engine 校验登录用户、服务权限和任务所有权，再调用 Worker。

Worker 自带页面用于排查 Harness，不代表生产接入方式。

### Worker 诊断页

当前本机服务地址：<http://127.0.0.1:8787>

若 Worker 尚未启动：

```bash
cd purefect-sandlane
npm start
```

Console 联调建议改用 `PORT=8788`，并按 README 同时配置 Engine 的 Worker URL 和 service secret。后端需要重启以加载新增 Handler、Connector 与 Meta。

页面右上角显示“Codex Runtime 在线”或“事件流已连接”表示 Worker 和浏览器连接正常。首次启动时 App Server 可能还在初始化，创建任务后会自动等待它就绪。

## 2. 让 Agent 使用 Shell

点击左上角 `+`，输入：

```text
请使用 Shell 在工作目录创建 demo-result.md。文件包含三级标题“Purefect SandLane Demo”，并写出当前目录、执行时间，以及一句“这个文件由 Codex Harness 创建”。完成后说明你调用了什么工具。
```

点击“开始运行”。观察以下变化：

1. 左侧状态从 `queued` 变成 `running`，最后变成 `completed`。
2. “Agent 回答”页签流式显示 Codex 的最终说明。
3. “运行事件”页签出现 `runtime.thread.created`、`runtime.turn.started`、`runtime.item.*` 和 Shell/文件事件。
4. “运行详情”显示 Worker run ID、Codex thread ID、turn ID、模型和独立工作目录。

这里的 Shell 不是 Worker 自己解析命令。Worker 把 turn 交给 Codex App Server，Harness 决定调用 Shell 工具；命令在该 run 的 `workspace` 目录内执行。

## 3. 检查真实文件产物

在“运行详情”复制“工作目录”的值，然后在终端查看：

```bash
ls -la <工作目录>
sed -n '1,120p' <工作目录>/demo-result.md
```

默认目录也可以从项目下查找：

```text
purefect-sandlane/.data/workspaces/{runId}/
```

任务之间使用不同目录。这个隔离便于演示和审计，但它不是容器级安全隔离。

## 4. 验证 Session 记忆与恢复

任务完成后，页面底部会出现继续输入框。输入：

```text
不要再次读取文件。请告诉我你刚才创建的文件名，以及文件中的那句固定说明。
```

点击“继续”。Worker 不创建新 thread，而是执行：

```text
thread/resume(existingThreadId)
turn/start(newPrompt)
```

“运行详情”中的 thread ID 应保持不变，turn ID 会变化。这就是 Demo 中的 session 连续性。Codex thread 保存在 `$CODEX_HOME`，Worker 只持久化 run 与 thread 的关联。

## 5. 验证取消

创建一个需要多步执行的任务，例如：

```text
检查当前工作目录，制定一个五步文件整理计划，逐步创建对应文件并在每步完成后核验内容。
```

状态进入 `running` 后点击“停止运行”。Worker 调用 `turn/interrupt`，收到 Harness 的完成通知后把 run 标记为 `cancelled`。已经写入工作目录的文件不会自动回滚，这正是后续 AIChangeSet、写前快照和补偿机制需要解决的问题。

## 6. 查看原始 API

列出 run：

```bash
curl -sS http://127.0.0.1:8787/api/runs
```

查询完整 run（包含事件）：

```bash
curl -sS http://127.0.0.1:8787/api/runs/{runId}
```

订阅 SSE，并从事件 0 开始回放：

```bash
curl -N 'http://127.0.0.1:8787/api/runs/{runId}/events?after=0'
```

断线后把 `after` 改成最后收到的 sequence。浏览器页面已经自动这样处理。

## 7. MCP 在哪里接入

Codex App Server 同时是 MCP client。它从 `$CODEX_HOME/config.toml` 读取 MCP Server 配置；Worker 不需要自己解释 Purefect MCP 文档或执行 MCP 脚本。

未来接入 Purefect MCP 后，可以把示例任务替换为：

```text
读取我有权开发的模块中某个 model 的原始元数据，分析字段设计并给出变更计划。暂时不要执行写操作。
```

预期事件流中会出现 `mcp.tool.progress` 或 MCP tool item。正式实现还需为每个 run 注入用户短期委托 Token、环境和工具 allowlist；当前 Demo 不应连接生产 Meta 写 API。

## 8. 一键验收

以下命令不是 mock，会执行两次真实 Codex turn：

```bash
cd purefect-sandlane
npm run acceptance
```

验收脚本执行完整闭环：

```text
启动临时 Worker
  -> 创建 run
  -> Codex Shell 写 hello.txt
  -> Node 从磁盘核对随机内容
  -> 恢复同一 thread
  -> 新 turn 读取文件
  -> 核对回答、thread ID 和工具事件
  -> 清理临时数据并退出
```

出现 `[acceptance] PASS` 才算通过。

## 9. 当前原型刻意没有做什么

- 没有自动发布或删除 Meta。
- 没有把目录隔离包装成 Kubernetes 容器或 microVM。
- 没有生产级 PostgreSQL 事件存储、Redis 多副本事件总线和 Worker lease。
- 没有把 Purefect 用户权限转成每次 run 的动态 MCP 凭据。
- 没有 AIChangeSet、模块软锁、写前快照和未触碰 descriptor digest 门禁。

这些边界让 Demo 聚焦最核心的问题：Agent Runtime 确实能接受任务、使用操作系统工具、保持 session，并由一个独立 Worker 以 Web API 的方式管理。
