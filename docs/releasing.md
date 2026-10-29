# 发布流程

SandLane 使用语义化版本。`0.x` 表示公共运行时 API 仍处于实验阶段，不表示可以跳过发布门禁或兼容性
说明。正式 Release 发布源码、可安装 tarball 和 GHCR 容器，不发布 npm registry 包。

## 发布前

1. 在 `CHANGELOG.md` 中把候选内容从 `Unreleased` 收敛到目标版本，并写明日期和已知限制；
2. 同步 `package.json` 与 `package-lock.json` 的版本；
3. 确认候选提交已合入 `main`，其 CI 全部成功；
4. 核对 README、Demo、安装说明和安全边界，不把 fixture 或单元测试描述为生产验收；
5. 核对真实 CLI/模型验证所使用的固定版本，并保留仍未验证的组合说明。

本地复验：

```bash
env -u NODE_OPTIONS npm run check
npm run format:runtime:check
npm test
npm audit --omit=dev
npm run package:check
npm run demo
npm run demo -- --scenario=cancel
npm run demo -- --scenario=lease-loss
git diff --check
```

这些命令不代替目标 Linux、真实 CLI、真实模型或控制面的发布验收。

## 创建版本

从已经通过 CI 的 `main` 提交创建 annotated tag；具备签名条件时优先使用 signed tag：

```bash
git switch main
git pull --ff-only
git tag -a v0.1.1 -m "Purefect SandLane v0.1.1"
git push origin v0.1.1
```

`Container images` 工作流会再次校验：

- tag 指向 `main` 历史中的提交；
- tag 与 `package.json` 版本一致；
- `CHANGELOG.md` 存在对应版本；
- syntax/type、format、单元测试、生产依赖审计与实际 tarball 消费测试通过。

门禁通过后，工作流发布 runtime、Relay、Codex、Qwen Code 与 OpenCode 的 `linux/amd64`、`linux/arm64`
镜像，生成 SBOM 和 provenance，再创建 GitHub Release，附加
`purefect-sandlane-<version>.tgz` 与 `SHA256SUMS`。Claude Code 镜像不由该工作流发布；
工作流也不会向 npm registry 发布。

## 发布后

1. 确认 GitHub Release、tarball 和校验文件可下载；
2. 确认五个 GHCR package 为 public，`<version>`、`<major>.<minor>` 和 `latest` manifest 均包含两种架构；
3. 从 Release tarball 在干净的 Node.js 20/22 环境完成一次消费者安装；
4. 运行文档中的无凭据 Demo，并抽查所有公开链接；
5. 发布公告应引用 `CHANGELOG.md` 的验证边界和已知限制，不使用“生产级验证完成”等未经证明的表述。

已发布 tag 不重写、不删除。发现问题时在 Release 中记录影响，必要时标记为 prerelease 或 deprecated，
并发布新的 patch 版本修复。
