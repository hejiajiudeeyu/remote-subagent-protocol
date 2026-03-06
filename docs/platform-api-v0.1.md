# Protocol Control Plane API v0.1（MVP）

本文档定义 `Remote Subagent Protocol` 的最小控制面 API：身份、目录、模板下发、token、请求事件、指标。  
当前仓库已实现的联调模式为 `L0 local transport`；控制面只依赖 `Transport Adapter` 抽象，`Email MCP` 只是候选外部通信模式之一。这里描述的是协议参考控制面，而不是要求所有实现共享同一个托管市场后端。

## 1. 设计边界

- 平台职责：目录索引、授权签发、指标聚合。
- 非职责：任务正文代理转发、卖家执行编排、长期密钥托管。
- 超时边界：平台不提供“远端执行进程 kill”语义；Buyer 侧超时仅影响 Buyer 本地等待状态。
- 版本策略：`/v1` 路径版本 + 字段向后兼容扩展。

## 2. 通用约定

## 2.1 Content-Type
- 请求与响应均使用 `application/json; charset=utf-8`

## 2.2 鉴权（v0.1 冻结）
- 统一使用 `API Key` 鉴权。
- 建议请求头：`Authorization: Bearer <API_KEY>`。
- API Key 绑定 `user_id + role_scopes`，服务端按 scope 与资源归属做鉴权（默认 `buyer`，seller agent 审核通过后激活 `seller`）。

当前实现补充：
- `POST /v1/tokens/task`、`POST /v1/requests/{request_id}/delivery-meta`：要求 `buyer` 身份。
- `POST /v1/tokens/introspect`、`POST /v1/requests/{request_id}/ack`、`POST /v1/sellers/{seller_id}/heartbeat`：要求 `seller` 身份，且命中 `seller_id/subagent_id` 资源归属。

## 2.3 时间、ID 与身份映射
- 时间：ISO8601 UTC（如 `2026-03-02T12:00:00Z`）
- `request_id`：UUIDv7 推荐
- 分页：使用 `next_page_token`
- `user_id`：用户主体标识（注册后默认具备 `buyer`）
- `buyer_id`：v0.1 默认与 `user_id` 同值映射
- `seller_id`：首次 seller agent 审核通过后创建并绑定 `owner_user_id`
- `owner_user_id`：seller agent 提交人与资源归属主键（`owner_user_id -> seller_id -> subagent_id`）

## 2.4 通用错误响应

```json
{
  "error": {
    "code": "CONTRACT_SCHEMA_INVALID",
    "message": "output_schema is required",
    "retryable": false,
    "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41"
  }
}
```

错误码分域建议：
- `AUTH_*`
- `CONTRACT_*`
- `EXEC_*`
- `RESULT_*`
- `DELIVERY_*`
- `TEMPLATE_*`
- `PLATFORM_*`

常用 `AUTH_*` 错误码（建议）：
- `AUTH_INVALID_API_KEY`：API Key 无效或缺失
- `AUTH_KEY_REVOKED`：API Key 已吊销
- `AUTH_SCOPE_FORBIDDEN`：调用方缺少所需 scope（如缺少 `seller`）
- `AUTH_RESOURCE_FORBIDDEN`：scope 正确但资源归属不匹配
- `AUTH_ROLE_NOT_ACTIVATED`：seller 角色尚未激活（agent 尚未审核通过）

## 2.5 用户注册 API

- 方法：`POST /v1/users/register`
- 用途：创建用户主体，默认激活 `buyer` scope，并签发 API Key

请求字段（Body）：
- `contact_email`（当前实现必填；兼容旧字段 `email`）
- `display_name`（文档保留，当前实现未强制）
- `organization_name`（可选）
- `locale`（可选）

201 响应示例：
```json
{
  "user_id": "user_01htz0demo",
  "contact_email": "demo@example.com",
  "roles": ["buyer"],
  "api_key": "sk_live_once_only_xxx",
  "created_at": "2026-03-05T08:00:00Z"
}
```

说明：
- `api_key` 明文仅返回一次，服务端仅保存摘要。
- 注册不会直接激活 `seller`；需 seller agent 审核通过后激活。

