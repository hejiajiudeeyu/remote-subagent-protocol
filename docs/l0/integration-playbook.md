# Integration Playbook v0.1（Buyer / Seller / Platform）

本文档回答三个问题：
- 买家端如何发起请求、跟踪状态、验收结果。
- 卖家端如何接收请求、校验执行、回传结果。
- 协议控制面如何把目录稳定地“传给”买家与卖家（控制面分发）。

本文档描述的是 `Remote Subagent Protocol` 的接入方式，以及当前仓库参考实现的联调路径；它不要求未来所有实现共享同一个集中式托管后端。

本手册与以下文档配套：
- `architecture.md`
- `platform-api-v0.1.md`

## 1. 端到端时序（MVP）

1. Buyer 拉取目录，选定 `seller_id + subagent_id`。
2. Buyer 生成 `request_id` 与任务合约。
3. Buyer 调用 `POST /v1/tokens/task` 申请短期 token。
4. Buyer 调用 `POST /v1/requests/{request_id}/delivery-meta` 获取单次投递元数据。
5. 当前实现：Buyer 通过 `POST /controller/requests/{request_id}/dispatch` 把任务 envelope 发送到 `L0 local transport`。
6. 当前实现：Seller 通过 `POST /controller/inbox/pull` 拉取任务，解析合约并继续后续处理。
7. Seller 通过服务端上报 ACK（已接单，可附 ETA）。
8. Seller 执行任务，生成结果包并签名。
9. 当前实现：Seller 通过 `Transport Adapter` 按同一 `request_id` 语义回传结果包，由 Buyer Controller 接收。
10. Buyer 轮询服务端请求事件与结果，按 `request_id` 验签+验 schema（含错误结果包）。
11. Buyer/Seller 分别调用 `POST /v1/metrics/events` 上报最小指标。

## 2. Buyer 端详细流程

## 2.1 启动前准备
- 先完成用户注册（`POST /v1/users/register`）并领取 API Key（默认 `buyer` scope）。
- 配置平台 base URL 与认证信息（仅控制面 API）。
- 配置所选 `Transport Adapter` 能力（当前为 `L0 local transport`；外部模式可为 `Email MCP`、`SMTP/API email bridge`、`HTTP/Webhook`）。
- 维护本地状态表（可 SQLite）：
  - 主键：`request_id`
  - 字段：`status`, `seller_id`, `subagent_id`, `token_exp_at`, `attempt`, `updated_at`

## 2.2 目录查询与选择
- 调用：`GET /v1/catalog/subagents?capability=...&status=active`
- 选择规则建议（MVP）：
  - `status=active`
  - `availability_status=healthy`
  - `template_ref` 可用
  - 若目录提供 `capabilities/supported_task_types`，则应覆盖当前任务
  - 若目录提供 `eta_hint.exec_p95_s`，则应在可接受范围
- 选择后缓存：
  - 缓存键：`subagent_id`
  - TTL 建议：5 分钟

## 2.2.1 拉取能力声明模板（渐进式披露）
- 买家确定目标 subagent 后，读取目录条目中的 `template_ref` 字段（语义绑定键）。
- 调用模板下发接口：`GET /v1/catalog/subagents/{subagent_id}/template-bundle?template_ref=...`
- 响应中读取：
  - `input_schema`：了解需要提供的输入字段
  - `output_schema`：了解将获得的输出格式
  - `example_contract` / `example_result`：若服务端提供，则可作为参考样例
  - `readme_markdown`：若服务端提供，则用于补充能力说明
- 买家 agent 可据此自动构造合约中的 `task.input` 和 `task.output_schema`。
- 可选：使用 `If-None-Match` + `ETag` 做模板缓存与增量刷新。

## 2.3 发起请求
- 生成 `request_id`（UUIDv7）。
- 构造任务合约（见 `architecture.md` 第 4 节）。
- 调用 `POST /v1/tokens/task`，请求体包含：
  - `request_id`, `seller_id`, `subagent_id`
- 将返回 token 放入合约 `token` 字段。
- 调用 `POST /v1/requests/{request_id}/delivery-meta` 拉取：
  - `delivery_address`
  - `thread_hint`
- `delivery_address` 应视为 opaque transport endpoint；仅使用本次 `delivery-meta` 返回的 endpoint 投递请求，不从目录批量字段直接取地址。
- 发送任务请求：
  - 统一 envelope：包含 `request_id / seller_id / subagent_id / payload / thread_hint`
- 本地状态更新：`CREATED -> SENT`
- 当前 `L0` 联调中，`dispatch` 会直接把本地请求状态推进到 `SENT`。

