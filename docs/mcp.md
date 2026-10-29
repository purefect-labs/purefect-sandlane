# 安装与接入 MCP 工具

SandLane 支持 **Streamable HTTP MCP Server** 和 **stdio MCP 程序**，也保留原有 `ToolProvider`
业务集成。管理员统一部署程序或服务，多个 CLI 沙箱共享工具目录；身份、凭据和客户端会话按调用隔离。
这是管理员配置文件 / SDK 接入，不是用户自助插件市场。

已有业务SDK、希望少写MCP协议代码时，可先运行[独立HTTP MCP最小贯通示例](../examples/mcp-sdk/README.md)：
`npm run mcp:check`。静态工具声明同时用于服务端注册与Worker配置导出，避免schema/readOnly手工维护两份。
当前示例是无费用验证模板，生产容器编排和真实CLI/Engine联调尚未完成。

## 选择部署方式

| 已有工具 | 安装在哪里 | 共享什么 | 调用时怎么隔离 |
| --- | --- | --- | --- |
| HTTP MCP | 独立 HTTPS 服务，Worker 能访问 | 服务实例、工具目录 | 每次调用独立 MCP 客户端/会话，按身份选择 Key |
| stdio MCP | Worker 内固定版本程序或只读挂载目录 | 程序文件和依赖 | 每次调用独立进程和环境变量，结束后终止进程组 |
| Purefect Client | Worker 通过 `PUREFECT_CLIENT_MODULE` 加载 | 客户端库、API 文档、工具适配器 | 保持原有 Run 用户短期令牌链路 |

**stdio 不是额外的安全沙箱**：程序拥有 Worker OS 用户能访问的文件及网络权限，进程隔离不隔离共享目录。
只运行管理员信任的程序，固定版本、只读安装，配置 OS/容器资源限制。不要向不可信程序提供 Worker
凭据目录、Docker socket 或控制 socket。需要运行不可信 MCP 时，应先独立容器化并发布 HTTP 服务。
适配器不自动创建 MCP 容器、不运行安装命令、不管理常驻 stdio 进程池；Windows stdio 暂不支持。

## 1. 部署服务或安装程序

- **HTTP：** 按服务商文档部署，取得 Streamable HTTP HTTPS 地址（例如 `/mcp`）和凭据。
  CLI 沙箱无需联网。私有 CA 可配置 `caFile`；不关闭 TLS 校验，不跟随重定向。
- **stdio：** 将固定版本安装到 Worker 镜像或只读挂载目录，如 `/opt/mcp/example/`。
  指定解释器绝对路径和已安装脚本，不使用 `npx -y` 临时下载，不根据用户输入拼接命令。
  Python 可指定已安装虚拟环境的解释器。默认 Worker 镜像不包含所有第三方 MCP 的依赖。

## 2. 写管理员配置文件

下面是结构示例，不是预置公网服务。将地址、工具名称/schema、租户/用户 ID、路径换成实际值。
schema 从组件文档或管理员核验过的 `tools/list` 结果取得，不动态发现并自动授权远程新工具。

```json
{
  "maxConcurrent": 8,
  "timeoutMs": 20000,
  "servers": [
    {
      "id": "knowledge",
      "transport": { "type": "http", "url": "https://mcp.example.com/mcp" },
      "tools": [
        {
          "alias": "knowledge_search",
          "remoteName": "search",
          "description": "Search the approved knowledge base.",
          "readOnly": true,
          "inputSchema": {
            "type": "object",
            "properties": { "query": { "type": "string", "maxLength": 1000 } },
            "required": ["query"],
            "additionalProperties": false
          }
        }
      ]
    }
  ],
  "bindings": [
    {
      "server": "knowledge",
      "tenantId": "tenant-1",
      "userId": "user-1",
      "tools": ["knowledge_search"],
      "headerSecrets": {
        "Authorization": { "file": "/run/secrets/user-1-mcp-key", "prefix": "Bearer " }
      }
    }
  ]
}
```

