# Repo Scaffold (MVP v0.1)

本文件定义三端一键部署的仓库结构基线。

## 1. 目录结构

```text
.
├── apps/
│   ├── platform-api/
│   ├── buyer-controller/
│   └── seller-controller/
├── packages/
│   ├── contracts/
│   └── transports/
│       ├── local/
│       ├── relay-local/
│       ├── relay-lan/
│       └── email/
├── docs/
├── docker-compose.yml
├── Makefile
└── package.json
```

## 2. 一键部署入口

- 本地一键启动：`make up`
- 查看状态：`make ps`
- 查看日志：`make logs`
- 停止：`make down`
- 清理卷：`make clean`

## 3. 三端职责映射

- `apps/platform-api`：控制面 API（目录、token、events、metrics）
- `apps/buyer-controller`：买方编排与超时策略执行
- `apps/seller-controller`：卖方收件、校验、ACK、执行编排

## 4. 共享代码边界

- `packages/contracts`：状态枚举、错误域、schema 常量、claims 约束
- `packages/transports/local`：`L0` 本地运行时 transport（进程内队列 / 本机 IPC）
- `packages/transports/relay-local`：`L1` 本地虚拟邮箱 / 本地 relay transport
- `packages/transports/relay-lan`：`L2` 局域网 relay transport
- `packages/transports/email`：外部通道候选实现之一（Email MCP / 邮件桥 transport）

共享约束：

- 所有 transport 包都必须实现同一 `TransportAdapter` 最小接口。
- `apps/*` 只能依赖 adapter 抽象，不得写死具体 transport 细节。
- `L0-L3` 是运行模式切换，不是四套 controller 实现。

## 4.1 运行模式与装配关系

- `L0 = apps/* + packages/contracts + packages/transports/local`
- `L1 = L0 + packages/transports/relay-local`
- `L2 = L0 + packages/transports/relay-lan`
- `L3 = L0 + packages/transports/email`

后续若补 transport mode 装配，建议通过统一配置切换，例如：

- `TRANSPORT_MODE=local|relay_local|relay_lan|mcp_email`

但当前仓库运行时尚未接入该变量，因此它不应出现在 `.env.example` 中，也不应被当作现有可切换能力。

## 4.2 docs 目录职责（现有结构评估）

当前 `docs/` 的大类划分基本合理，建议保持以下职责边界：

- `architecture.md`
  - 顶层架构、模式边界、协议原则、核心不变量
- `platform-api-v0.1.md`
  - 外部控制面 API 契约
- `defaults-v0.1.md`
  - 冻结参数与实现约束
- `integration-playbook.md`
  - Buyer / Seller / Platform 的集成步骤
- `docs/diagrams/`
  - 时序图、状态图、RBAC 图
- `docs/checklists/`
  - 评审清单、联调清单、准入清单
- `docs/issues/`
  - 讨论记录、评审遗留、阶段性问题沉淀

当前主要缺口不在存储结构本身，而在“transport / mode 演进文档”的显式归位。建议后续如新增独立文档，优先放在：

- `architecture.md`：写原则与边界
- `repo-scaffold.md`：写代码布局与装配关系

不建议新建过多零散 mode 文档，否则很快会与主架构文档重复。

## 5. 配置约定

当前仓库根目录提供 `.env.example`，只列出当前代码真实读取的变量：

- `TOKEN_TTL_SECONDS`
- `BOOTSTRAP_SELLER_ID`
- `BOOTSTRAP_SUBAGENT_ID`
- `BOOTSTRAP_DELIVERY_ADDRESS`
- `BOOTSTRAP_SELLER_API_KEY`
- `BOOTSTRAP_SELLER_PUBLIC_KEY_PEM`
- `BOOTSTRAP_SELLER_PRIVATE_KEY_PEM`
- `ACK_DEADLINE_S`
- `PLATFORM_API_BASE_URL`
- `PLATFORM_API_KEY`
- `DATABASE_URL`
- `SQLITE_DATABASE_PATH`
- `TIMEOUT_CONFIRMATION_MODE`
- `HARD_TIMEOUT_AUTO_FINALIZE`
- `BUYER_CONTROLLER_POLL_INTERVAL_ACTIVE_S`
- `BUYER_CONTROLLER_POLL_INTERVAL_BACKOFF_S`
- `PORT`
- `SERVICE_NAME`
- `SELLER_ID`
- `SUBAGENT_IDS`
- `SELLER_SIGNING_PUBLIC_KEY_PEM`
- `SELLER_SIGNING_PRIVATE_KEY_PEM`
- `SELLER_MAX_HARD_TIMEOUT_S`
- `SELLER_ALLOWED_TASK_TYPES`
- `SELLER_HEARTBEAT_INTERVAL_MS`

默认值参考 `defaults-v0.1.md`。

## 6. 测试入口（TUI + Web UI）

- 单元测试：`npm run test:unit`
- 集成测试：`npm run test:integration`
- E2E：`npm run test:e2e`
- Vitest Web UI：`npm run test:e2e:ui`
- 流程图问题面板：`npm run test:flow:dashboard` 后访问 `site/test-flow-dashboard.html`

E2E 运行后会生成 `tests/reports/latest.json`，用于将问题按 `flow_step_id` 映射到时序图。