补充说明：
- Email/SMTP/Webhook 等外部 transport 的 subject、线程头和编码规则不属于 L0 主路径，后续按 adapter 文档补充。

## 2.4 ACK 轮询（避免盲等）
- 买家完成任务投递后立即轮询：`GET /v1/requests/{request_id}/events`
- 期望在 `ack_deadline_s`（默认 120 秒，含传输投递延迟）内收到 `ACKED` 事件。
- 若未收到 ACK：
  - 记录 `DELIVERY_OR_ACCEPTANCE_TIMEOUT`
  - 可触发一次重试或切换备选卖家
- 收到 ACK 后状态迁移：`SENT -> ACKED`

## 2.5 结果轮询与验收
- 轮询间隔建议：
  - 前 30 秒每 5 秒
  - 后续每 15 秒，直到 `hard_timeout_s`
- 收到候选结果后按顺序校验：
  1. `request_id` 匹配
  2. `seller_id/subagent_id` 匹配
  3. 结果签名通过（使用目录或 `delivery-meta` 预绑定的 `seller_public_key_pem`）
  4. `status=ok` 时，`output` 符合 `output_schema`
  5. `status=error` 时，`error.code/message` 结构完整
- 状态迁移：
  - v0.1 默认无进度事件，通常由 `ACKED` 直接进入终态
  - `status=ok` 且校验通过：Buyer 本地终态为 `SUCCEEDED`
  - 协议校验不通过：`UNVERIFIED` 或 `FAILED(RESULT_*)`
  - `status=error` 且校验通过：Buyer 本地终态通常映射为 `FAILED`，并将 `error` 反馈给 Buyer Agent 作为后续决策输入
  - 超过 `hard_timeout_s`：`TIMED_OUT`

## 2.5.1 超时确认策略（Buyer Controller）
- `soft_timeout_s` 到达时默认询问 Buyer Agent 是否继续等待（`timeout_confirmation_mode=ask_by_default`）。
- `hard_timeout_s` 到达且未收到 `continue_wait=true` 时，Buyer Controller 自动终态为 `TIMED_OUT`。
- `TIMED_OUT` 仅表示 Buyer 侧停止等待与轮询，不代表远端 Seller 进程一定被 kill。

## 2.5.2 Buyer Agent 轮询 Controller（内部接口）
- 建议接口：`GET /controller/requests/{request_id}`（内部，不属于平台 API）。
- 返回字段最小集：
  - `request_id`, `status`, `soft_timeout_at`, `hard_timeout_at`
  - `last_error_code`, `updated_at`, `needs_timeout_confirmation`
  - 终态时返回 `result_package` 或实现自定义终态字段
- 超时决策写接口：`POST /controller/requests/{request_id}/timeout-decision`
  - 请求体：`continue_wait`（bool）, `decided_at`（ISO8601 UTC）, `note`（optional）
  - 用途：Buyer Agent 明确告知 Controller 是否继续等待
- 轮询策略：
  - 活跃期（前 30 秒）每 5 秒
  - 退避期（30 秒后）每 15 秒

## 2.6 重试规则
- 仅在以下场景重试（最多 3 次）：
  - transport 投递失败（`DELIVERY_*`）
  - 卖家返回 `retryable=true`
- 退避：指数退避 + 抖动。
- 相同 `request_id` 不重新生成；重试仍使用同一个 `request_id`。

## 2.7 买家指标上报
- 建议上报事件：
  - `request_sent`
  - `request_acked`
  - `request_ack_timeout`
  - `request_succeeded`
  - `request_timeout`
  - `result_signature_invalid`
  - `result_schema_invalid`
- 统一调用：`POST /v1/metrics/events`

## 2.8 本地参数覆盖
- 仓库根目录提供 `.env.example`，默认参数见 `defaults-v0.1.md`。
- 如需覆盖，当前建议仅对已接入运行时的变量注入：
  - `TOKEN_TTL_SECONDS`
  - `BOOTSTRAP_SELLER_ID`
  - `BOOTSTRAP_SUBAGENT_ID`
  - `BOOTSTRAP_DELIVERY_ADDRESS`
  - `BOOTSTRAP_SELLER_API_KEY`
  - `BOOTSTRAP_SELLER_PUBLIC_KEY_PEM`
  - `BOOTSTRAP_SELLER_PRIVATE_KEY_PEM`
  - `ACK_DEADLINE_S`
  - `TIMEOUT_CONFIRMATION_MODE`
  - `HARD_TIMEOUT_AUTO_FINALIZE`
  - `BUYER_CONTROLLER_POLL_INTERVAL_ACTIVE_S`
  - `BUYER_CONTROLLER_POLL_INTERVAL_BACKOFF_S`
  - `PLATFORM_API_BASE_URL`
  - `PLATFORM_API_KEY`
  - `DATABASE_URL`
  - `SQLITE_DATABASE_PATH`
  - `PORT`
  - `SERVICE_NAME`
  - `SELLER_ID`
  - `SUBAGENT_IDS`
  - `SELLER_SIGNING_PUBLIC_KEY_PEM`
  - `SELLER_SIGNING_PRIVATE_KEY_PEM`
  - `SELLER_MAX_HARD_TIMEOUT_S`
  - `SELLER_ALLOWED_TASK_TYPES`
  - `SELLER_HEARTBEAT_INTERVAL_MS`