所有路径均以 **Worker 的文件系统**为准。配置文件不可被组/其他用户写入，不是符号链接，最大256 KiB。
Key 文件只含凭据，属于 Worker 运行用户，权限 `0600` 或 `0400`，不能是符号链接。
当前 Secret 读取器接受32–256个无空白可打印 ASCII 字符。配置只保存 Secret 路径，不内嵌 Key。
`headerSecrets` 支持 `Authorization`、`x-api-key`、`api-key`；`prefix` 可省略或设为 `Bearer `。
无需认证可省略凭据字段，但仍需身份授权绑定。

### stdio 配置差异

将服务的 `transport` 替换为：

```json
{
  "type": "stdio",
  "command": "/usr/local/bin/node",
  "args": ["/opt/mcp/example/server.mjs"],
  "cwd": "/opt/mcp/example",
  "env": { "LANG": "C.UTF-8" }
}
```

将绑定中的 `headerSecrets` 换成程序要求的环境变量名：

```json
"envSecrets": { "SERVICE_API_KEY": "/run/secrets/user-1-mcp-key" }
```

`env` 是管理员固定的非敏感变量，`envSecrets` 按身份读取并覆盖对应变量。不继承 Worker 的
`HOME`、`PATH`、平台令牌或个人 CLI 登录环境；需要的非敏感变量须显式配置。
不要把 Key 写进 `args` 或 `env`。stdout 只能输出 MCP JSON-RPC；stderr 不转发到模型或日志。

## 3. 在 Purefect Worker 启用

设置 `SANDLANE_MCP_CONFIG_FILE=/config/mcp.json`，将配置、Secret 和 stdio 程序提供给 Worker。
例如在自己的 Compose overlay 中增加：

```yaml
services:
  execution:
    environment:
      SANDLANE_MCP_CONFIG_FILE: /config/mcp.json
    volumes:
      - /absolute/path/mcp.json:/config/mcp.json:ro
      - /absolute/path/private/mcp-key:/run/secrets/user-1-mcp-key:ro
```

将上述宿主绝对路径替换为实际路径，避免受首个Compose文件所在目录影响。
确认挂载后 UID/权限符合 Worker 用户要求。使用包含该功能的 Worker 版本，在部署窗口重建/重启；
修改配置需要重启 Worker，Key 文件则每次调用重新读取。不配置此变量时不加载外部 MCP，原有工具保持原路径。

新工具必须同时通过三层限制：

1. `SANDLANE_ENABLED_TOOLS` 包含新 alias。仓库 Compose 显式列出原有 Purefect 工具，需在清单后
   追加 `knowledge_search`，不要覆盖丢失原工具。
2. 控制面租约若设置 `run.tools`，也要包含新 alias；缺省表示不进一步收窄。
3. `bindings` 匹配实际 tenantId/userId，并允许该工具。身份来自 Run，工具参数不能覆盖。

自定义 `SANDLANE_MODEL_FUNCTION_INVENTORY` 时也需同步新 CLI 函数名；默认由 Worker 自动生成。
平台可能还有自己的工具白名单，不能仅改 Worker 就假定所有用户都能调用。此功能没有新增平台管理页面，
也没有自动修改现有平台部署、默认工具或租约配置。

## 4. 独立控制面接入

不依赖 Purefect，使用公开 SDK 装配：

```ts
import { loadMcpToolProvider, combineToolProviders } from "@purefect/sandlane/plugins/mcp";
import { createManagedRuntime } from "@purefect/sandlane/runtime/managed";

const mcp = await loadMcpToolProvider("/config/mcp.json");
const provider = combineToolProviders(existingProvider, mcp);
const runtime = await createManagedRuntime({
  ...options,
  tools: {
    ...options.tools,
    provider,
    enabled: [...options.tools.enabled, "knowledge_search"]
  },
  resources: [...(options.resources ?? []), mcp]
});
```

无已有工具时直接 `provider: mcp`。`combineToolProviders` 拒绝同名 alias，不接管成员关闭责任；
将 mcp 加入 `resources`，运行时负责启动失败/退出时关闭。自行调用则须 `await mcp.close()`。
`McpToolProvider` 也接受配置对象，`parseMcpConfig` 可单独离线校验配置。

