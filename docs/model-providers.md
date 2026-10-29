# 接入 DeepSeek、智谱、Qwen 及其他模型服务

扩展范围也包括 Kimi（月之暗面）、Google Gemini 等模型服务，并不限于本文列出的服务商。
当前已实现 `ModelUpstreamFactory` 扩展接口，通过 `createManagedRuntime` 的 `model.upstreams`
由可信部署代码注入。接入取决于协议，而非模型品牌：提供符合现有网关契约的 Responses 或
Anthropic Messages 接口时，可配置接入并验证；若仅提供 Chat Completions 或其他原生协议，
需另行实现上游适配器，转换请求、流式事件、工具调用、用量与结束状态，同时保留取消、资源上限及凭据隔离。
这个扩展接口不会自动转换协议，也不会自动开放多模态等现有网关未支持的能力。
Kimi、Gemini 尚未进行真实兼容验证，仓库也未内置其专用协议适配器；配置前应核对具体服务入口、模型和套餐。

SandLane 将 Agent CLI 与模型服务分开：Codex、Qwen Code 和 OpenCode Driver 使用 Responses，
Claude Code Driver 使用 Anthropic Messages。同一 Driver 可以使用实现对应协议的不同模型服务，不需要为每个模型品牌新增 Driver。
模型名称、地址和 Key 来自可信控制面租约；CLI 只能访问 SandLane 网关并持有短期 capability。

“OpenAI 兼容”可能只表示 Chat Completions，不能据此认定兼容 Codex。当前内置网关没有实现
Chat Completions 入口或自动协议转换，也不会因请求失败而偷偷改用其他模型。

## 接入矩阵与验证状态

以下来源核对于 2026-10-28。地址为服务商文档中的接口形式，不保证每个模型、地域和套餐均可用。
模型 ID 请使用账户当前有权调用、且支持相应协议的编码，不把本文示例当作型号或额度承诺。