- 尚未接入运行时的链路切换变量不应写入本地模板；例如 `TRANSPORT_MODE` 仍属于 post-L0 事项。
- 存储后端优先级为：`DATABASE_URL` 优先，`SQLITE_DATABASE_PATH` 作为单机回退选项。
- 推荐部署仍使用 PostgreSQL；SQLite 只适合单节点运行。

## 3. Seller 端详细流程

## 3.1 启动前准备
- 先完成用户主体注册并领取 API Key（默认 buyer 角色）。
- 若该运行时要承载 Remote Subagent，则需在手工导入/后续 onboarding 完成后激活 seller 角色能力（同一 `user_id` 增加 seller scope）。
- seller 侧调用平台接口前，需通过 `API key + seller scope + 资源归属(owner_user_id->seller_id->subagent_id)` 鉴权。
- 当前联调模式无需外部通道；Seller 通过 `POST /controller/inbox/pull` 从 `L0 local transport` 拉取任务。
- 外部通道保留为后续模式，可实例化为 `Email MCP`、`SMTP/API email bridge` 或 `HTTP/Webhook`。
- 配置 token 验证能力：
  - 在线 introspect（`POST /v1/tokens/introspect`，v0.1 必做）
- 配置幂等存储（SQLite/Redis/Postgres 均可）：
  - 键：`request_id`
  - 值：`status`, `result_hash`, `finished_at`
- 配置签名私钥（结果包签名）。
- 配置心跳任务：每 30 秒调用 `POST /v1/sellers/{seller_id}/heartbeat`。

## 3.2 请求处理流水线
1. 收件：拉取新任务消息。
2. 解析：读取 JSON 合约，校验必填字段。
3. 鉴权：通过平台 `POST /v1/tokens/introspect` 做在线校验。
4. 护栏：超时、任务类型支持情况。
5. 幂等：
  - 若 `request_id` 已完成，直接回放同一结果包。
  - 若执行中，返回 `EXEC_IN_PROGRESS`。
6. 入队：按 `priority + enqueue_at` 进入 `QUEUED`。
7. ACK：调用 `POST /v1/requests/{request_id}/ack`，最小上报 `seller_id/subagent_id`，可选附 `eta_hint_s`。
8. 执行：worker 从队列取任务，调用具体执行器（插件函数）。
9. 封包：写入 `status/output/error/timing/usage`。
10. 签名：对 canonical JSON 签名写入 `signature_algorithm/signature_base64`。
11. 回传：按同一 `request_id` / `thread_hint` 语义返回结果包。

## 3.2.1 Seller 队列机制（MVP 建议）
- 入队时机：完成 token/合约校验且决定 accept 后立即入队。
- 出队策略：同优先级 FIFO。
- 队列拒绝：超出并发或资源阈值返回 `EXEC_QUEUE_FULL` + `retry_after_s`。
- worker 异常恢复：使用 `lease_ttl + heartbeat`，租约过期任务回到 `QUEUED`。

补充说明：
- `tenant_quota` 属于后续多租户扩展，不属于 L0 必备。

## 3.3 卖家心跳建议
- 默认间隔：`30s`
- 上报字段：`timestamp`, `queue_depth`, `est_exec_p95_s`
- 若心跳中断，平台会将可用性降级为 `degraded/offline`，影响买家选路。

## 3.4 卖家失败与拒绝语义
- token 过期：`AUTH_TOKEN_EXPIRED`
- 任务类型不支持：`CONTRACT_SCHEMA_INVALID`（或后续单独错误码）
- 执行超时：`EXEC_TIMEOUT`
- 执行器异常：`EXEC_INTERNAL_ERROR`

## 3.5 卖家指标上报
- 建议上报事件：
  - `request_received`
  - `request_accepted`
  - `request_rejected`
  - `request_succeeded`
  - `request_timeout`
- 上报接口：`POST /v1/metrics/events`