## 3. 目录 API

## 3.1 查询 subagents

- 方法：`GET /v1/catalog/subagents`
- 用途：买家检索可调用 subagent

Query 参数：
- `capability`（可选）
- `seller_id`（可选）
- `status`（可选，默认 `active`）
- `availability_status`（可选，`healthy|degraded|offline`）
- `page_size`（可选，默认 20，最大 100）
- `page_token`（可选）

200 响应示例：
```json
{
  "items": [
    {
      "subagent_id": "foxlab.text.classifier.v1",
      "seller_id": "seller_foxlab",
      "display_name": "FoxLab Text Classifier",
      "capabilities": ["classification", "customer_support"],
      "supported_task_types": ["text_classification"],
      "version": "1.0.0",
      "status": "active",
      "availability_status": "healthy",
      "last_heartbeat_at": "2026-03-02T11:59:50Z",
      "sla_hint": {
        "p95_exec_ms": 3500,
        "timeout_rate_7d": 0.02
      },
      "pricing_hint": {
        "currency": "USD",
        "per_request": 0.02
      },
      "eta_hint": {
        "queue_p50_s": 8,
        "exec_p50_s": 35,
        "exec_p95_s": 120,
        "sample_size_7d": 340,
        "updated_at": "2026-03-02T12:00:00Z"
      },
      "seller_public_key_pem": "-----BEGIN PUBLIC KEY-----...",
      "delivery_meta_mode": "request_scoped",
      "template_ref": "docs/templates/subagents/foxlab.text.classifier.v1/"
    }
  ],
  "next_page_token": null
}
```

### 3.1.1 Buyer 筛选最小字段集（冻结）

`GET /v1/catalog/subagents`（以及后续 `GET /v1/catalog/search`）应保证以下字段可用：

- 身份：`subagent_id`、`seller_id`
- 可用性：`status`、`availability_status`、`last_heartbeat_at`
- 能力：`capabilities[]`、`supported_task_types[]`、`version`
- 质量与时效：`sla_hint.p95_exec_ms`、`sla_hint.timeout_rate_7d`、`eta_hint.exec_p95_s`
- 成本：`pricing_hint.currency`、`pricing_hint.per_request`
- 验签材料：`seller_public_key_pem`（公钥轮换窗口可返回 `seller_public_keys_pem[]`）
- 合约构建入口：`template_ref`

`GET /v1/catalog/search` 额外字段（仅搜索模式）：
- `score`、`match_reasons`、`score_breakdown`

说明（可扩展性）：
- 当前建议优先使用遍历/分类过滤。
- `delivery_address` 不在目录批量接口返回；买家需在 token 签发后按 `request_id` 单次申请投递元数据。
- 当前实现会在目录列表直接返回 `seller_public_key_pem`，供 Buyer 在创建本地请求记录与验签时绑定信任根。
- 后续可新增 `GET /v1/catalog/search`，支持联想、模糊匹配与领域策略。
- 为保持兼容，`GET /v1/catalog/subagents` 长期保留，不因搜索增强而下线。

## 3.2 注册/更新 subagent（MVP 可手工导入）

- 方法：`POST /v1/catalog/subagents`
- 用途：提交 seller agent 草案（或更新申请），进入审核/导入流程
- 说明：MVP 可不对外开放该 API，先采用线下手工导入模板。
- 说明：v0.1 中 seller 不自行维护 subagent 列表，平台在导入时完成 `seller_id -> subagent_id` 关联。

请求字段（Body）：
- `owner_user_id`（必填，且需与 API Key 绑定的 `user_id` 一致）
- `subagent_id`（必填）
- `seller_id`（可选；首次提交可省略，由平台在审核通过后生成）
- `display_name`（必填）
- `description`（可选）
- `capabilities`（必填，字符串数组）
- `version`（必填）
- `status`（可选，默认 `draft_pending_review`）
- `delivery_address`（必填，seller 任务投递邮箱；用于 `delivery-meta` 单次下发）
- `contact.email`（必填）
- `support_email`（必填）
- `endpoint_hint`（可选，仅元数据，不用于任务转发）
- `supported_task_types`（必填，字符串数组）
- `constraints.max_budget_cap`（可选）
- `constraints.max_hard_timeout_s`（可选）
- `eta_hint.queue_p50_s`（可选）
- `eta_hint.exec_p50_s`（可选）
- `eta_hint.exec_p95_s`（可选）
- `eta_hint.sample_size_7d`（可选）
- `eta_hint.updated_at`（可选）
- `seller_public_key_pem`（必填）
- `template_ref`（可选，模板语义绑定键，可为路径样式或版本化标识）
- `updated_at`（可选）

