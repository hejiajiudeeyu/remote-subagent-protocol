# Playground Review Issues (2026-03-03)

来源：用户对 `playground.html` 的逐条评审意见。  
目的：沉淀问题、给出建议答复，并作为后续修改清单。

> 说明：本文件是 2026-03-03 的评审快照，包含部分“讨论阶段方案”。
> 当前冻结规范以 `docs/platform-api-v0.1.md`、`docs/architecture-mvp.md`、`docs/defaults-v0.1.md` 为准。

## 1. 问题清单（原始意见）

1. seller 注册时，应提供除了工作邮箱外的 support 邮箱。
2. seller id 和 buyer id 是否应该区分，还是给一个 id 绑两个身份。
3. seller 的 `capability_overview` 是干啥的。这个是不是应该在他注册服务时再去绑定。
4. seller 注册时应对服务进行一个简单描述，方便后面 buyer 的 agent 选择。后续也需开放 seller 更新服务信息的通道。要求用户给出的 subagent 信息，这个可以参考现有的 skills 结构约定来做。
5. buyer 查询目录时，是否只需要得到单个 subagent 的：名称，描述，id，调用量（现存，后续可能会换成评分什么的）。健康与否直接让服务端处理，不健康的不开放即可。buyer 决定选什么 subagent 后，再发送请求，获取到 token、模版和邮箱地址（当前邮箱地址也没给出）。
6. buyer 发出邮件后，是否需要向服务端也发一个信息，说明内容已经发送。有无必要。
7. token 校验能不能这样：buyer 发送请求后，服务端同时向 buyer 和 seller 发送对称 token，seller 自行验证 token 是否匹配，以减轻服务端压力。另外，是不是也可以向 seller 发送 buyer 的邮箱，做双重认证（邮箱地址 + token，减少邮件误读，防止入侵）。
8. seller 返回邮件结果时，能不能也向服务端发个消息说已完成，然后服务端再告诉 buyer 端已完成。有无必要。

## 2. 建议答复（逐条）

## 2.1 seller 注册补充 support 邮箱
- 结论：建议采纳。
- 处理：在 seller 主体注册字段新增 `support_email`（必填），`work_email` 继续保留。
- 价值：运维与业务沟通分流，减少单邮箱故障风险。

## 2.2 buyer_id 与 seller_id 是否合并
- 结论：建议保持分离（不合并）。
- 理由：
  - 权限边界不同（buyer 调用目录/token，seller 调 introspect/ack/heartbeat）。
  - 审计口径不同（买家行为与卖家行为分开统计）。
  - 后续风控与结算更清晰。
- 兼容方案：可增加 `account_id` 作为上层主体，底下挂 `buyer_id` / `seller_id` 两个角色身份。

## 2.3 `capability_overview` 的位置
- 结论：从“主体注册”移到“subagent 注册/更新”更合理。
- 建议：
  - 主体注册仅保留组织级信息。
  - 能力描述放在 subagent 条目（`capabilities`, `supported_task_types`, `description`）中。

## 2.4 seller 服务描述与更新通道
- 结论：建议采纳。
- 建议字段（subagent 级）：
  - `display_name`
  - `description_short`
  - `description_full`
  - `capabilities`
  - `supported_task_types`
  - `input_schema_ref` / `output_schema_ref`
  - `example_contract_ref` / `example_result_ref`
- 更新通道：保留“表单提交 + CLI 审核导入”，开放 seller 发起更新申请。
- 与 skills 结构对齐：建议继续复用 `docs/templates/subagents/{subagent_id}/` 结构。

## 2.5 buyer 目录查询最小字段与邮箱地址下发
- 结论：建议分两阶段返回数据（目录轻量化 + 选择后拉详情）。
- 阶段 A（目录列表）建议最小字段：
  - `subagent_id`, `display_name`, `description_short`, `call_volume`
- 健康状态策略：
  - 服务端默认过滤不健康条目（可不向 buyer 暴露 `availability_status`）。
- 阶段 B（选中后详情）建议接口：
  - `GET /v1/catalog/subagents/{subagent_id}`
  - 返回 `template_ref`, `delivery_address`（邮箱地址）, `constraints`, `pricing_hint`
- 备注：你指出“当前邮箱地址没给出”是有效问题，需补齐。

## 2.6 buyer 发邮件后是否需要通知服务端
- 结论：建议需要，且做成轻量事件。
- 建议接口：`POST /v1/requests/{request_id}/sent`
- 价值：
  - 明确 `SENT` 起点，方便超时分层（投递/执行）。
  - 排障更快（能区分“未发出”与“已发出未收 ACK”）。
- 代价：增加一次控制面调用，复杂度可控。

## 2.7 对称 token + 邮箱双认证方案
- 结论：
  - “双发对称 token 让 seller 本地比对”不建议作为主方案。
  - “seller 同时校验 buyer 邮箱 + token claims”建议采纳。
- 原因：
  - 对称 token 双发会增加密钥管理与重放面，且并不比 introspect 更简单。
  - 当前在线 introspect + claims 绑定（buyer_id/seller_id/request_id/subagent_id/exp）已足够稳。
- 建议增强：
  - 在 token claims 中加入 `buyer_email_hash`（或邮件白名单标识）。
  - seller 校验“来信邮箱 + claims”双因素。

