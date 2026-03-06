# Remote Subagent Protocol 架构设计（MVP）

## 1. 范围与原则

### 1.1 MVP 目标
- 先用 `L0 local transport` 验证 `Remote Subagent Protocol` 闭环是否成立；外部通信保持为 `Transport Adapter` 抽象，`Email MCP` 只是候选实现之一。
- 平台只做最小控制面：目录、token、投递元数据、事件、指标聚合。
- 买家仅处理输入输出，不承载卖家执行依赖。
- marketplace、broker 和垂直运营层被视为协议上的上层实现，不纳入当前协议核心定义。

### 1.2 非目标
- 不做实时低延迟通道保证（MVP 默认按异步通信模型设计）。
- 不做复杂结算与争议仲裁系统（仅保留仲裁状态与最小证据）。
- 不做完整信誉分与复杂排序（先以硬指标展示）。

### 1.3 关键设计原则
- 合约优先：所有交互可落地为结构化 JSON。
- 幂等优先：`request_id` 贯穿全链路。
- 可迁移优先：传输通道通过适配器抽象，与业务状态机解耦。
- 最小信任：短期 token + 结果签名，平台不托管长期密钥。
- 模式解耦：`L0-L3` 的差异仅体现在 controller 间的通信拓扑与运行边界，不得改变核心协议语义、请求/结果结构、状态机迁移规则与幂等规则。

补充命名语义：
- 本协议中的 `Remote` 指执行边界与信任边界，而不是物理部署距离。
- 因此，单机 `L0 local transport`、局域网 `L2`、以及外部通道 `L3` 都可以是 `Remote Subagent Protocol` 的有效运行模式。

### 1.4 文档真相源与衍生物分层

为避免同一事实在多个文档中重复发明，本仓库采用“真相源 -> 规范层 -> 说明层”的文档分层。

- 真相源（runtime truth sources）
  - `apps/*/src/server.js`：运行时 API 行为、鉴权分支、状态迁移、实际返回结构
  - `tests/integration/*`、`tests/e2e/*`：运行时行为验证
  - `docs/templates/subagents/*/*.json`：模板输入输出结构与示例
  - `tests/unit/schema-validation.test.js`：模板 schema 机械校验
- 原则级真相源（architecture truth source）
  - `docs/architecture-mvp.md`：系统边界、角色职责、模式不变量、语义分层、版本与信任模型
- 规范层衍生物（normative derivatives）
  - `docs/platform-api-v0.1.md`：对外 API 规范说明，必须贴合运行时真相源
  - `docs/integration-playbook-mvp.md`：端到端接入与联调手册，必须贴合运行时真相源与架构不变量
  - `docs/defaults-v0.1.md`：冻结默认参数，必须贴合实现与架构约束
- 说明层衍生物（descriptive derivatives）
  - `README.md` / `README.zh-CN.md`
  - `docs/diagrams/*`
  - `docs/checklists/*`
  - `docs/development-tracker.md`

维护规则：

- 说明层文档不得自行发明接口字段、状态枚举、错误码和返回结构。
- 若规范层与运行时真相源冲突，先修正代码或测试，再回补规范层文档。
- 若图示与规范层冲突，以规范层为准，并在同一变更中修图。
- 参考图：`docs/diagrams/doc-truth-source-map.md`

## 2. 系统边界与组件

## 2.1 角色
- 买家（Buyer）
- 卖家（Seller）
- 平台（Platform）
- 可选上层角色：市场运营方（Marketplace Operator）、Broker

## 2.2 MVP 组件
- Buyer Controller Skill
  - 任务拆解、合约构建、token 申请、请求投递、轮询、最小验收、状态管理。
- Seller Agent Template
  - 收件、合约校验、token 校验、执行器调用、结果回传、幂等去重、指标上报。
- Platform Minimal Service
  - 目录注册/查询、模板包下发、token 签发/校验、投递元数据下发、请求事件接收、seller 心跳与可用性判定、指标接收/汇总。
