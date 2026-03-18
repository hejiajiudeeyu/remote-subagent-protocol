# 真实联调缺口清单（MVP）

用途：区分“已完成的联调能力”和“仍需补齐的真实依赖链路”。

## A. 已完成

- [x] 三端服务可独立启动（Platform / Buyer Controller / Seller Controller）
- [x] in-process E2E 四类场景（成功、超时、token 过期、结果不合规）
- [x] TUI 反馈（Vitest）
- [x] Web UI 反馈（`site/protocol-playground.html`）
- [x] 流程图步骤映射报告（`tests/reports/latest.json`）
- [x] Docker Compose 真实进程冒烟脚本（`tests/smoke/compose-smoke.mjs`）
- [x] 邮件通道替身集成测试（`tests/integration/email-transport.integration.test.js`）
- [x] PostgreSQL 最小 CRUD 冒烟（compose-smoke 内执行）

## B. 当前未覆盖（需后续补齐）

- [ ] 真实邮箱 MCP 通道联调（当前仍为 Seller/Buyer 本地接口模拟）
- [ ] PostgreSQL 持久化语义验证（当前服务端业务状态主要为内存态）
- [ ] seller->platform introspect/ACK/events 的全链路交互自动化验证
- [ ] 网络抖动与邮件乱序的混沌联调（当前仅有基础超时分支）
- [ ] Docker 守护进程不可用时的 CI fallback 策略

## C. 推荐执行顺序

1. 落地 Platform PostgreSQL 持久层（users/request_events/metrics）并补集成测试
2. 将 Seller ACK/introspect 接入真实 Platform API 调用，加入 E2E 断言
3. 接入 Email MCP Adapter 测试替身与真实通道冒烟（夜间任务）
4. 增加 chaos 场景（延迟、重复、乱序、平台重启）

## D. 验收标准

- [ ] `npm run test:ci` 在 docker 可用环境通过（strict compose smoke）
- [ ] `tests/reports/latest.json` 持续输出 `flow_step_id`
- [ ] Web UI 可定位所有失败步骤（无 `unmapped`）