| 服务商 | Harness / wire_api | 建议填写的 base_uri | 备注 |
| --- | --- | --- | --- |
| DeepSeek | codex、qwen-code、opencode / responses | `https://api.deepseek.com/responses` | 显式 endpoint，避免根地址的历史 `/v1` 默认值；`deepseek-flash` 已分别通过三个 CLI 的真实验证 |
| DeepSeek | claude-code / anthropic-messages | `https://api.deepseek.com/anthropic` | 实际请求 `/anthropic/v1/messages` |
| 智谱 GLM | codex / responses | `https://open.bigmodel.cn/api/v1` | 与 `/api/paas/v4` Chat Completions 地址不同 |
| 智谱 GLM | claude-code / anthropic-messages | `https://open.bigmodel.cn/api/anthropic` | 实际请求 `/api/anthropic/v1/messages` |
| Qwen（百炼按量） | codex / responses | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | 替换 WorkspaceId；模型必须支持 Responses |
| Qwen（百炼按量） | claude-code / anthropic-messages | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic` | 替换 WorkspaceId；Key、地域与业务空间须匹配 |

百炼 Token Plan、Coding Plan、按量计费的地址与 Key 不能互换。官方 Codex 文档注明部分套餐/模型
只有 Chat Completions；本文不建议降级 Codex 来规避该差异。可选择支持 Responses 的服务，或改用
对应的 Messages 服务。官方页面的个人 CLI 配置不能原样搬到 SandLane 沙箱，否则会把真实 Key 暴露给 CLI。

当前证据：

- 六组端点和合成 SSE 夹具通过：使用生产请求/响应校验器，验证两轮工具/文本往返、用量和认证头。
- HTTPS 网关集成测试验证前缀路由、凭据替换、流式转发与撤销；旧根路径和 `/v1` 行为保留。
- 本轮全量测试 504 项通过（0 失败、0 跳过），实际 tarball 消费者验证了公开工厂/类型导出；
  Docker fixture 以 Bearer 上游认证完成 2 次模型请求、1 次 MCP 工具调用并清理本次资源。
- **DeepSeek `deepseek-flash` 已实测（2026-10-28）**：Responses 与 Messages 各通过两轮真实协议探针；
  Codex 0.154.0 与 Claude Code 2.1.301 的独立 Docker 任务均成功调用一次 MCP `demo_echo`、返回
  `DEEPSEEK_OK`、结算并清理。此结果覆盖简短文本/工具任务，不代表所有型号、推理/多模态功能或长期稳定性。
- **Qwen Code 0.26.3 与 OpenCode 1.19.5 已实测（2026-10-29）**：本机 linux/arm64 隔离容器均通过
  DeepSeek `deepseek-flash` Responses 入口完成一次 `demo_echo` 调用、返回指定 nonce、结算并清理。
  该结果不替代 linux/amd64、公开发布镜像、目标 Purefect 部署、取消和资源压力验收。
- 智谱、Qwen 的真实 API/CLI 尚未验证，按用户要求暂缓。夹具不是厂商录制响应，不能当作上游兼容认证。
- 以前的 Purefect 双 CLI 冒烟不等于这三家模型的验收。

## 控制面与平台配置

控制面在现有 `credentials.model_service` 下下发：

```json
{
  "base_uri": "https://open.bigmodel.cn/api/anthropic",
  "wire_api": "anthropic-messages",
  "model": "<账户可用的模型编码>",
  "api_key": "<由可信控制面从 Secret 读取，仅向 Worker 下发>"
}
```

Run 的 `harness` 必须匹配：`codex` / `qwen-code` / `opencode` → `responses`，
`claude-code` → `anthropic-messages`。
Qwen Code 与 OpenCode 的上述固定版本已经通过本地 Responses + MCP 协议探针及 DeepSeek 真实冒烟；
选择其他模型、架构或镜像 digest 时仍须单独验证。
此示例是租约字段片段，不是浏览器提交参数。Purefect 部署应配置模型连接器及执行档案的模型路由，
由 Engine 生成租约；不要修改用户 prompt 或绕过连接器授权。其他控制面实现相同 SPI 即可。
本次没有自动修改现有平台连接器、套餐配置或默认模型。

Messages 上游默认使用 `x-api-key`。要求 Bearer 的服务（例如百炼文档中的方式）使用
`SANDLANE_MODEL_MESSAGES_AUTH=bearer`；详见 [配置参考](./configuration.md)。
managed API 对应 `model.messagesAuth: "bearer"`。这是 Worker 级设置；混用不同认证方式时，
使用分开的 Worker 或下面的可信上游工厂，不能从用户请求选择认证策略。

首次验证关闭联网搜索和文件模式，使用较小的输出上限；通过后再测试推理、多模态、文件、搜索。
“协议兼容”不保证所有 beta header、thinking、缓存、上下文窗口、内置工具均兼容。
当前 Responses 校验要求返回的 model 与租约模型一致；供应商若返回不同的规范化型号，需要明确适配，
不能通过关闭整套响应校验来解决。取消会中止本地请求，不保证上游计算或计费立即停止。

## URL 解析约定

仅接受可信配置提供的 HTTPS 地址，不接受用户信息、query、fragment、转义/歧义路径；不跟随重定向。
URL 语法校验不等于 SSRF 防护，控制面和部署网络仍须限制允许访问的上游地址。

| 输入 | Responses 请求 | Messages 请求 |
| --- | --- | --- |
| `https://host` | `/v1/responses`（旧行为） | `/v1/messages`（旧行为） |
| `https://host/prefix/v1` | `/prefix/v1/responses` | `/prefix/v1/messages` |
| `https://host/anthropic` | `/anthropic/responses` | `/anthropic/v1/messages` |
| 完整 `.../responses` 或 `.../messages` | 保留匹配的 endpoint | 保留匹配的 endpoint |

完整 endpoint 最明确。不能填 `.../chat/completions`，也不能将 Messages endpoint 用于 Responses。
以上 base_uri 仅属于 **Worker 到上游**；CLI 到 SandLane 的网关地址无需改成服务商地址。

## 真实 Provider 验证

准备私有配置，例如 `/private/config/model-profiles.json`：