201 响应示例：
```json
{
  "owner_user_id": "user_01htz0demo",
  "seller_id": "seller_user_01htz0demo",
  "subagent_id": "foxlab.text.classifier.v1",
  "status": "draft_pending_review",
  "review_status": "pending",
  "submitted_at": "2026-03-05T08:30:00Z"
}
```

约束：
- 调用方至少具备 `buyer` scope（默认即有）。
- 仅允许提交/更新自身资源：`owner_user_id` 必须匹配调用方 `user_id`。
- 返回 `active` 前必须经过审核与导入流程；首次 `active` 成功会触发 seller 角色激活。

## 3.3 获取能力声明模板包

- 方法：`GET /v1/catalog/subagents/{subagent_id}/template-bundle`
- 用途：买家按目录条目中的 `template_ref` 拉取模板，构造合约输入输出

Path 参数：
- `subagent_id`

Query 参数：
- `template_ref`（可选，建议透传目录项值；服务端用于一致性校验）

请求头（可选）：
- `If-None-Match: "<etag>"`

200 响应示例：
```json
{
  "subagent_id": "foxlab.text.classifier.v1",
  "template_ref": "docs/templates/subagents/foxlab.text.classifier.v1/",
  "template_version": "2026-03-02T12:00:00Z",
  "input_schema": {
    "type": "object"
  },
  "output_schema": {
    "type": "object"
  },
  "example_contract": {
    "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41"
  },
  "example_result": {
    "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
    "status": "ok"
  },
  "readme_markdown": "# FoxLab Text Classifier\\n..."
}
```

响应头建议：
- `ETag: "<template_digest>"`
- `Cache-Control: private, max-age=300`

状态码约定：
- `200`：返回模板包
- `304`：`ETag` 命中，无需重复下发
- `404`：`TEMPLATE_NOT_FOUND`
- `409`：`TEMPLATE_REF_MISMATCH`（传入 `template_ref` 与目录当前绑定不一致）

## 4. Token API

## 4.1 任务 token 签发

- 方法：`POST /v1/tokens/task`
- 用途：买家为单次任务申请短期授权

请求字段（Body）：
- `request_id`
- `buyer_id`
- `seller_id`
- `subagent_id`
- `budget_cap`
- `ttl_seconds`（建议 600-1200）

201 响应示例（当前实现）：
```json
{
  "task_token": "<JWT_OR_EQUIVALENT>",
  "claims": {
    "iss": "croc-platform",
    "aud": "seller_foxlab",
    "sub": "buyer_acme",
    "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
    "subagent_id": "foxlab.text.classifier.v1",
    "exp": 1770005100
  }
}
```

## 4.2 token introspect（v0.1 必做）

- 方法：`POST /v1/tokens/introspect`
- 用途：卖家在线查询 token 是否有效（v0.1 统一校验模式）

请求字段（Body）：
- `task_token`

鉴权约束：
- 调用方需具备 `seller` scope。
- 平台需校验调用方是否命中资源归属（`owner_user_id -> seller_id -> subagent_id`）。
- 当前实现的 seller 权限失败返回：`AUTH_SCOPE_FORBIDDEN` 或 `AUTH_RESOURCE_FORBIDDEN`。

200 响应示例：
```json
{
  "active": true,
  "claims": {
    "iss": "croc-platform",
    "aud": "seller_foxlab",
    "sub": "buyer_acme",
    "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
    "subagent_id": "foxlab.text.classifier.v1",
    "exp": 1770005100
  }
}
```

## 5. Metrics API

## 5.1 事件上报

- 方法：`POST /v1/metrics/events`
- 用途：买家/卖家提交最小观测事件

