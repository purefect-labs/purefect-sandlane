# 部署文件

本目录收纳镜像构建和Compose清单。以下命令均在**仓库根目录**执行。
首次体验直接运行 `npm run demo` 或按[交互式 Demo](../docs/demo.md)运行 `npm run demo:chat`，无需手动组合清单。

| 文件 | 用途 |
| --- | --- |
| `Dockerfile.runtime` | Worker与Broker镜像 |
| `Dockerfile.relay` | 隔离网络Relay镜像 |
| `Dockerfile.cli` | 固定版本Codex CLI镜像 |
| `Dockerfile.cli-claude` | 固定版本Claude Code镜像 |
| `Dockerfile.cli-qwen` | 固定版本Qwen Code开源CLI镜像 |
| `Dockerfile.cli-opencode` | 固定版本OpenCode开源CLI镜像 |
| `Dockerfile.cli-ca` | 在CLI镜像中加入网关CA |
| `compose.runtime.yaml` | Purefect部署基础清单 |
| `compose.purefect.yaml` | managed网络与Relay参考覆盖清单 |
| `compose.demo.yaml` | 独立Demo拓扑，由脚本生成身份、证书和覆盖配置 |

```bash
npm run build
docker build -f deploy/Dockerfile.runtime -t purefect/ai-runtime:local .
docker build -f deploy/Dockerfile.relay -t purefect/sandlane-relay:local .
docker build -f deploy/Dockerfile.cli --build-arg CODEX_VERSION=0.154.0 -t sandlane/codex:0.154.0 .
docker build -f deploy/Dockerfile.cli-qwen -t sandlane/qwen-code:0.26.3 .
docker build -f deploy/Dockerfile.cli-opencode -t sandlane/opencode:1.19.5 .
```

普通镜像仍以仓库根目录为构建上下文，不能将命令末尾的 `.` 改成 `deploy/`。
Codex、Qwen Code和OpenCode镜像可由发布工作流公开生成；Claude Code镜像由部署者按其条款自行构建。
CLI的CA包装由相关脚本准备单独上下文，不需要把Secret放入仓库构建上下文。

Purefect部署步骤见[参考集成](../docs/integrations/purefect.md)。清单合并使用：

```bash
docker compose --env-file /absolute/path/runtime.env \
  -f deploy/compose.runtime.yaml -f deploy/compose.purefect.yaml config --quiet
```

必须先填写参考集成要求的环境变量。此命令仅检查配置，不启动或修改现有部署。
Compose相对宿主路径按第一个清单所在的`deploy/`解析；Secret、客户端目录和自定义overlay挂载推荐使用绝对路径。
基础清单的`build.context: ..`指向仓库根目录，不需要另外指定`--project-directory`。
项目名和既有命名卷保持原定义；文件移动不会替你迁移或重启现有节点。