```json
[
  {
    "id": "deepseek-codex",
    "wire": "responses",
    "baseUri": "https://api.deepseek.com/responses",
    "model": "<账户可用的模型编码>",
    "keyFile": "/private/secrets/deepseek-key"
  },
  {
    "id": "qwen-claude",
    "wire": "anthropic-messages",
    "baseUri": "https://<实际业务空间>.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    "model": "<支持 Messages 的模型编码>",
    "auth": "bearer",
    "keyFile": "/private/secrets/qwen-key",
    "maxOutputTokens": 2048
  }
]
```

Key 文件必须是当前用户拥有的私有普通文件（0600/0400），不允许符号链接；不要把 Key 放入命令行、
示例 JSON 或仓库。配置最多 16 项，逐项执行，每项 120 秒、最多两轮正常请求；失败不重试。

```bash
npm ci
npm run models:check -- /private/config/model-profiles.json
```

该命令会调用真实模型并产生费用。使用生产 Provider 和协议校验器，要求模型调用一次无副作用的
`compatibility_echo`，回传随机值，再返回相同文本；检查流式终态和用量。输出只有 profile ID、
PASS/FAIL、计数及脱敏错误码，不输出原始消息、URL 或凭据。任何一项失败命令非零退出。
**它不启动 CLI、Docker 或 MCP，不能代替以下完整验收。**

随后按 [独立 Demo 的真实 CLI 模式](./demo.md) 提供固定 digest 的 CLI 镜像，验证
提交→模型→MCP→工具结果→回答→结算，并检查取消、租约失效、凭据清理。Messages 默认 x-api-key；
需要 Bearer 的 Demo 加 `--messages-auth=bearer`，不可用泄露 Key 或关闭 TLS 的方式绕过。
生产启用前还需按实际业务验收文件、审批、页面动作等功能。

## 扩展其他主流模型

1. 先确认**实际 endpoint 支持的协议**，不能只看“OpenAI compatible”宣传。
2. 同协议优先使用内置 Provider，填写 base_uri、wire_api、model、Key 和认证方式；无需新增 Driver。
3. 特殊认证或协议差异通过可信 composition 的 `model.upstreams` 注入 `ModelUpstreamFactory`。
4. 只有新增 Agent CLI 才新增 HarnessDriver、Launcher 和镜像；切换模型服务不需要安装 Sandbox Agent。

公开入口均可从包 exports 导入，无需引用内部 dist：

```ts
import { createManagedRuntime, createDefaultModelUpstreams } from "@purefect/sandlane/runtime/managed";
import type { ModelUpstreamFactory } from "@purefect/sandlane/spi/model-upstream";

const apiKey = createDefaultModelUpstreams("x-api-key");
const bearer = createDefaultModelUpstreams("bearer");
const bearerOrigins = new Set(["https://your-approved-provider.example"]);
const upstreams: ModelUpstreamFactory = {
  responses: base => apiKey.responses(base),
  messages: base => (bearerOrigins.has(new URL(base).origin) ? bearer : apiKey).messages(base)
};
// 其他参数见 standalone.md；由部署代码注入，不从租约、prompt 加载模块。
const runtime = await createManagedRuntime({ ...options, model: { ...options.model, upstreams } });
```

自定义工厂替代内置 transport/auth/warmup，必须自己保持：HTTPS/目标约束、有限缓冲、AbortSignal、
凭据防泄露、工具名单、终态及用量检查。实例会跨 Run 缓存，不能保存 Run Key 或可变请求状态。
需要额外连接池等资源时显式放入 runtime.resources，失败和退出时关闭。
Chat Completions 转换并未实现；未来适配器须验证工具 ID、多轮历史、推理、流式事件与用量，不能用
“补一个成功终态”掩盖丢失的语义。当前 Purefect CLI 不从环境变量动态加载任意适配模块。

## 官方依据

- [DeepSeek：Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex)
- [DeepSeek：Anthropic API 兼容及字段差异](https://api-docs.deepseek.com/guides/anthropic_api)
- [智谱：Responses API](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction)
- [智谱：Claude API 兼容](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction)
- [百炼：Codex（按套餐区分协议）](https://help.aliyun.com/zh/model-studio/codex)
- [百炼：Claude Code（按地域、套餐区分地址与 Key）](https://help.aliyun.com/zh/model-studio/claude-code)