- Transport Adapter Implementations
  - `Local Transport Adapter`（当前已实现）：单机内存队列；提供 `send / poll / ack / peek / health` 最小接口，作为 `L0` 运行模式的 controller 间通信通道。
  - 候选外部实现：`Email MCP Adapter`、`SMTP/API Email Bridge Adapter`、`HTTP/Webhook Adapter`。

## 2.2A 运行模式分层（后续演进约束）

为避免把不同通信方式做成多套协议实现，系统后续演进采用“同一内核、多种运行模式”策略。`L0-L3` 是部署/通信模式，不是四套业务协议。

- `L0: local runtime`
  - 单机并发运行；可包含多 worker、多 subagent 隔离。
  - controller 间通信可通过进程内队列、本机 IPC 或等价本地通道完成。
  - 当前仓库已实现最小内存队列版 `local transport`，用于 Buyer/Seller/Platform 联调与 E2E。
- `L1: local virtual mailbox`
  - 单机运行，但引入本地虚拟中转站 / mailbox namespace，验证异步投递、线程语义与 ACL。
- `L2: LAN relay`
  - controller 跨局域网设备通信，引入节点注册、心跳、路由与断线恢复。
- `L3: external transport bridge`
  - 通过外部异步通道完成 controller 间通信；可实例化为 `Email MCP`、`SMTP/API email bridge`、`HTTP/Webhook relay` 等模式。

所有模式共享以下不变量：

- 统一 `request_id` / `thread_hint` / `message envelope` 语义。
- 统一 ACK、timeout、retry、idempotency 规则。
- 统一 buyer / seller / platform 角色职责。
- 统一结果签名、错误码域和终态判定。

允许变化的只有：

- controller 间消息如何发送、投递、轮询、路由。
- relay / mailbox / network 边界的位置。
- 通信侧鉴权与节点发现的具体实现。

## 2.2B TransportAdapter 最小接口（模式切换边界）

为保证 `L0-L3` 只是运行模式切换而不是协议重写，controller 与通信层之间必须只通过统一的 `TransportAdapter` 交互。业务层不得直接感知“本地队列 / 虚拟邮箱 / LAN relay / MCP / Email / HTTP Webhook”的实现差异。

建议最小接口：

- `send(envelope)`：
  - 输入统一消息封装，至少包含 `message_id`, `request_id`, `thread_hint`, `from`, `to`, `message_type`, `payload`, `created_at`
  - 返回 `accepted`, `transport_message_id`, `accepted_at`
- `poll(cursor)`：
  - 拉取当前 controller 可见的新消息
  - 返回 `messages[]`, `next_cursor`
- `ack(message_id)`：
  - 确认某条传输消息已被本地消费，避免重复投递
- `peek(thread_hint)`（可选）：
  - 按线程或 request 维度查询调试视图，便于 playground / debugger / 运维排障
- `health()`：
  - 返回 transport 当前健康状态、延迟、积压量、模式元信息

统一消息封装建议字段：

- `message_id`：传输消息唯一标识
- `request_id`：业务幂等主键
- `thread_hint`：线程辅助标识
- `from` / `to`：controller 或 mailbox 身份
- `message_type`：如 `task_contract`, `result_package`, `transport_ack`
- `payload`：任务或结果正文
- `meta`：传输侧元数据（priority、ttl、attempt、trace_id）
- `created_at`

实现约束：

- `send/poll/ack` 语义在 `L0-L3` 中必须保持一致。
- transport 层允许“至少一次投递”，但 controller 必须基于 `request_id + message_type` 做幂等。
- transport 层不得重写业务 payload 结构，只能附加 `meta`。
- `health()` / `peek()` 可因模式能力不同而返回不同细节，但返回结构应保持兼容。

## 2.3 信任边界
- 平台信任自身签发 token，不信任任务内容正确性。
- 买家信任平台签发能力，不默认信任卖家回信内容。
- 卖家信任 token 的授权边界，不信任外部输入参数合法性。

