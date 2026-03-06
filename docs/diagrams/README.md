# Diagram Index（v0.1）

本目录用于存放 MVP 当前的核心流程图，建议阅读顺序如下：

1. `doc-truth-source-map.md`：文档真相源与衍生物分层图。
2. `user-registration-call-flow.md`：用户注册与 API Key 签发（默认 buyer）。
3. `agent-registration-call-flow.md`：seller agent 提交、审核、导入与 seller 激活。
4. `permission-lifecycle-and-rbac.md`：权限来源、角色状态机、RBAC 触发事件与接口矩阵。
5. `user-remote-subagent-call-flow.md`：Buyer -> Platform -> Seller 主调用链（含失败分支与验收）。

补充说明：
- 所有图采用统一编号体系 `阶段+步骤+后缀`（如 `G3-REQ`, `H1-F1`）。
- 权限变更细节统一以 `permission-lifecycle-and-rbac.md` 为准；其他图仅保留鉴权闸门。
- 文档分层与真相源判定统一以 `doc-truth-source-map.md` 和 `docs/architecture-mvp.md` 第 1.4 节为准。
- 当前 ACK 回传模式为 Pull（`GET /v1/requests/{request_id}/events`）。
- 接口字段与返回结构以 `docs/platform-api-v0.1.md` 为唯一规范源；图中若与 API 文档冲突，以 API 文档为准并需回补改图。
- Buyer 超时确认默认策略：`soft_timeout` 询问、`hard_timeout` 自动终态 `TIMED_OUT`；该语义不等价于远端进程 kill。