## 3.6 卖家信息变更（post-L0）
- **可变更字段**：`display_name`、`description`、`eta_hint`、`seller_public_key_pem`、`status`。
- **变更方式**：通过表单重新提交变更项 + 平台 CLI 审核导入（复用现有导入流程）。
- **公钥变更**：触发双 key 窗口（见 `architecture.md` 第 5.6 节），买家验签自动兼容。
- **不可自主变更字段**：`subagent_id`、`seller_id`、`capabilities`、`supported_task_types`（需平台审核后由管理员变更）。
- **生效时间**：导入完成后即时生效，买家下次目录查询即可获取最新信息。

说明：
- 该节属于 post-L0 运行治理，不是 L0 最小闭环要求。
- 详细演进建议统一见 `../post-l0-evolution.md`。

## 3.7 能力声明模板维护
- 卖家在 `docs/templates/subagents/{subagent_id}/` 下维护 5 个模板文件（`input.schema.json`、`output.schema.json`、`example-contract.json`、`example-result.json`、`README.md`）。
- 模板变更通过 PR 提交，平台管理员审核合并。
- Schema 变更须遵循合约版本策略（仅允许向后兼容新增字段）。
- 模板更新后目录条目的 `updated_at` 同步刷新。
- Buyer 侧模板消费统一走平台 API，不直接读取仓库目录。

## 4. 平台目录分发机制（重点）

你问的“服务端怎么给他们传目录”，MVP 建议采用 **拉模式（pull）**，避免平台推送复杂度：

## 4.1 在线查询（默认）
- 买家按需调用 `GET /v1/catalog/subagents`。
- 适合低流量与冷启动场景。
- 优点：实现最简单，天然实时。
- 可按 `availability_status=healthy` 过滤离线卖家。

## 4.2 快照同步（可选增强）
- 不属于 L0。
- 若目录规模增大，再新增 `GET /v1/catalog/snapshot`。

## 4.3 增量更新（后续）
- 不属于 L0。
- 若目录进入高频变更阶段，再新增 `GET /v1/catalog/changes?since_version=...`。

## 4.4 缓存与一致性建议
- Buyer 缓存 TTL：5 分钟（MVP）。
- 关键请求前可强制刷新一次目录（避免选到已下线 subagent）。
- 目录项包含：
  - `status`（`active|inactive|blocked`）
  - `availability_status`（`healthy|degraded|offline`）
  - `last_heartbeat_at`
  - `version`
  - `updated_at`
  - `seller_public_key_pem`
- 投递地址通过 `POST /v1/requests/{request_id}/delivery-meta` 单次下发，不在目录批量列表暴露。
- 验签必须使用目录中的最新公钥；公钥轮换时需保留短暂双 key 窗口。

## 4.5 手工导入流程（当前方案，非 L0 阻塞）
1. 用户完成主体注册并获取 API Key（默认 buyer）。
2. 用户通过表单提交 remote subagent 信息与能力说明（携带 `owner_user_id`）。
3. 平台管理员基于模板维护 subagent 条目并关联 `seller_id`。
4. 平台管理员通过 CLI 审核并导入；导入成功后激活该用户的 seller 角色能力。
5. Buyer 通过查询接口获取可用目录条目。

模板文件：
- `docs/templates/catalog-subagent.template.json`
- `docs/templates/catalog-subagents.import.template.ndjson`
- 能力声明模板：`docs/templates/subagents/{subagent_id}/`（详见 `architecture.md` §4.5）

补充说明：
- 该流程服务于目录供给与身份激活，不阻塞 L0 单轮闭环。
- 更完整的 onboarding 迁移方案见 `../post-l0-evolution.md`。

## 5. 最小状态机落地表（建议）

状态枚举：
- `CREATED`
- `SENT`
- `ACKED`
- `SUCCEEDED`
- `FAILED`
- `TIMED_OUT`
- `UNVERIFIED`

建议字段：
- `request_id`（PK）
- `buyer_id`
- `seller_id`
- `subagent_id`
- `status`
- `attempt`
- `last_error_code`
- `token_exp_at`
- `ack_deadline_at`
- `hard_timeout_at`
- `updated_at`

## 6. MVP 验收清单（面向三方）

- 买家端：
  - 能独立完成发单、轮询、验收、重试。
  - 对同 `request_id` 重复结果只认一次。
- 卖家端：
  - token 过期能拒绝并返回标准错误码。
  - 幂等去重可回放既有结果。
- 平台：
  - 目录查询稳定可用。
  - token 签发与 claims 完整。
  - 至少能接收最小观测事件；聚合分析可后续补齐。
