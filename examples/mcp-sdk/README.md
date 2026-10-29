# SDK → HTTP MCP 最小贯通示例

这是无模型费用的验证模板，不是已经完成生产部署验收的MCP产品。
使用标准MCP SDK和SandLane现有适配器；没有新增插件SPI、资源框架或Worker状态机。

在仓库根目录运行（需要Node与openssl）：

```bash
npm ci
npm run mcp:check
```

测试自动创建临时TLS证书与虚构主体，验证以下链路并清理文件、监听端口：

`MCP SDK客户端 → HTTPS工具网关 → Run授权 → McpToolProvider → HTTPS MCP模板 → 示例SDK`

包含两用户并发、无绑定/无Run授权拒绝、NOT_FOUND纠正标识；输出20次调用的延迟p50/p95。
示例SDK只查虚构内存数据，未调用真实业务API。客户端是协议测试客户端，并非真实Codex/Claude Code；
这不代表Engine部署、容器故障恢复或真实CLI验收已完成。

## 改成自己的SDK

`tools.mjs`是工具声明唯一来源：alias、remoteName、description、readOnly、inputSchema。
`customerSdk`中替换为真实SDK调用；按服务端已认证principal选择业务凭据，禁止从模型参数选身份或Key。
示例只有一个只读工具；增加工具时同步增加服务端分派与各自schema校验，不把只读声明当运行时沙箱。
业务错误可返回`isError: true`及`structuredContent: { error: "NOT_FOUND" }`。
可供模型纠正的标识仅支持INVALID_ARGUMENTS、NOT_FOUND、ACCESS_DENIED、RATE_LIMITED，不返回原始异常。
写工具必须readOnly=false；MCP的isError不代表写入没发生，结果仍按UNKNOWN处理，不自动重试。

构建后导出Worker配置：

```bash
npm run build
node examples/mcp-sdk/export-config.mjs https://mcp.example.com/mcp
```

命令只输出JSON，不写文件、不安装服务、不含Secret。可按需传第三个参数（Worker内的CA绝对路径）。
导出使用当前SandLane的parseMcpConfig，因此跟Worker的名称/schema规则一致。
管理员填写bindings、实际端点/CA路径，并将alias加入enabledTools及控制面Run授权。
不要另外手改服务端与Worker的readOnly/schema。部署前比对实际tools/list和导出清单。
离开仓库复制示例时，服务端只需要MCP SDK；导出脚本另需安装相同版本SandLane tarball，当前包不在公共npm发布。

## 共享账号的使用边界

v1优先支持租户共享服务账号：下游按服务账号授权，不继承Purefect用户个人数据权限。
只有该服务账号的数据可对所有获工具授权用户开放时才适用；只读不等于可以泄露跨用户数据。
仍有Worker工具/绑定授权及服务端token/工具授权，不能把它描述为完全没有服务端授权。

少量用户可采用一人一个MCP token、一个下游凭据映射。需要维护Worker binding和服务端映射两份配置；
一份Worker MCP配置跨所有server最多256条binding，不是每个server有256个用户。
配置映射修改要重启；现有Worker的Key文件内容每调用重读，单纯轮换其内容不需重启Worker。

## 部署与后续验收

`createSdkServer`演示无状态HTTPS MCP，不保留会话，因此客户端不会发送DELETE。
每次业务调用仍会initialize、发送initialized通知和callTool。TLS连接可能被Node连接池复用，
不能将测得数字当成每次完整TLS握手或生产跨网络延迟；现有有状态HTTP测试另外覆盖DELETE。

本示例尚未提供生产Secret加载、请求截止/硬终止、健康故障后的重启编排。
不能直接公网部署。生产版本须按v4方案补齐私有配置读取、网络/挂载隔离、资源限额、请求超时、
外部终止和重启验证；Docker标记unhealthy本身不会自动重启。SDK自动写重试也要禁用并测试。
独立服务故障不应停止Worker，但会影响该服务并发调用；进程终止不能撤销已提交的业务写入。

兼容新增工具先逐台更新Worker，再发布Engine alias。必须确认该池Run均显式下发run.tools；
缺省不收窄工具，不能承诺新工具未提前可见。回滚先撤权，待持有旧冻结授权的排队/运行Run结束，再回退Worker。
不兼容schema或无显式工具授权时使用维护窗口。详见[接入文档](../../docs/mcp.md)。
