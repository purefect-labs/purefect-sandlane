<!--
  Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
  SPDX-License-Identifier: Apache-2.0
  本仓库的开发、测试和提交约定。
-->

# 开发与贡献

## 开发环境

要求 Node.js 20+。安装锁定依赖并构建：

```bash
npm ci
npm run build
```

运行入口是 `dist/bin/worker.js`、`dist/bin/broker.js` 和 `dist/bin/relay.js`。Broker 只在 Linux +
Docker 节点运行。入口不自动读取 `.env.local`，本地调试请显式
使用 `node --env-file=.env.local ...`，且不要提交真实配置。

## 提交前检查

```bash
env -u NODE_OPTIONS npm run check
npm run format:runtime:check
npm test
git diff --check
```

`npm test` 先构建，再运行全部 `node:test` 单测；它不调用真实模型、Purefect 服务或 Docker。需要
Docker/原生 CLI 集成验证时显式选择 `scripts/*-validation.js`，记录环境与结果，不把真实凭据放进参数
或输出。

## 代码约定

- 保持 Node.js ESM 与严格 TypeScript；新行为使用 `node:test` 覆盖失败、取消和资源清理路径。
- 不在测试中依赖个人路径、真实 token、生产服务或同级仓库；可选跨仓库检查必须清楚报告跳过原因。
- 保持租约、事件 offset、幂等、未知结果和凭据撤销语义；不要从断连推断 Run 成功。
- 运行时格式由 `.prettierrc.json` 和 `format:runtime:*` 脚本约束，不顺手重排脚本未覆盖的全仓库文件。
- 注释说明身份来源、资源所有权、取消竞态、背压和限额，不逐行复述实现。
- 一种职责只有一个权威实现；只有真实替换点才新增接口或工厂。

### 执行底座职责

| 层 | 负责 | 边界 |
| --- | --- | --- |
| Harness Driver | 原生协议、请求关联、事件归一化 | 不操作 Docker socket，不复制租户授权 |
| Transport | 字节读写、背压、进程或连接生命周期 | 不解析业务动作，不从断连推断任务成功 |
| Broker | 分配、容器归属、容量、停止与对账 | 不成为第二套 Task/Run 或权限权威 |

## 原作者与第三方声明

修改已有文件时保留原作者、版权年份及许可证声明，不因本次修改重写归属。
引入或改编第三方代码、文档和素材时，在贡献说明中记录来源网址、版本、许可证及使用路径，
并按原许可证保留版权声明、LICENSE 和适用的 NOTICE；不要用本项目声明替换原作者声明。
根目录 `NOTICE` 用于项目归属及需要随发布保留的上游声明，不作为推广页面，也不替代依赖自身的许可证。

## 契约改动

`contract/ai-execution-v1.schema.json` 是本仓库版本化的唯一契约副本。Purefect 平台升级契约时，必须
逐字节复制平台文件和共享 examples，按[契约同步流程](./docs/control-plane.md#契约同步流程)运行本仓库
测试，并与对应平台提交一起评审；不得让 CI 静默依赖同级 `purefect-platform` checkout。

提交信息使用简洁的 Conventional Commit 风格，例如：

```text
feat: 增加新的 Harness Driver
fix: 租约丢失时撤销工具 capability
docs: 更新 Broker 部署说明
```

版本发布由维护者按[发布流程](./docs/releasing.md)执行。普通贡献不应创建版本 tag、修改已经发布的
changelog 条目或手工上传同名发行物。