当前实现约束：
- Buyer 验签必须使用平台目录/`delivery-meta` 绑定的 `seller_public_key_pem`，不得信任结果包自带公钥。
- Seller 侧敏感平台接口（如 `introspect`、`ack`、`heartbeat`）必须同时满足 `seller scope + seller_id/subagent_id` 资源归属。

## 3. 全局标识与版本策略

## 3.1 必备标识
- `request_id`：一次任务请求全局唯一（UUIDv7 推荐）。
- `user_id`：用户主体标识（注册后默认具备 buyer 角色）。
- `buyer_id`：买家角色标识（可与 `user_id` 同值映射）。
- `seller_id`：卖家角色标识（由 seller agent 审核通过后激活）。
- `subagent_id`：卖家发布的 Remote Subagent 标识。
- `contract_version`：任务合约版本（如 `0.1.0`）。
- `result_version`：结果包版本（如 `0.1.0`）。

v0.1 映射约束（冻结）：
- `buyer_id = user_id`（一对一）
- `seller_id` 在该用户首次 seller agent 审核通过并导入成功时生成
- v0.1 默认一个 `user_id` 仅绑定一个 `seller_id`（后续版本再支持多 seller identity）

## 3.2 兼容策略
- 仅允许向后兼容新增字段（可选字段）。
- 主版本升级表示不兼容变更。
- 买家需声明可接受版本窗口：`accept_contract_versions`。

## 3.3 Schema 演进与版本升级
- **数据库 Migration 工具**：建议使用语言生态主流工具（Node.js 用 `prisma migrate`，Python 用 `alembic`），schema 变更必须提交 PR 且附 migration 脚本。
- **非破坏性变更（v0.1.x）**：新增可选字段，不修改已有字段语义，接收方忽略未知字段。
- **破坏性升级流程（v0.x -> v1.0）**：
  1. 发布弃用通知（目录 API 响应头 `X-Deprecation-Notice` + 邮件通知已注册买卖双方）。
  2. 迁移窗口建议 30 天，期间新旧版本共存。
  3. 共存期间平台按请求中的 `contract_version` 路由至对应处理逻辑。
  4. 窗口结束后旧版本接口返回 `CONTRACT_UNSUPPORTED_VERSION`。
- **多版本路由**：平台维护 `supported_contract_versions` 列表，不在列表中的版本直接拒绝。

## 4. 合约与结果包规范（v0.1）

## 4.1 任务合约字段（最小集）
- `request_id`：幂等主键。
- `contract_version`
- `created_at`（ISO8601）
- `buyer`：`buyer_id`、回信邮箱地址
- `seller`：`seller_id`、目标 `subagent_id`
- `task`：`task_type`、`input`、`output_schema`
- `constraints`：`budget_cap`、`soft_timeout_s`、`hard_timeout_s`
- `token`：短期 task token（JWT 或等价结构）
- `trace`：`thread_hint`、`source_run_id`

示例：
```json
{
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
  "contract_version": "0.1.0",
  "created_at": "2026-03-02T11:20:00Z",
  "buyer": {
    "buyer_id": "buyer_acme",
    "reply_to": "buyer+mvp@croc.tavern"
  },
  "seller": {
    "seller_id": "seller_foxlab",
    "subagent_id": "foxlab.text.classifier.v1"
  },
  "task": {
    "task_type": "text_classification",
    "input": {
      "text": "The package arrived damaged."
    },
    "output_schema": {
      "type": "object",
      "required": ["label", "confidence"],
      "properties": {
        "label": { "type": "string" },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    }
  },
  "constraints": {
    "budget_cap": 0.05,
    "soft_timeout_s": 90,
    "hard_timeout_s": 300
  },
  "token": "<TASK_TOKEN>",
  "trace": {
    "thread_hint": "croc-req-018f9d5e",
    "source_run_id": "run_buyer_20260302_001"
  }
}
```

## 4.2 结果包字段（最小集）
- `request_id`
- `result_version`
- `seller_id`、`subagent_id`
- `status`（当前 wire-level 实现）：`ok | error`
- `output`：成功结果（需满足 `output_schema`）
- `error`：失败时提供 `code`、`message`、`retryable`
- `timing`：`accepted_at`、`finished_at`、`elapsed_ms`
- `usage`：`cost_estimate`、`resource_units`
- `signature`：卖家签名字段（防伪与去重）