请求字段（Body）：
- `source`：`buyer|seller`
- `event_type`：如 `request_succeeded|request_timeout|schema_invalid|signature_invalid`
- `request_id`
- `buyer_id`
- `seller_id`
- `subagent_id`
- `timestamp`
- `payload`（可选，扩展）

鉴权约束：
- `source=buyer`：需具备 `buyer` scope。
- `source=seller`：需具备 `seller` scope，且校验资源归属命中。

202 响应示例：
```json
{
  "accepted": true,
  "ingested_at": "2026-03-02T12:10:00Z"
}
```

## 5.2 聚合查询

- 方法：`GET /v1/metrics/summary`
- 用途：为榜单和评测展示提供聚合硬指标

Query 参数：
- `window`（如 `24h|7d|30d`）
- `seller_id`（可选）
- `subagent_id`（可选）
- `min_samples`（可选）

200 响应示例：
```json
{
  "window": "7d",
  "subagent_id": "foxlab.text.classifier.v1",
  "sample_size": 120,
  "call_volume": 120,
  "success_rate": 0.94,
  "timeout_rate": 0.03,
  "schema_compliance_rate": 0.98,
  "p95_exec_ms": 4100
}
```

## 6. Request Coordination API（delivery-meta/ACK/状态事件）

该组接口用于请求投递协调与轻量状态回传，避免买家无效等待。  
注意：只传事件摘要，不传任务正文与结果正文。
v0.1 实现范围：`delivery-meta` + `ACKED` 事件。

说明：
- Buyer Controller 与 Buyer Agent 之间的内部接口（如 `GET /controller/requests/{request_id}`、`POST /controller/requests/{request_id}/timeout-decision`）属于实现内部接口，不属于平台对外 API。

## 6.1 买家申请投递元数据（delivery-meta）

- 方法：`POST /v1/requests/{request_id}/delivery-meta`
- 用途：买家在 token 签发后，按单次请求拉取目标卖家的投递元数据

Path 参数：
- `request_id`

请求字段（Body）：
- `seller_id`（必填）
- `subagent_id`（必填）
- `task_token`（可选，建议传入用于 claims 交叉校验）

鉴权约束：
- 调用方需具备 `buyer` scope。
- 平台校验调用方对该 `request_id` 的归属（`buyer_id` 命中）以及 `seller_id/subagent_id` 一致性。

200 响应示例：
```json
{
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
  "seller_id": "seller_foxlab",
  "subagent_id": "foxlab.text.classifier.v1",
  "delivery_address": "tasks@foxlab.example",
  "thread_policy": {
    "subject_prefix": "[CROC][TASK]",
    "reply_mode": "same_thread_required"
  },
  "seller_public_key_pem": "-----BEGIN PUBLIC KEY-----..."
}
```

状态码约定：
- `404`：`DELIVERY_META_NOT_FOUND`
- `409`：`DELIVERY_META_MISMATCH`（与 token/目录绑定不一致）

## 6.2 卖家 ACK（已接单）

- 方法：`POST /v1/requests/{request_id}/ack`
- 用途：卖家通过校验并开始处理后，快速确认“已接单”

Path 参数：
- `request_id`

请求字段（Body）：
- `seller_id`（必填）
- `subagent_id`（必填）
- `accepted_at`（必填）
- `ack_deadline_s`（可选，默认 120）
- `estimated_finish_at`（可选）
- `queue_position`（可选）
- `message`（可选，简短说明）

约束：
- 对同一 `request_id` 幂等。
- 平台校验调用方具备 `seller` scope 且 `owner_user_id -> seller_id -> subagent_id` 绑定命中。
- 可校验是否与已签发 token 的 `aud/subagent_id` 对齐。

200 响应示例：
```json
{
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
  "event_type": "ACKED",
  "accepted": true,
  "accepted_at": "2026-03-02T12:00:20Z"
}
```

## 6.3 卖家状态事件上报（后续，不在 v0.1）

- 方法：`POST /v1/requests/{request_id}/events`
- 用途：卖家上报 `RUNNING/PROGRESS/FAILED` 等轻量状态（后续扩展）

