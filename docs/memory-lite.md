# 精简摘要与个人记忆

2026-10-14。第二批代码已实现，默认关闭，尚未启用共享Host或验证真实摘要模型。没有引入向量库、AgentScope、Python或新的常驻服务。此前部署的同会话历史回放不受此开关影响。

## 配置

配置放在 Worker 宿主，不进入临时 CLI 容器：

```dotenv
SANDLANE_MEMORY_ENABLED=true
SANDLANE_MEMORY_DIRECTORY=/absolute/state/dir
SANDLANE_MEMORY_TOPOLOGY=single-host
# 以下三项完整配置后才启用后台摘要
SANDLANE_MEMORY_SUMMARY_BASE_URL=https://your-provider.example/v1
SANDLANE_MEMORY_SUMMARY_MODEL=your-summary-model
SANDLANE_MEMORY_SUMMARY_KEY_FILE=/host-config/summary-model-key
```

需要Node >=22.13的node:sqlite；当前Docker使用Node24。记忆存于`SANDLANE_MEMORY_DIRECTORY/memory/memory.sqlite`（Worker 组合入口 `bin/worker.ts` 按此装配 ContextProvider 装饰器），目录0700、文件0600。Key文件只挂载到Host，不交给CLI。不复用已结束Run的临时凭据。使用HTTPS兼容`/chat/completions`接口，禁止重定向和工具调用；供应商模型参数兼容性需要实测。

SQLite适配器只支持单Host部署，`single-host`是运维声明而非自动集群探测。多节点需要共享后端及摘要队列适配，不能每个Host各存一份。未配置摘要模型时个人记忆可用，但不会生成摘要；待处理任务会持久保留。

## 显式个人记忆

仅本轮用户输入的`/memory `前缀触发管理操作；旧消息、工具结果和模型输出不能触发。自然语言“记住”不代表已持久化。

```text
/memory {"action":"remember","kind":"preference","text":"默认使用中文，回答简洁"}
/memory {"action":"list"}
/memory {"action":"correct","id":"列表返回的ID","revision":"1","text":"默认中文，技术问题保留必要细节"}
/memory {"action":"forget","id":"列表返回的ID"}
```

- tenant/user来自可信派发，不允许用户指令选择身份。接口预留assignment，当前Workbench个人记忆不按任职细分。
- kind支持preference/fact/experience；最多20条，单条500字节，正文合计4000字节，另限制JSON转义后的预算。超限明确拒绝，不静默丢弃。
- 更正带revision，修改以Run ID幂等；删除后旧请求重放不能复活卡片。管理操作先提交存储再调用CLI，所以模型失败不回滚已成功的记忆操作。
- 全部小型卡片作为普通数据注入本轮CLI，不提升为系统权限。管理结果来自存储；模型口头答复不能替代存储状态。list展示ID和revision，确定性管理UI/API由产品层后续实现。
- `ExplicitMemoryProvider`是可选扩展；外部适配仍须实现超时、结果范围复核和集成测试，不是替换类名即可上线。

## 摘要规则与CLI初始化

每轮新CLI仍由Host装配“个人记忆 + 已发布摘要 + 未覆盖近期原文 + 本轮问题/页面数据”。容器及CLI销毁不会删除Host持久记忆；跨会话只携带同一用户个人卡片，不携带别的会话摘要。切换模型/CLI后复用通用输入数据，不依赖原生resume。

下一次提交到达Host时，使用Engine已确认保存的历史入队；不把CLI未回写的结果当成已完成事实。至少8个未覆盖轮次触发，保留最近4轮原文，旧摘要加新增轮次增量合并。

后台单消费者处理持久任务：120秒租约、90秒模型截止、最多3次尝试，失败按30/60秒退避。发布核对所有权、租约和revision；旧任务、过期任务、reset后的结果不能覆盖新摘要。摘要输入64KB、输出8KB上限。模型调用不阻塞本轮首字，但本地读取/入队仍有成本；新摘要只在后续轮次使用。

失败保留旧摘要；额外摘要超过上下文预算时回退到原始历史，不让可选摘要破坏正常聊天。摘要是派生信息，不保证逐字回忆或证明业务执行成功。

精简版限制：没有字节阈值提前压缩、历史回填API、摘要管理HTTP/UI。首次启用旧会话或后台落后时，如果12轮快照已出现缺口/截断，拒绝伪造连续摘要并报告`MEMORY_SUMMARY_QUEUE_UNAVAILABLE`。需由调用方提供连续历史后重试，不能承诺任意长会话无损恢复。失败3次后保留failed状态，运维可通过`ConversationSummaries.status/reset`处理；reset会清摘要并隔离旧任务，不自动加载平台历史。

## 删除、运维与扩展

删除个人卡片不删除聊天原文、已有摘要及备份。操作记录只留摘要哈希、ID、revision及状态，不留卡片正文；历史操作的searchable表示当时状态，当前存在性以list为准。SQLite/WAL/备份不承诺即时取证级擦除。没有自动TTL及全账户擦除入口，需部署方制定数据保留策略。

备份应停止Host后复制完整memory目录，或使用SQLite一致性备份，不能运行中仅复制主数据库文件。持久卷丢失会丢失个人记忆和摘要，原聊天仍保留在平台。回滚关闭`SANDLANE_MEMORY_ENABLED`并保留卷。

存储/摘要实现不调用Purefect API、不读平台数据库。MemoryProvider和Summarizer允许后续接Mem0/ReMe或其他模型；本地摘要队列在多节点阶段需要共享实现，不将SQLite称作SaaS集群方案。

## 验证范围

`npm test`包含重启恢复、租户/用户/任职隔离、幂等、版本冲突、删除重试、摘要重领/取消/重试/reset、上下文预算、普通数据注入及禁用/目录权限检查。模拟Summarizer通过不代表真实模型摘要质量、成本或首字延迟已经验收。

启用前需配置后台模型，再验证长对话摘要、跨会话个人记忆、更正/删除、容器和Host重启。首字回归排查按用户要求在本批记忆工作后继续。