说明：
- Seller 当前发送的是 wire-level 结果包：`status=ok|error`
- Buyer Controller 在验签与 schema 校验后，再把本地请求状态归一化为 `SUCCEEDED | FAILED | UNVERIFIED | TIMED_OUT`
- 因此 `ok|error` 是传输层结果语义，`SUCCEEDED|FAILED|...` 是 Buyer 本地状态机语义

示例：
```json
{
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
  "result_version": "0.1.0",
  "seller_id": "seller_foxlab",
  "subagent_id": "foxlab.text.classifier.v1",
  "status": "ok",
  "output": {
    "label": "refund_request",
    "confidence": 0.94
  },
  "timing": {
    "accepted_at": "2026-03-02T11:20:18Z",
    "finished_at": "2026-03-02T11:20:21Z",
    "elapsed_ms": 3100
  },
  "usage": {
    "cost_estimate": 0.02,
    "resource_units": 1
  },
  "signature": "seller_sig_v1:base64..."
}
```

## 4.3 邮件 subject 与线程规则
- 任务邮件 subject：`[CROC][TASK][<request_id>] <task_type>`
- 结果邮件 subject：`Re: [CROC][TASK][<request_id>] <task_type>`
- 解析主键永远使用 `request_id`；`thread_id` 仅作辅助。
- 邮件正文建议包含：
  - `Content-Type: application/json` 附件或正文块
  - 明确 `schema_type=task_contract` 或 `schema_type=result_package`

## 4.4 错误结果包与投递元数据规则

### 错误结果包校验（与成功结果同级）
- 当前 wire-level 结果包中，`status=error` 时必须返回 `error.code/message/retryable`。
- Buyer 对错误结果包执行与成功包一致的机械校验：`request_id`、`seller_id/subagent_id`、签名、版本。
- 校验通过的错误结果包可进入 Buyer 反馈循环（重试/换 seller/进入争议），而不是直接丢弃。

### 投递地址暴露策略（v0.1）
- `delivery_address` 不在目录批量查询中下发，避免被目录抓取滥用。
- Buyer 在获取 token 后，通过 `POST /v1/requests/{request_id}/delivery-meta` 单次获取投递地址与线程策略。
- `delivery-meta` 与 `request_id + seller_id + subagent_id + buyer_id` 绑定，过期后不可复用。

## 4.5 能力声明模板（Capability Templates）

### 目的
解决买卖双方信息不对称问题：买家在选择 subagent 后，需要明确**应提供哪些输入**以及**将获得什么格式的输出**。模板机制通过结构化的 schema 和示例实现渐进式披露。

### 模板目录结构
每个已注册 subagent 在仓库中维护一组模板文件：

```
docs/templates/subagents/{subagent_id}/
├── input.schema.json      # 输入 JSON Schema，定义 task.input 字段
├── output.schema.json     # 输出 JSON Schema，定义 task.output_schema
├── example-contract.json  # 完整合约示例
├── example-result.json    # 完整结果包示例
└── README.md              # 能力说明、标签集、约束、快速开始
```

### 目录关联
目录条目新增 `template_ref` 字段，作为该 subagent 模板语义绑定键：
```json
{
  "subagent_id": "foxlab.text.classifier.v1",
  "template_ref": "docs/templates/subagents/foxlab.text.classifier.v1/",
  ...
}
```

### 渐进式披露流程
1. **浏览目录**：买家查询 `/v1/catalog/subagents`，获得概要信息（description、capabilities、pricing_hint 等）。
2. **选择 subagent**：买家确定目标 subagent 后，通过 `GET /v1/catalog/subagents/{subagent_id}/template-bundle?template_ref=...` 获取模板包。
3. **构造合约**：买家参照 `input.schema.json` 填写 `task.input`，用 `output.schema.json` 设定 `task.output_schema`。
4. **参考示例**：`example-contract.json` 和 `example-result.json` 提供端到端的请求-响应样本。

