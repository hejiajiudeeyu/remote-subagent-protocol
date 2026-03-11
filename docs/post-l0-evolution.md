# Post-L0 演进规划（v0.2+）

本文档承接所有不属于 `L0 local transport` 最小闭环、但已经确认有价值的后续能力。

使用原则：
- `docs/l0/architecture.md`、`docs/l0/platform-api-v0.1.md`、`docs/l0/integration-playbook.md` 只保留 L0 必需能力。
- 任何需要额外协议状态、外部 transport 约束、长期运维能力或治理流程的内容，统一迁入本文档。

## 1. 术语映射

为避免“协议角色”和“参考实现组件”混在一起，后续文档统一采用以下映射：

| 语义层 | 推荐术语 | 说明 |
| :--- | :--- | :--- |
| 买方本地智能体 | `Buyer Agent` / `Local Agent` | 运行在 buyer 侧的本地编排者，负责选路、组装合约、验收结果 |
| 远端可调用能力 | `Remote Subagent` | 协议中的远端执行能力单元，由 `seller_id + subagent_id` 唯一标识 |
| 提供方身份 | `Seller` | 远端能力的发布者 / 维护者 / 资源归属主体 |
| 买方实现组件 | `Buyer Controller` | 本仓库中的参考实现组件，不是新的协议角色 |
| 卖方实现组件 | `Seller Controller` / `Seller Runtime` | 本仓库中的参考实现组件，用于承载 Remote Subagent 的接单、鉴权、回包 |

建议：
- 面向协议读者或外部接入方时，优先使用 `Buyer Agent (Local Agent)` 与 `Remote Subagent`。
- 面向本仓库参考实现时，再使用 `Buyer Controller`、`Seller Controller`、`Seller Runtime Template` 等实现术语。
- `Seller Agent` 这个词尽量少作为协议主叙事使用，因为它容易和 `Remote Subagent` 本体混淆。

## 2. 已迁出的后续能力

以下能力不再占用 L0 主规范正文：

### 2.1 身份与注册治理
- 在线提交 remote subagent 草案的正式 API
- subagent registration 审核流、导入流、灰度发布流
- API key 轮换 / 吊销 / 细粒度审计
- 卖家公钥轮换与双 key 窗口

### 2.2 目录与检索
- `GET /v1/catalog/search`
- `GET /v1/catalog/snapshot`
- `GET /v1/catalog/changes`
- 候选筛选策略配置、解释字段、领域策略

### 2.3 传输与会话增强
- Email / SMTP / Webhook 的 subject、thread、header 规范
- Email 结果邮件的 MIME/profile 扩展（当前实现已固定为“纯 JSON 正文 + 可选附件工件”）
- 多 transport 节点发现、relay、mailbox namespace
- 多轮对话 / 会话化交互

### 2.4 状态、观测与治理
- `RUNNING / PROGRESS` 事件
- 人工复核 / `DISPUTED` 全流程
- metrics 聚合查询、告警规则、仪表盘
- 多租户调度扩展（如 `tenant_quota`）

## 3. 多轮对话能力

### 3.1 目标

当前 L0 只覆盖“单次请求 -> ACK -> 单次结果包”的闭环。  
后续如果要支持 `Buyer Agent` 与 `Remote Subagent` 的多轮次对话，需要把一次调用从“单包任务”升级为“会话（session）”。

适用场景：
- Remote Subagent 需要追问补充信息
- Buyer Agent 需要逐轮澄清要求或验收中间产物
- 任务天然是对话式协作，而不是单次离散执行

### 3.2 为什么不放进 L0

多轮对话会显著增加协议复杂度，因为它至少会引入：
- `session_id` 与 `turn_id` 语义
- 谁在等谁回复的状态机
- 会话级超时与单轮超时
- transcript 完整性与验签边界
- 中间轮次是否允许工具调用、是否允许部分结果、何时终态

