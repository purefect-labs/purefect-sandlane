<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  当前安全边界、部署约束和漏洞报告说明。
-->

# Security

## 信任边界

SandLane 将 Purefect 控制面、Worker、节点 Broker、Relay、CLI 沙箱和上游服务视为不同边界：

- Purefect Engine 鉴权用户、冻结 Run 输入与权限，并通过 PAPI `claim` / `sync` / `complete` 交付租约；
- Worker 是受信任进程，持有 Purefect service secret、Broker token、租约中的 agent token、模型 key
  和签名文件 URL；这些值只应存在于 Worker 内存；
- Broker 是受信任的节点级高权限进程，可访问 Docker socket，只接受认证的本地 Unix socket 请求；
- Relay 是最小 TCP 转发进程，只配置固定目的地，不应持有 Provider key、用户令牌或 Run 凭据；
- CLI 容器运行不可信模型输出和文件内容，只能获得当前 Run 的模型与工具 capability；
- 模型与 MCP 网关重新建立授权边界，不能信任 CLI 提交的 Run id、上游 URL、身份或工具目标。

随仓库提供的命令行 Worker 直接装配 Purefect 插件。通用 `createRuntime` composition API 不导入
Purefect，但其他控制面必须自行提供 SPI 实现、网关服务和部署拓扑；两种入口不能混为同一种配置。

## 能力令牌

每个 Run、每种用途分别生成 43 字符 capability：模型 capability 只进入对应模型协议，工具
capability 只进入 MCP 网关。网关从服务端登记表取得 Run 身份、上游目标和策略，不接受客户端覆盖。
capability 最长有效到 Run deadline，并随租约续期受 `lease_until` 约束；Run 完成、取消、租约丢失、
主体被撤销或 Worker 关停时从登记表撤销，进行中的下游请求也会中止。

capability 是 bearer secret。不得写入日志、事件、状态面板、镜像或持久化存储。Claude Code 文件
模式的 Bash 子进程当前可看到模型和工具 capability；泄露后的权限仍限定在该 Run、网关用途和剩余
有效期内，但可能造成越权工具调用或额外模型用量，因此不能把短期和限域当作无风险。

## 沙箱与网络

Broker 只使用 sha256 固定的 CLI 镜像。容器以 uid 1000 运行，根文件系统只读，丢弃 Linux
capabilities，启用 `no-new-privileges`，并限制内存、CPU、进程数和 tmpfs。每个 Run 使用独立容器；
工作区、临时目录和 CLI 状态在容器停止后清除。

当前 Worker 组合要求 `isolated` 网络：CLI 不能直接访问互联网，只能经 Relay 到 Worker 的模型 TLS
网关和 MCP TLS 网关。模型服务的联网搜索由模型网关按 Run 的 `web_access` 策略移除或收窄，不等于
给沙箱任意出站网络。不要关闭 TLS 校验，也不要把 Docker socket 挂进 Worker 或 CLI 容器。

容器隔离依赖 Docker daemon、Linux kernel、镜像供应链和部署配置，不是 microVM 边界。Broker 被攻陷
等同于执行节点被攻陷；共享敌对租户或高敏感工作负载应使用独立节点或更强隔离层。

## 文件模式

只有租约包含 `credentials.files` 时，Worker 才在宿主下载短期 HTTPS 文件，并经 Broker 在 CLI 启动
前写入 `/workspace/inputs`。签名 URL 不进入沙箱；文件名、数量、单文件/总大小、下载时间和写入阶段
均有限制。文件模式额外开放：

- Codex：读图、读写工作区和命令执行工具；
- Claude Code：`Read`、`Bash`、`Glob`、`Grep`；
- 模型网关：只放行当前 harness 配置的文件函数，非文件 Run 调用会被拒绝。

文件内容完全不可信。提示注入可能诱导 Agent 执行命令、读取同一 Run 的其他文件、修改工作区、调用
已获授权的业务工具或消耗模型额度。提示词中的“不执行文件指令”只是纵深防御，不是安全边界。文件
模式不授予新的平台身份，但会扩大 CLI 在当前 Run 内的操作面；敏感部署应收紧工具、确认规则、资源
上限和租约时间，并审计模型与工具调用结果。

## 部署要求

- Purefect service secret、Broker token、状态面板 token 必须相互独立，并优先通过 0600/0400
  `*_FILE` 或平台 Secret 注入；
- Broker socket、state 目录、Docker socket、TLS private key 和可选 memory 数据仅授予对应服务身份；
- 模型/MCP 网关只暴露给 Relay 所在网络；状态面板默认保持 loopback；
- 日志、崩溃转储和监控不得采集环境、prompt、工具参数/结果、token、capability 或签名 URL；
- 定期轮换长期 Secret，更新依赖与固定镜像 digest，并在目标节点验证关停、租约丢失和资源耗尽路径；
- 不要提交 `.env.local`、Secret、Broker state、memory 数据、运行日志或生产文件。

## 剩余风险

- 恶意或被提示注入的输入仍可滥用当前用户原本有权使用的工具；平台授权与确认策略是最终业务边界；
- Worker 内存或进程转储可暴露上游 key、agent token、capability 和签名 URL；
- Relay、DNS、私有 CA、镜像和宿主网络配置错误可能扩大出站范围或导致中间人风险；
- 单节点 Docker 隔离不适合把相互敌对的高价值租户放在同一 kernel；
- Worker 崩溃后已开始 Run 的结果可能不确定，控制面必须仲裁，不能依据本地日志假定成功或失败。

## 漏洞报告

请使用 **GitHub Security Advisory（仓库启用后生效）** 私下报告漏洞；在该渠道启用前，不要通过公开
Issue 提交未修复漏洞细节。报告中请提供受影响版本、复现条件、影响与建议缓解方式，不要附带真实
生产 token、用户数据、签名 URL 或未经脱敏的运行快照。

若凭据曾进入 commit，仅从最新文件删除不够：立即撤销并轮换凭据，再使用经过审核的历史清理流程。