### 模板维护规范
- 模板文件由卖家维护，通过 PR 提交更新。
- Schema 变更遵循合约版本策略（§3.2）：仅允许向后兼容新增字段。
- 平台在合并模板 PR 后自动更新目录的 `updated_at` 时间戳。
- MVP 阶段模板仍存储在 Git 仓库中，但对 Buyer 统一通过平台 API 下发，不暴露仓库直读依赖。

## 5. Token 与签名模型

## 5.1 Task Token 必备 claims
- `iss`：platform issuer
- `aud`：目标 `seller_id`
- `sub`：`buyer_id`
- `request_id`
- `subagent_id`
- `budget_cap`
- `iat`、`nbf`、`exp`
- `jti`（唯一 token id）

## 5.2 校验规则
- 卖家必须校验 `aud/sub/request_id/subagent_id/exp`。
- v0.1 卖家统一通过 `introspect` 在线校验 token。
- token 默认短效（建议 10-20 分钟，需覆盖邮件投递延迟），超时拒绝执行。
- **introspect 性能目标**：P99 < 200ms。服务端建议对 introspect 加简单缓存（token hash -> 校验结果，TTL 30s），降低重复校验开销。
- **本地校验预留（v0.2）**：后续可支持卖家缓存平台公钥进行本地 JWT 验签，仅对高风险或异常请求 fallback 到在线 introspect。

## 5.3 结果签名
- 卖家使用私钥对结果包 canonical JSON 签名。
- 买家通过目录中的卖家公钥验证签名。
- 签名失败结果标记为 `UNVERIFIED`，不进入成功统计。

## 5.4 Token 传输安全
- 邮件通道不保证端到端加密，token 在传输中存在被截获的理论风险。
- MVP 接受此风险，依靠三重防护组合降低实际影响：
  1. **单次使用**：`jti` 全局唯一，卖家通过 introspect 去重，同一 token 无法重放。
  2. **短时效**：token TTL 默认 15 分钟，攻击窗口极小。
  3. **request 绑定**：token claims 中绑定 `request_id/buyer_id/seller_id/subagent_id`，无法挪用到其他请求。
- 后续迁移到 HTTPS 传输通道后，此风险自然消除。

## 5.5 API Key 生命周期
- **签发**：用户主体注册成功后，平台签发 API Key（默认 `role_scopes={buyer}`）。
- **轮换流程**：
  1. 主体申请新 key（平台签发，旧 key 仍有效）。
  2. 双 key 共存窗口：建议 24 小时。
  3. 窗口结束后旧 key 自动失效。
- **泄露应急**：
  - MVP 阶段支持人工通知平台管理员手动吊销。
  - 后续规划 `POST /v1/keys/revoke` 自助吊销接口。
- **权限隔离（RBAC）**：服务端按 key 绑定的 `role_scopes` 做鉴权与资源校验。默认仅 `buyer`；`seller` scope 由 seller agent 审核通过后激活。卖家接口还需校验资源归属（`owner_user_id -> seller_id -> subagent_id` 绑定关系）。

## 5.6 卖家公钥轮换协议
- **触发**：卖家通过表单提交新公钥。
- **流程**：
  1. 平台标记该 subagent 进入 `pending_rotation`，同时存储新旧两把公钥。
  2. 目录查询返回 `seller_public_keys_pem[]`（数组），买家验签时按序尝试：先新 key，失败再 fallback 旧 key。
  3. 双 key 窗口建议 48 小时。
  4. 窗口结束后旧 key 自动下线，目录恢复为单 key。
- **约束**：轮换期间卖家不得再次提交新 key（排队等上一次轮换完成）。

## 6. 状态机与重试幂等

## 6.1 请求状态机（Buyer 视角）
- `CREATED`：合约已生成
- `SENT`：任务请求已发出
- `ACKED`：卖家已接收并通过基础校验
- `RUNNING`：卖家开始执行
- `SUCCEEDED`：通过最小验收
- `FAILED`：卖家失败或业务失败
- `TIMED_OUT`：超过硬超时
- `UNVERIFIED`：签名或 schema 验证失败
- `DISPUTED`：人工仲裁中（见 6.8 最小争议通道）