结论：
- 不建议把多轮对话纳入当前 L0。
- L0 应先把“单次委托执行”的最小真相源稳定下来。
- 多轮对话建议进入 `post-L0 / v0.2+`，并在单轮闭环、ACK、签名、超时、目录和 transport 抽象稳定后再做。

### 3.3 建议的最小设计

如果进入下一阶段，建议采用“会话包裹单轮消息”的方式，而不是推翻现有单轮模型。

建议新增的最小字段：
- `session_id`：一次多轮交互的会话标识
- `turn_id`：当前轮次标识
- `parent_turn_id`：回复所对应的上一轮
- `speaker`：`buyer_agent | remote_subagent`
- `message_type`：`message | clarification | partial_result | final_result | error`
- `expects_reply`：当前轮是否要求对方继续回复
- `session_status`：`OPEN | WAITING_REMOTE | WAITING_LOCAL | COMPLETED | FAILED | TIMED_OUT`
- `turn_timeout_s`：单轮等待时限
- `transcript_hash`（可选）：用于绑定到当前已确认对话历史

建议沿用现有字段：
- `request_id` 仍保留，作为整次任务/会话的全局主键
- `thread_hint` 继续作为 transport 侧关联辅助
- 最终结果仍通过签名结果包收束

### 3.4 推荐的鉴权方式

不建议每一轮都重新签发独立 task token。  
更合理的方式是：
- 会话开始时，由 buyer 申请一次 `session-scoped token`
- token 绑定 `request_id/session_id/buyer_id/seller_id/subagent_id`
- 每一轮 turn 只携带 `session_id + turn_id`，由卖方基于会话上下文校验

这样可以避免：
- 每轮都重新走平台签发
- token 风暴
- turn 级鉴权状态难以收敛

### 3.5 推荐的状态机演进

建议在 v0.2+ 才引入以下会话状态：
- Buyer 侧：`CREATED -> SENT -> ACKED -> WAITING_REMOTE/WAITING_LOCAL -> terminal`
- Remote Subagent 侧：`RECEIVED -> ACKED -> WAITING_REMOTE/WAITING_LOCAL -> FINALIZING -> terminal`

L0 不需要这些状态。

### 3.6 何时实现

建议的顺序：
1. 先完成 L0 单轮闭环
2. 再完成至少一种稳定的外部 transport 适配器
3. 然后引入会话级字段与状态机
4. 最后再考虑多轮对话与会话级观测

换句话说：
- 现在不应该把它并入 L0 必做清单
- 但现在就应该在术语和字段命名上避免堵死后续演进路径

## 4. 仓库拆分

L0 闭环稳定后，当前 monorepo 将拆分为三个独立仓库：

| 仓库 | 职责 |
| :--- | :--- |
| `delegated-execution-protocol` | 协议定义（角色、对象模型、授权、合同、结果验证、版本兼容） |
| `delegated-execution-client` | 终端用户统一客户端（buyer 主流程、seller 预置与启用、marketplace 接入） |
| `delegated-execution-platform-selfhost` | 平台自部署方案（平台服务、部署配置、运维、监控） |

拆分时机、依赖拓扑、共享包归属、预拆分准备及执行步骤的完整规划见 `design/repo-split-plan.md`。

## 5. 推荐的近期迁移动作

在 L0 主规范之外，后续能力建议按以下顺序恢复：

1. `POST /v1/catalog/subagents` 正式 subagent registration API
2. `GET /v1/metrics/summary` 聚合查询
3. 外部 transport adapter（Email MCP / SMTP API / HTTP Webhook）
4. 目录快照 / 增量接口
5. 会话化多轮对话
6. 人工复核与治理流程

## 6. 对当前命名的建议

建议未来逐步收敛为两层命名：

### 6.1 协议层
- Buyer
- Buyer Agent（Local Agent）
- Seller
- Remote Subagent
- Platform

### 6.2 参考实现层
- Buyer Controller
- Seller Controller
- Seller Runtime Template
- Transport Adapter

这样可以保持：
- 对外协议叙事更稳定
- 对内实现命名不必强行重命名代码目录
