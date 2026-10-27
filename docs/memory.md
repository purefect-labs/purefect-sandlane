# 会话上下文与可选记忆接口

2026-10-14。会话回放不依赖向量库或长期记忆服务。总体设计见 [方案51](../../purefect-docs/ai-metadata-workbench/51-memory-architecture-and-agentscope.md)。

第二批更新：已增加可选SQLite个人记忆及持久后台摘要，配置和规则见[精简记忆手册](memory-lite.md)。尚未启用共享Host或配置真实摘要模型。

## 已实现的边界

`src/common/conversation.ts` 定义供应商无关的会话数据；`src/common/turn-envelope.ts` 将其作为历史数据交付 CLI。新格式为 `conversation-context-v1`，保留 `text` 和 `workspace-context-v1` 兼容。格式由可信调用方指定，不从用户文本猜测。

```json
{
  "version": 1,
  "prompt": "我上次说的测试代号是什么？",
  "ui_context": null,
  "conversation": {
    "conversationId": "example-session",
    "beforeRun": 2,
    "omittedTurns": 0,
    "turns": [
      {"run": 1, "status": "COMPLETED", "user": "代号 BLUE-42", "assistant": "已记下", "truncated": false}
    ]
  }
}
```

Purefect 适配在提交事务内按真实 tenant/user/task 读取历史；同会话已有运行中的任务时拒绝并行新提交。快照保存在现有消息记录中，并受 Run payload digest 校验。读取失败会使提交失败，不偷偷提交无历史版本；重试使用第一次已保存的快照。

Worker 核心不读取 Purefect 数据库。其他产品可提供同一格式，经现有 Driver 运行；独立三操作 ControlPlane 的 v1 目前仍只收文本，不应把 JSON envelope 当普通字符串发送，需由产品适配层显式映射到 Driver 的 promptFormat。

## 预算与保留范围

- 最多最近 12 个已终态轮次；按 run 顺序排列。失败/取消保留用户问题及状态，不把不完整回答伪装为成功。
- 单条历史问题/回答最多 8KB UTF-8；conversation 最多 40KB，整个 envelope 最多 60KB。JSON 转义也计入限制；先删除更旧完整轮次，最后一轮过大时缩短文本并标记 truncated。
- 这是保守字节预算，不是动态模型 tokenizer 预算；部署小窗口模型前应降低预算或增加该模型的 tokenizer/context budget 适配。当前大窗口模型验收不能代表任意模型。
- 当前轮页面信息独立传入；历史快照不会递归复制旧 envelope，也不会把旧 ui_context 当成当前页面。
- 本次不持久回放 CLI 内部思考或完整工具协议；恢复的是用户问题和最终回答。业务执行状态仍以平台记录/API 为准。

协议支持 `summary: {text, throughRun}`，限制8KB且不得与turns覆盖区间重叠。可选后台摘要生成器已实现、尚未在共享Host启用。没有已发布摘要时沿用原始历史，超出预算的旧内容标记omittedTurns；不承诺无限历史回忆，也不能用一次续聊验收冒充长会话验收。

## MemoryProvider 扩展

`src/plugins/memory/contracts.ts` 提供 `search / ingest / correct / forget / operation / export`，带作用域、来源、幂等键、版本及取消信号。`capabilities` 声明协议版本、检索类型与可选扩展。外部组件可用 HTTP 适配或 SDK 实现，不要求 Python 进入 Worker，也不要求调用方接入 Purefect。

`MemoryClient` 从可信配置固定 tenant/user/可选 assignment：

```ts
const memory = new MemoryClient({ tenantId, userId }, optionalProvider);
const result = await memory.search(query, { signal, timeoutMs: 200 });
// disabled: 未配置，不产生 I/O；unavailable: 超时/故障/越界结果，不能伪装成“查无记忆”。
// available: 调用方按上下文预算将 records 作为不可信数据加入输入。
```

默认不创建 Provider，也不自动在每轮调用 search。当前 CLI 生产链路只使用会话快照，没有暗中启用长期记忆。外部 Provider 接线时，应用明确决定哪些任务需要检索；不可改变已发出的模型请求。

管理入口及持久队列消费者使用 `memory.mutations()`；它固定作用域，调用者不能通过参数切换用户。`correct` 带 expectedRevision；`forget` 带 deletionVersion；`export` 分页且复核返回归属。`ingest` 返回 accepted 只说明进入持久处理，需通过 operation 查询完成/失败/可检索状态。不得将进程内 Promise 或 fire-and-forget 当持久交付。

已实现本地显式卡片及持久摘要队列，**没有实现自动事实抽取、Mem0/ReMe适配器、长期记忆管理UI或供应商删除算法**。采用某后端时必须验证：检索前范围隔离、幂等写入、更正并发、删除tombstone阻止旧任务复活、可恢复异步任务、导出迁移、超时与资源预算。MemoryClient的结果复核不能代替后端隔离。

检索默认 200ms，超时不等待忽略取消的后端；返回文本采用保守字节限额。Provider 仍必须遵守 AbortSignal，限制它自身的连接池/任务队列，否则调用方超时不等于其后台工作停止。记忆服务需要的模型/embedding 费用另计，不能认为只花数据库查询成本。

## 部署与验收

该变更无需 DDL/Meta 迁移。先部署支持新格式的 Host、Broker，再部署 Engine；旧新格式均可读。已有会话下次提交便创建历史快照，已有的进行中 Run 不会被改写。旧 Host/Broker 不支持新格式时不得先升级 Engine。

回滚优先保留新协议解析器；一旦产生新格式历史消息，回滚到完全不识别该类型的 Engine 会显示原始 envelope。不要通过删消息回滚。

组件：`npm run build && node --test test/memory.test.js test/managed-turn-input.test.js`。

真实链路脚本 `scripts/managed-memory-smoke.cjs` 已移除（W0a）。