## 6.2 请求状态机（Seller 视角）
- `RECEIVED`：收件成功，已提取合同
- `AUTH_CHECKING`：校验 API key/introspect/claims
- `CONTRACT_CHECKING`：字段、版本、预算、任务类型校验
- `QUEUED`：通过校验并入队等待 worker
- `RUNNING`：worker 已取任务执行
- `RESULT_PACKED`：成功结果封包完成
- `ERROR_PACKED`：错误结果封包完成
- `REPLIED`：同线程回信已发出
- `DONE`：流程结束（含回放命中）

## 6.3 请求状态机（Platform 视角）
- `REQUEST_REGISTERED`：买家 request 建立
- `TOKEN_ISSUED`：task token 已签发
- `DELIVERY_META_ISSUED`：投递元数据已下发
- `ACK_RECORDED`：卖家 ACK 已记录
- `TIMEOUT_RECORDED`：买家超时已记录
- `CLOSED`：请求闭环结束（成功/失败/超时）

## 6.4 幂等与去重语义
- 卖家侧以 `request_id` 作为唯一执行键。
- 同 `request_id` 重复到达时：
  - 若已完成，直接回放同一结果包（不重复执行）。
  - 若执行中，返回 `EXEC_IN_PROGRESS`。
- 幂等窗口建议不少于 24 小时。

## 6.5 Seller 队列机制（MVP 建议）
- 入队时机：通过合约与 token 校验后进入 `QUEUED`，再发送 ACK。
- 调度策略：默认 `priority + enqueue_at(FIFO)`，并叠加 `tenant_quota` 防止单租户挤占。
- worker 机制：`lease_ttl + heartbeat`；worker 异常时任务回退到 `QUEUED`。
- 拒绝语义：队列压力超过阈值返回 `EXEC_QUEUE_FULL` 与 `retry_after_s`。
- 观测项：`queue_depth`、`queue_wait_ms_p95`、`run_ms_p95`、`queue_reject_rate`。

## 6.6 重试策略
- 买家只在 `retryable=true` 或传输失败时重试。
- 退避策略：指数退避 + 抖动，最多 3 次。
- 超过 `hard_timeout_s` 不再重试，直接标记 `TIMED_OUT`。

## 6.7 Buyer 超时确认与轮询接口（MVP）

- `soft_timeout_s` 到达时：Buyer Controller 默认向 Buyer Agent 发出“是否继续等待”询问（`timeout_confirmation_mode=ask_by_default`）。
- `hard_timeout_s` 到达时：若未收到明确继续等待指令，Buyer Controller 自动将请求终态设为 `TIMED_OUT`。
- `TIMED_OUT` 语义：结束 Buyer 本地等待与轮询，不保证也不要求远端 Seller 进程被 kill。

Buyer Controller -> Buyer Agent 最小查询接口（内部接口）建议：
- `GET /controller/requests/{request_id}`
- 返回最小字段：`request_id`、`status`、`ack_status`、`soft_timeout_at`、`hard_timeout_at`、`last_error_code`、`updated_at`。
- 终态返回：`final_result` 或 `final_error`（二选一）。

Buyer Agent -> Buyer Controller 超时决策接口（内部接口）建议：
- `POST /controller/requests/{request_id}/timeout-decision`
- 请求字段最小集：`continue_wait`（布尔）、`decided_at`（ISO8601 UTC）、`note`（可选）。
- 响应语义：返回当前 `status` 与最新 `hard_timeout_at`（若允许延长则同步返回调整后值）。

## 6.8 最小争议通道（MVP）
- **触发条件**：买家对状态为 `SUCCEEDED` 的结果提出质量异议（签名和 schema 均通过，但输出内容不符合预期）。
- **最小流程**：
  1. 买家发送争议邮件至 `disputes@croc.tavern`，附 `request_id` 和异议描述。
  2. 平台管理员人工审核，将该请求状态标记为 `DISPUTED`。
  3. 人工跟进处理（协调买卖双方或直接裁定）。
  4. 处理完毕后状态迁移至 `SUCCEEDED`（维持）或 `FAILED`（改判）。