请求字段（Body）：
- `seller_id`
- `subagent_id`
- `event_type`（`RUNNING|PROGRESS|FAILED|COMPLETED`）
- `timestamp`
- `progress`（可选，0-100）
- `message`（可选）

202 响应示例：
```json
{
  "accepted": true,
  "ingested_at": "2026-03-02T12:01:00Z"
}
```

## 6.4 买家查询请求事件

- 方法：`GET /v1/requests/{request_id}/events`
- 用途：买家轮询 ACK/状态事件，减少盲等

Query 参数：
- `since`（可选，ISO8601 或游标）
- `limit`（可选，默认 50）

200 响应示例：
```json
{
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
  "events": [
    {
      "event_type": "ACKED",
      "seller_id": "seller_foxlab",
      "subagent_id": "foxlab.text.classifier.v1",
      "timestamp": "2026-03-02T12:00:20Z",
      "estimated_finish_at": "2026-03-02T12:01:10Z"
    }
  ],
  "next_cursor": null
}
```

## 7. Seller Heartbeat API

心跳用于反映卖家在线状态与基础负载，不替代单请求 ACK。

## 7.1 上报心跳

- 方法：`POST /v1/sellers/{seller_id}/heartbeat`
- 用途：卖家周期性上报在线状态

Path 参数：
- `seller_id`

请求字段（Body）：
- `seller_id`（必填，需与 path 一致）
- `timestamp`（必填）
- `agent_version`（可选）
- `queue_depth`（可选）
- `est_exec_p95_s`（可选）
- `active_subagents`（可选）

鉴权约束：
- 调用方需具备 `seller` scope。
- 平台需校验 `owner_user_id -> seller_id` 绑定关系。

200 响应示例：
```json
{
  "accepted": true,
  "seller_id": "seller_foxlab",
  "received_at": "2026-03-02T12:00:30Z",
  "availability_status": "healthy"
}
```

## 7.2 可用性判定（建议默认）

- `heartbeat_interval_s = 30`
- `degraded_threshold_s = 90`
- `offline_threshold_s = 180`

状态规则：
- `healthy`：`now - last_heartbeat_at <= 90s`
- `degraded`：`90s < now - last_heartbeat_at <= 180s`
- `offline`：`now - last_heartbeat_at > 180s`

## 8. 手工导入目录模板

MVP 目录注册采用手工导入，模板文件见：
- `docs/templates/catalog-subagent.template.json`（单条模板）
- `docs/templates/catalog-subagents.import.template.ndjson`（批量模板）

能力声明模板（详见 `architecture-mvp.md` §4.5）：
- 每个 subagent 在 `docs/templates/subagents/{subagent_id}/` 下维护 `input.schema.json`、`output.schema.json`、`example-contract.json`、`example-result.json`、`README.md`。
- 目录条目通过 `template_ref` 字段绑定模板语义，买家选定 subagent 后通过 `GET /v1/catalog/subagents/{subagent_id}/template-bundle` 拉取模板包。

建议导入流程：
1. 用户先调用 `POST /v1/users/register` 完成注册（默认 `buyer`）。
2. 用户提交 seller agent 草案（携带 `owner_user_id`）。
3. 平台管理员在模板中填写/修订 `subagent_id/seller_id/capabilities/supported_task_types` 并建立关联。
4. 使用 CLI 执行校验与审核导入。
5. 首次导入成功后，平台激活该用户 `seller` scope，并记录资源绑定关系。
6. 平台记录导入批次号与审计信息，并通过 `GET /v1/catalog/subagents` 抽样核对。

## 9. 检索增强预留（后续规划，不在 v0.1 实现）

为支持搜索引擎式能力，建议预留以下查询参数/字段：
- `q`：自由文本查询
- `fuzzy`：模糊匹配开关
- `domain`：领域策略（如 `legal|finance|biomed`）
- `ranking_profile`：排序策略标识

建议预留以下响应字段：
- `score`：综合相关性分
- `match_reasons`：命中原因（关键词、同义词、标签）
- `score_breakdown`：分项得分（文本匹配、质量、可用性、成本）

兼容原则：
- 新字段仅追加，不破坏旧字段语义。
- 新参数默认关闭，不影响现有 buyer 行为。