现有 `demo:chat` 仍只提供 `demo_echo`，不自动加载外部 MCP；通过上述 SDK / Worker 配置接入。
无需模型额度的本地适配器验证：

```bash
npm run build
node --test test/mcp-upstreams.test.js
```

## 共享、身份和权限

- 多个沙箱共享服务和程序。多个 Worker 可挂载同一份只读代码/配置，但客户端和并发计数各自独立。
- `userId: "*"` 显式授权本租户所有用户，使用该绑定的共同凭据；不支持租户 `*`。
  个人 Key 按用户建立绑定。精确用户绑定完全替换通配绑定，不合并权限。
- 共享服务必须按凭据正确授权。若共用服务账号，上游看到的是这个账号，不会自动获得 Purefect 用户权限。
  没有下游个人授权或个人审计，服务账号可见数据须适合所有获工具授权的用户；只读不替代数据保密要求。
  第三方 MCP 不会收到 Purefect agent token。租户共享账号是简单部署的主要模式。
- 个人凭据适合少量用户，需要维护Worker binding和服务端主体映射。一份配置跨全部server最多256条binding，
  同一用户在多个server的绑定分别计数；当前不提供规模化个人凭据管理。
- 绑定校验发生在调用时。工具目录可见性由 Run 的 `enabledTools` 决定，控制面应按授权生成目录；
  不能把“禁止调用”等同于“自动隐藏工具名称”。
- `readOnly` 是管理员声明，不是隔离保证。写操作由下游鉴权；审批依赖控制面确认策略，适配器支持
  精确工具 alias 或 `*`。未配置审批策略不会自动弹窗。
- schema 支持显式 `additionalProperties: false` 的对象、基础类型和数组；不支持 `$ref` 或组合 schema。
  复杂 schema 需审核收窄；远程接口变化需同步配置，不以开放任意参数绕过校验。

## 协议范围、资源及故障

仅转发工具调用；不支持旧 HTTP+SSE 双端点传输、交互式 OAuth、sampling/elicitation/roots、后台任务、
resources/prompts 转发。MCP 结果以 JSON 交给现有工具网关，不承诺原生多模态展示。
OAuth 服务需控制面先取得有效访问令牌。地址由管理员审核，部署网络限制出站目标；HTTPS 不等于 SSRF 防护。

默认8并发、20秒超时，可配置1–32并发、100–25000毫秒；还受 Run 撤销、令牌到期和网关上限约束。
单 HTTP 响应 / stdio 消息缓冲最多1 MiB，会话累计输入最多4 MiB；stdio 最多256条消息、stderr 最多1 MiB。
结果仍受现有网关裁剪。不自动重试、重连或刷新凭据。
调用前的绑定/忙/过期/凭据准备拒绝是明确失败；readOnly工具返回isError也是明确失败。
远端可用structuredContent.error提供固定纠正标识：INVALID_ARGUMENTS、NOT_FOUND、ACCESS_DENIED、RATE_LIMITED。
不透传远端任意错误原文。写工具isError、传输/超时/清理失败仍可能已产生副作用，按结果未知处理。
取消本地请求不保证远端业务撤销。

兼容新增工具可先逐台排空更新Worker目录及enabledTools，全部完成后再在Engine发布alias，无须整池暂停。
前提是所有Run显式下发run.tools且不含新alias；缺省表示不收窄，不能用此顺序保证隐藏。
回滚先撤回新授权，等待所有持有冻结旧授权的排队/运行Run结束或取消，再回退Worker。
schema/授权语义不兼容或无显式授权前提时使用维护窗口。

HTTP 正常结束后尝试删除上游会话，取消/断网后远端需自行过期回收，不跨用户共用 session ID。
stdio 结束时终止本次 POSIX 进程组，清理失败后该 provider 拒绝新调用；逃逸进程组的恶意程序不在保证范围内。
CPU/内存/文件权限由外部容器/OS 控制，本适配器限制的是并发、IO和时间。