- **MVP 约束**：不进入自动化仲裁，不影响卖家指标统计（除非改判为 `FAILED`）。
- **证据留存**：争议邮件、原始合约、结果包、买家异议描述，最小保留 180 天。

## 7. 超时模型（分层）
- `T_delivery`：邮件投递/收取耗时。
- `T_queue`：卖家排队等待耗时。
- `T_exec`：卖家执行耗时。
- `T_accept`：买家验收耗时。

总耗时：`T_total = T_delivery + T_queue + T_exec + T_accept`  
指标展示需拆层，否则无法定位瓶颈。

## 8. 错误码体系（v0.1）

建议错误码前缀分域：
- `AUTH_*`
  - `AUTH_INVALID_TOKEN`
  - `AUTH_TOKEN_EXPIRED`
  - `AUTH_AUDIENCE_MISMATCH`
- `CONTRACT_*`
  - `CONTRACT_SCHEMA_INVALID`
  - `CONTRACT_UNSUPPORTED_VERSION`
  - `CONTRACT_BUDGET_EXCEEDED`
- `EXEC_*`
  - `EXEC_TIMEOUT`
  - `EXEC_IN_PROGRESS`
  - `EXEC_INTERNAL_ERROR`
- `RESULT_*`
  - `RESULT_SCHEMA_INVALID`
  - `RESULT_SIGNATURE_INVALID`
- `DELIVERY_*`
  - `DELIVERY_FAILED`
  - `DELIVERY_DUPLICATE`
  - `DELIVERY_PARSE_FAILED`
  - `DELIVERY_RATE_LIMITED`
- `PLATFORM_*`
  - `PLATFORM_RATE_LIMITED`

## 9. 指标与评测最小闭环

## 9.1 卖家上报指标（最小）
- `request_count`
- `success_count`
- `timeout_count`
- `schema_fail_count`
- `p95_exec_ms`

## 9.2 买家观测指标（对照源）
- `buyer_seen_success_rate`
- `buyer_seen_timeout_rate`
- `buyer_seen_unverified_rate`
- `buyer_p95_end_to_end_ms`

## 9.3 排序与展示建议（MVP）
- 仅展示硬指标，不做综合信誉分。
- 增加样本门槛：如 `n >= 30` 才参与榜单排序。
- **同类对比**：支持按 `capability` 维度的横向指标对比表，便于买家在同类 subagent 间选择。
- **最小徽章机制**：`sample_size >= 100` 且 `success_rate >= 0.95` 的 subagent 可标注"高可靠"徽章。
- **平台验证任务（后续预留）**：平台定期向已注册 subagent 发送标准化测试任务，形成平台侧独立评测数据，与买家上报指标交叉验证。

## 9.4 卖家可用性信号（心跳）

- 卖家周期心跳上报（建议 30 秒一次）。
- 平台维护 `availability_status`：`healthy|degraded|offline`。
- 买家选路优先 `healthy`，`offline` 默认不选。

## 9.5 最小监控告警（MVP）
- **平台存活检测**：提供 `GET /healthz` 端点，外部探针每 30 秒轮询。
- **告警规则（最小集）**：
  - heartbeat 掉线率 > 50%（全局卖家维度，1 分钟窗口）：触发系统级告警。
  - token 签发失败率 > 5%（1 分钟窗口）：触发平台异常告警。
  - introspect P99 > 500ms（5 分钟窗口）：触发性能降级告警。
  - 目录查询错误率 > 10%（5 分钟窗口）：触发服务异常告警。
- **告警通道（MVP）**：结构化日志 + 邮件通知管理员。后续接入 Slack/Webhook。
- **运维仪表盘（MVP）**：基于 `metrics_daily_agg` 表，展示每日调用量、成功率趋势、卖家在线率。

