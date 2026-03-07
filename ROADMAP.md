# Roadmap

更新时间：2026-03-03

## 1. 当前阶段

阶段：MVP 实现启动期（从文档走向可运行原型）

目标：验证 `Remote Subagent Protocol` 闭环可稳定跑通，并沉淀首个可用参考实现。

## 2. 近 30 天里程碑

### Milestone A: 协议控制面最小可用

- 完成 `GET /v1/catalog/subagents`
- 完成 `POST /v1/tokens/task`
- 完成 `POST /v1/tokens/introspect`
- 完成 `POST /v1/requests/{request_id}/ack`
- 完成 `POST /v1/sellers/{seller_id}/heartbeat`

验收标准：
- 可跑通“选路 -> 发 token -> 卖家 introspect -> ACK”链路

### Milestone B: 结果验收与观测

- Buyer 侧结果验签与 schema 校验
- Seller 侧 `request_id` 幂等回放
- `POST /v1/metrics/events` 与 `GET /v1/metrics/summary`

验收标准：
- 成功率/超时率/Schema 合规率可查询

## 3. v0.2 候选项（非当前里程碑）

- `POST /v1/requests/{request_id}/sent`
- `POST /v1/requests/{request_id}/completed`
- `GET /v1/catalog/subagents/{subagent_id}`（列表与详情分离）
- buyer_email_hash 双因素校验
- 本地 JWT 校验 + introspect fallback

## 4. 贡献优先级

P0：协议控制面 API 与最小状态机
P1：Buyer/Seller 参考实现与测试
P2：Playground 对齐与开发者体验

## 5. 非目标（当前阶段不做）

- 与协议闭环无关的外围业务系统
- 主观评价驱动的展示体系
- 重型搜索与推荐系统
