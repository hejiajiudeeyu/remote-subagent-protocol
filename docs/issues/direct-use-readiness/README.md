# Direct-Use Productization Plan

状态：`active`  
更新时间：`2026-03-18`

本计划用于把仓库从“协议与参考实现可用”推进到“用户端可直接使用、服务端可直接部署”的形态。  
在本计划中的事项全部完成前，本文件持续作为执行清单维护；完成后再迁入 `docs/current/` 或 `docs/archive/`。

## Target

目标拆成两条主线：

1. 用户端：AI 可以帮助终端用户完成安装、注册、示例运行、基础排障
2. 服务端：操作者可以按固定入口拉起公网服务，而不是自己拼多个 deploy profile

## Current Gap Summary

当前已经具备：

- 协议主链与 buyer/platform/seller 参考实现
- `ops` 本地运行时、example subagent、bootstrap、自举脚本
- formal onboarding、双审批、隐藏审核测试
- `relay_http`、`emailengine`、`gmail` 首版 transport

当前仍缺：

- 服务端一体化公网部署包
- 真实可用的公开镜像/公开分发坐标
- 用户端正式分发闭环
- 生产级运维硬化（key lifecycle / observability / stable published-image validation）

## Tracks

### Track A: Program

程序实现与运行时收口。

### Track B: Distribution And Deployment

镜像、npm 分发、部署入口和 smoke 验证收口。

### Track C: Docs And Product Positioning

文档、对外口径、安装与运维说明收口。

## Priority Order

1. 修当前真实 deploy/config blocker
2. 做服务端一体化 `public-stack`
3. 做用户端真实分发闭环
4. 做生产运维硬化
5. 收文档和对外口径

## TODO

### P0: Immediate Blockers

- [x] 修 [deploy/platform/.env.example](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/deploy/platform/.env.example) 中平台 bootstrap / delivery 相关环境变量命名，使其与代码一致
- [x] 修 [deploy/platform/docker-compose.yml](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/deploy/platform/docker-compose.yml) 中 `PLATFORM_ADMIN_API_KEY`、bootstrap delivery、review transport 的显式注入
- [x] 检查并修正 [docs/current/guides/deployment-guide.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/guides/deployment-guide.md) 中与上述 deploy 配置不一致的说明
- [x] 收紧平台 demo/bootstrap seller 默认值，避免生产部署默认带预批准 demo 资源
- [x] 修正文档中仍将外部 transport 泛化描述为 `Email MCP / SMTP bridge / HTTP Webhook` 的地方，改成当前真实已实现能力
- [x] 修正 [docs/current/status/current-closeout-checklist.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/status/current-closeout-checklist.md) 中关于 console login/credential flow 的滞后描述

### P1: Public Stack

- [x] 新增 `deploy/public-stack/`
- [ ] 在 `public-stack` 中纳入：
  - [x] `platform-api`
  - [x] `postgres`
  - [x] `relay`
  - [x] `platform-console-gateway`
  - [x] edge proxy / TLS 入口
- [x] 新增 `deploy/public-stack/.env.example`
- [x] 新增 `deploy/public-stack/README.md`
- [x] 为 `public-stack` 增加 operator quickstart
- [x] 增加 `public-stack` health / bootstrap checklist
- [x] 增加 `public-stack` smoke 或等价 deploy smoke

### P1: End-User Distribution

- [x] 明确 `@croc/ops` 的真实分发策略：
  - [ ] 正式 npm publish
  - [x] 或统一改口为 repo-local 安装，直到 publish 完成
- [ ] 若选择 npm publish：
  - [ ] 增加 `@croc/ops` 的发布流程
  - [ ] 增加版本化发布检查
  - [ ] 在文档中切换到真实 `npx @croc/ops`
- [x] 把用户端推荐路径固定为单入口 `bootstrap`
- [x] 补一份“AI 帮助用户部署本地客户端”的明确指引

### P1: Image Distribution And Validation

- [x] 将 compose/env 默认镜像坐标从占位值切换到真实发布坐标
- [x] 修正 `published-images-smoke`，使其验证真实 registry pull，而不是本地模拟
- [x] 在 CI 中为真实 published image 验证保留明确路径
- [x] 更新 release 与 compatibility 说明

### P2: Operational Hardening

- [ ] API key rotation / revocation
- [ ] signer key rotation window
- [ ] managed secret backing 或更明确的 secret lifecycle 方案
- [ ] Prometheus-ready metrics
- [ ] tracing
- [ ] structured log aggregation guidance
- [ ] dashboard-ready time-series views
- [ ] 更稳定的外部环境 compose/published-image smoke

### P2: Review And Safety Coverage

- [ ] 为 email transport 增加更明确的审核静态检查结果结构
- [ ] 明确 email live review test 的能力边界与后续路线
- [ ] 视需要扩展到 email live probe

### P2: Documentation And Positioning

- [x] 更新 [README.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/README.md)
- [x] 更新 [README.zh-CN.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/README.zh-CN.md)
- [x] 更新 [docs/current/guides/deployment-guide.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/guides/deployment-guide.md)
- [x] 新增 end-user AI deployment guide
- [x] 新增 operator public-stack deployment guide
- [x] 明确“试点可用”和“生产可用”的边界文档

## Milestones

### Milestone 1: Remove Real Deploy Blockers

完成标准：

- `deploy/platform` 的 env 和 compose 配置与当前代码一致
- 当前文档不会再误导 operator
- 平台默认值不再把 demo 资源混进生产口径

### Milestone 2: Public Stack Available

完成标准：

- `deploy/public-stack` 可启动
- 有明确公网暴露说明
- 有最小 smoke 验证

### Milestone 3: End-User Distribution Ready

完成标准：

- 用户端安装入口不再依赖读仓库文档拼命令
- AI 可按单入口稳定帮助用户完成本地部署
- 分发方式与文档承诺一致

### Milestone 4: Productization Baseline

完成标准：

- 真实镜像验证闭环成立
- 关键密钥治理能力具备最小可运营形态
- 基础 observability 达到可上线运维

## Exit Criteria

当满足以下条件时，本计划可关闭并迁出本目录：

- 服务端存在明确的一体化公网部署入口
- 用户端存在明确且真实可分发的安装入口
- 文档承诺与代码、部署、发布路径一致
- 已完成的最低产品化能力不再主要依赖人工解释