## 2.8 seller 完成后是否通知服务端
- 结论：建议需要。
- 建议接口：`POST /v1/requests/{request_id}/completed`
- 作用：
  - buyer 可先通过服务端知道“已完成”，再去收件箱拉结果。
  - 提升观测与运营能力（完成率、完成时延）。
- MVP 范围建议：
  - v0.1 仍保持 ACK-only 不变。
  - 将 `COMPLETED` 事件列入 v0.2 的首个扩展项。

## 3. 建议的变更优先级

- P0（应尽快改文档/页面）
  - 增加 seller `support_email`。
  - 明确 buyer/seller id 分离策略。
  - 目录选中后详情返回 `delivery_address`（邮箱地址）。
  - 明确 `capability_overview` 下沉到 subagent 级。

- P1（下一迭代）
  - 新增 `request_sent` 事件接口。
  - 新增 `request_completed` 事件接口。
  - 目录列表与详情分离（轻列表 + 详情接口）。

- P2（后续安全增强）
  - token claims 增加 `buyer_email_hash` 并在 seller 侧做双重校验。

## 4. 对 `playground.html` 的直接修订点

- 注册步骤：补 `support_email`。
- 去除/调整主体注册里的 `capability_overview`，改到 subagent 提交流程。
- 目录查询步骤：展示精简字段；新增“选中后拉详情”步骤，详情内包含 `delivery_address`。
- 可选新增步骤（标注 v0.2）：`request_sent` 与 `request_completed` 事件。

## 5. 最终采纳决策（2026-03-03）

对照 `architecture-mvp.md`、`platform-api-v0.1.md`、`playground.html` 现有设计，逐条给出最终结论。

### 5.1 seller 注册补充 support 邮箱

- **决策：采纳（v0.1）**
- seller 主体注册新增 `support_email`（必填）。`contact_email`（原工作邮箱）继续保留。
- 文档变更：playground S01 补字段；integration-playbook seller 准备清单补说明。

### 5.2 buyer_id 与 seller_id 是否合并

- **决策：不采纳（维持分离）**
- 与架构文档已有设计一致：权限边界不同、审计口径不同、风控/结算独立。
- 后续可引入 `account_id` 上层主体概念，但 v0.1 不做。
- 无文档变更。

### 5.3 `capability_overview` 位置下沉

- **决策：采纳（v0.1）**
- 从主体注册移至 subagent 级。playground S01 移除 `capability_overview`，在 S03（subagent 表单）通过 `capabilities` + `supported_task_types` + `description` 体现。
- 与 `platform-api-v0.1.md` 3.2 节 subagent 注册字段已对齐，无需额外改 API 文档。

### 5.4 seller 服务描述与更新通道

- **决策：采纳（v0.1 描述字段就绪，更新通道延后）**
- subagent 级字段（`display_name`、`description`、`capabilities`、`supported_task_types`、`template_ref` 等）已在 API 文档中定义。
- v0.1 保持"表单提交 + CLI 审核导入"，不额外开放自助更新接口。
- 后续版本开放 seller 发起更新申请。

### 5.5 buyer 目录查询最小字段与 delivery_address

- **决策：部分采纳**
- **v0.1 做法**：目录查询仍返回完整字段（条目少，分离收益有限），但在目录响应和 subagent 注册中补上 `delivery_address`（seller 任务投递邮箱，必填）。这是原始意见中"邮箱地址没给出"的有效问题。
- **v0.2 规划**：引入 `GET /v1/catalog/subagents/{subagent_id}` 详情接口，实现轻列表 + 详情分离。
- 文档变更：`platform-api-v0.1.md` 补字段；`playground.html` S05 响应补字段；模板 JSON/NDJSON 补字段。

### 5.6 buyer 发邮件后通知服务端

- **决策：延后到 v0.2**
- `POST /v1/requests/{request_id}/sent` 有排障价值（区分"未发出"与"已发出未收 ACK"），但 v0.1 优先保持链路精简。
- 登记到 `development-tracker.md` 后续开发。

### 5.7 对称 token + 邮箱双认证

- **决策：对称 token 不采纳；buyer_email_hash 延后 v0.2**
- 对称 token 双发增加密钥管理复杂度，当前 introspect + claims 绑定已足够。
- `buyer_email_hash` 双因素校验作为安全增强项，延后到 v0.2。
- 登记到 `development-tracker.md` 后续开发。

### 5.8 seller 完成后通知服务端

- **决策：延后到 v0.2**
- `POST /v1/requests/{request_id}/completed` 有运营价值（完成率、时延），但 v0.1 保持 ACK-only。
- 登记到 `development-tracker.md` 后续开发。

### 5.9 决策汇总

| Issue | 结论 | 版本 |
|---|---|---|
| 1. support_email | 采纳 | v0.1 |
| 2. id 合并 | 不采纳 | — |
| 3. capability_overview 下沉 | 采纳 | v0.1 |
| 4. 服务描述与更新 | 采纳（描述就绪，更新通道延后） | v0.1 / 后续 |
| 5. 目录分阶段 + delivery_address | 部分采纳（补 delivery_address） | v0.1 / v0.2 |
| 6. request_sent 事件 | 延后 | v0.2 |
| 7. 对称 token / buyer_email_hash | 不采纳 / 延后 | — / v0.2 |
| 8. request_completed 事件 | 延后 | v0.2 |
