# SandLane 文档

SandLane 是面向多租户、多用户控制面的自托管 Agent CLI 执行平面。
项目概览见[中文首页](../README.md)或[English README](../README.en.md)，其余文档以中文维护。

## 从这里开始

| 目标 | 阅读入口 |
| --- | --- |
| 先跑通，再接真实模型交互 | [独立 Demo](./demo.md) |
| 用自己的控制面集成 | [独立接入与公共 API](./standalone.md) |
| 接入已有 Purefect 平台 | [Purefect 参考集成](./integrations/purefect.md) |
| 准备部署环境和配置 | [安装与启动](./installation.md)、[配置参考](./configuration.md) |
| 构建镜像、使用 Compose | [部署文件说明](../deploy/README.md) |

产品定位、能力边界和对外表述依据见[产品定位与能力边界](./product-positioning.md)。

## 模型与工具

- [主流模型接入与兼容验证](./model-providers.md)
- [Claude Code 支持](./claude-code.md)
- [Qwen Code 与 OpenCode](./qwen-code-and-opencode.md)
- [MCP 安装与接入](./mcp.md)，以及[业务 SDK 模板](../examples/mcp-sdk/README.md)
- [工具与页面动作](./tools-and-page-actions.md)
- [联网访问](./web-access.md)
- [记忆接入](./memory.md)

## 运行与开发

- [控制面契约](./control-plane.md)
- [日常运维](./operations.md)、[状态面板](./status-panel.md)
- [沙箱验证](./sandbox-validation.md)
- [安全说明](../SECURITY.md)、[开发与贡献](../CONTRIBUTING.md)
- [变更记录](../CHANGELOG.md)、[发布流程](./releasing.md)

## 项目背景

[Purefect Labs 开源项目](https://www.purefect.cn/zh/opensource)介绍 Purefect 产品与项目背景。
SandLane 的技术文档以本仓库为准；问题与建议请通过 [GitHub Issues](https://github.com/purefect-labs/purefect-sandlane/issues)反馈。