## 10. 传输适配器抽象（为后续迁移准备）

定义统一接口（伪代码）：
```ts
interface TransportAdapter {
  sendTask(contract: TaskContract): Promise<DeliveryReceipt>;
  pollResults(query: ResultQuery): Promise<ResultPackage[]>;
  ackResult(requestId: string, resultId: string): Promise<void>;
}
```

MVP 实现：`EmailMcpTransportAdapter`  
后续可替换为：`HttpWebhookTransportAdapter`、`QueueTransportAdapter`。  
要求：业务状态机与合约校验逻辑不得依赖具体适配器。

## 11. 目录检索可扩展性（MVP 到增强）

MVP 阶段目录项较少，可用“遍历 + 分类过滤”。
MVP 明确不实现搜索引擎能力（联想、模糊、语义召回、复杂排序）。

### 11.1 MVP 检索模式
- 模式 A：全量遍历（`status=active`，可按 `availability_status=healthy` 过滤）
- 模式 B：词条分类（`capability/category/task_type`）

### 11.2 演进目标（后续）
- 联想检索：支持 query suggestion（前缀、同义词、热门词）
- 模糊搜索：拼写容错、近义表达、宽松匹配
- 细分领域策略：按领域启用不同排序特征与阈值

### 11.3 架构约束（避免重构）
- 查询接口版本化：保留 `/v1/catalog/subagents`，新增 `/v1/catalog/search` 时不破坏旧接口。
- 排序策略外置：以 `ranking_profile` 标识策略，不硬编码在 buyer。
- 检索与执行解耦：buyer 只消费候选结果，不耦合检索引擎实现。
- 可解释输出：返回 `match_reasons` 与 `score_breakdown`（后续字段）。

## 12. 风险与缓解

### 12.1 传输通道风险
- 邮件乱序/重复：以 `request_id` 去重，结果包带序号或最终态标记。
- 邮件延迟不可控：超时分层统计 + 明确 SLO 仅对 `T_exec` 生效，`T_delivery` 独立预算（默认 60 秒）。
- 邮件服务商限流：MVP 阶段约定发送速率上限 10 封/分钟。建议使用独立域名邮箱（非 Gmail/Outlook 个人号），避免触发反垃圾策略。
- JSON 解析失败：收件方遇到乱码、编码异常或正文截断时，返回 `DELIVERY_PARSE_FAILED`，不进入执行流程。
- 邮件编码约定：正文统一 UTF-8 编码；JSON 体积 > 4KB 时优先放附件（`application/json`），正文仅放人可读摘要。

### 12.2 安全风险
- token 泄露重放：短时效 + `jti` 记录 + request 绑定。
- 伪造回信：强制签名验签，不通过即 `UNVERIFIED`。

### 12.3 外部依赖风险
- **邮箱 MCP**：如果 MCP 协议更新或弃用，需更新 `EmailMcpTransportAdapter`。已通过传输适配器抽象隔离，影响范围限于适配器层。
- **邮箱服务商**：如果服务商变更 API 限制或封禁自动化发送，需切换服务商或降低发送速率。建议使用自有域名邮箱降低风险。
- **PostgreSQL**：主流开源数据库，生态成熟，风险低。
- **Ed25519 签名库**：标准算法，各语言均有成熟实现，风险低。
- **缓解措施**：进入编码阶段后维护 `DEPENDENCIES.md`，记录所有外部依赖的版本、替代方案和风险评级。

## 13. MVP 验收用例（E2E）
- 用例 1 成功：返回合规输出并通过签名验签。
- 用例 2 超时：卖家超 `hard_timeout_s`，买家标记 `TIMED_OUT`。
- 用例 3 token 过期：卖家拒绝并返回 `AUTH_TOKEN_EXPIRED`。
- 用例 4 输出不合规：卖家回包 schema 不符，买家标记 `UNVERIFIED` 或 `FAILED(RESULT_SCHEMA_INVALID)`。

---

该文档是 v0.1 架构基线，用于指导后续实现任务拆解与接口定义冻结。
