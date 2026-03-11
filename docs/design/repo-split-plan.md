# 仓库拆分规划

## 1. 背景

当前 monorepo 包含协议定义、参考实现（buyer/seller）、平台服务、部署配置、运维 CLI 与控制台。随着 L0 闭环趋于稳定，需要将仓库拆分为独立职责的多个仓库，以便于协议独立演进、客户端独立分发、平台独立部署。

## 2. npm scope

拆分后所有包将从当前的 `@croc/` scope 迁移到与仓库命名体系对齐的新 scope。

| 项 | 当前值 | 拆分后目标 |
| :--- | :--- | :--- |
| npm scope | `@croc` | `@delexec`（待最终确认） |
| CLI 入口 | `npx @croc/ops` | `npx @delexec/ops`（待最终确认） |
| JWT issuer | `croc-platform-api` | 与新 scope 对齐 |
| 本地数据目录 | `~/.remote-subagent/` | 待对齐（可保留或随 scope 更名） |
| SQLite 文件名 | `croc.sqlite` | 待对齐 |

迁移约束：

- scope 变更是一次性的全局替换，涉及所有 `package.json`、import 路径、文档示例、CLI 入口和 JWT claims。
- 应在拆分执行的同一批变更中完成，避免中间态。
- 最终 scope 名称在执行拆分前确认，本文档暂以 `@delexec/` 作为占位。

## 3. 目标仓库

### 3.1 delegated-execution-protocol（协议仓库）

定义 agent 生态中的委托执行协议，包括角色、对象模型、授权、合同、结果验证、信任累积、版本兼容与扩展边界。

命名理由：

- 语义准确——协议核心是"跨边界委托执行"，而非普通消息通信或工具调用。
- 与主流 agent 叙事自然衔接——MCP 是工具接入层，A2A 是 agent 间互操作层，本协议指向 execution delegation 这一层。
- 扩展性好——参与方无论叫 subagent、provider、executor、seller，协议名都不受限。

应包含内容：

| 来源路径 | 说明 |
| :--- | :--- |
| `packages/contracts/` | 协议常量、状态枚举、错误域、签名规范化 |
| `docs/l0/` | L0 协议规范全集 |
| `docs/templates/` | 能力声明模板与 JSON Schema |
| `docs/diagrams/` | 协议层流程图 |
| `docs/post-l0-evolution.md` | 演进规划 |
| `docs/remote-subagent-scope.md` | 范围指引 |

发布形式：npm 包（`@delexec/contracts`），供客户端和平台仓库作为上游依赖引用。

### 3.2 delegated-execution-client（客户端仓库）

面向终端用户的统一客户端，支持 buyer 主流程、seller 功能预置与启用，并内置 marketplace 接入能力。

命名理由：

- 足够宽——可同时容纳 buyer 和 seller 两侧能力。
- 不会把 marketplace 升格为仓库主名——marketplace 只是内置接入能力之一。
- 符合用户直觉——"client"就是用户安装和使用的那个东西。

应包含内容：

| 来源路径 | 说明 |
| :--- | :--- |
| `packages/buyer-controller-core/` | 买家端核心逻辑 |
| `packages/seller-runtime-core/` | 卖家端运行时核心 |
| `packages/transports/` | 传输适配器（local、relay-http、email） |
| `packages/sqlite-store/` | 客户端侧本地存储 |
| `apps/buyer-controller/` | 买家控制器服务 |
| `apps/seller-controller/` | 卖家控制器服务 |
| `apps/ops/` | 统一 Ops CLI |
| `apps/ops-console/` | 用户控制台 |
| 客户端侧 unit/integration 测试 | — |

### 3.3 delegated-execution-platform-selfhost（自部署仓库）

提供 delegated execution platform 的自部署方案，包括平台服务、部署配置、运维、升级、监控与私有化运行支持。

命名理由：

- 边界清晰——一眼就知道是 platform 的自部署方案。
- 适合长期演进——docker compose、helm、k8s、registry、auth、verification、observability 都能自然放入。
- 命名体系统一——三个仓库都围绕 `delegated-execution` 组织。

应包含内容：

| 来源路径 | 说明 |
| :--- | :--- |
| `apps/platform-api/` | 平台控制面 API |
| `apps/platform-console/` | 平台管理控制台 |
| `apps/transport-relay/` | 传输中继服务 |
| `packages/postgres-store/` | PostgreSQL 存储适配器 |
| `deploy/` | 全部部署配置（platform、relay、buyer、seller、ops、all-in-one） |
| `docker-compose.yml` | 根 compose |
| `Dockerfile.workspace` | 多应用构建基镜像 |
| `Makefile` | 部署快捷命令 |
| `.github/workflows/images.yml` | 镜像构建与发布 |
| 部署文档、运维文档 | — |
| e2e 测试与 compose smoke | 全链路测试需要全栈环境 |

## 4. 拆分后依赖拓扑

```
delegated-execution-protocol (npm: @delexec/contracts)
        ▲                    ▲
        │                    │
        │                    │
delegated-execution    delegated-execution
      -client            -platform-selfhost
```

协议仓库是纯上游。客户端和自部署仓库单向依赖协议仓库，互不依赖。

## 5. 共享包归属

| 包 | 归属仓库 | 消费方 | 说明 |
| :--- | :--- | :--- | :--- |
| `contracts` | protocol | client、platform-selfhost | 协议层定义，作为 npm 包发布 |
| `buyer-controller-core` | client | — | buyer 侧核心逻辑 |
| `seller-runtime-core` | client | — | seller 侧核心逻辑 |
| `sqlite-store` | client | — | 客户端默认存储 |
| `postgres-store` | platform-selfhost | — | 平台默认存储 |
| `transport-local` | client | — | 本地传输，仅客户端使用 |
| `transport-relay-http` | client | — | relay HTTP 传输适配器 |
| `transport-email` | client | — | 邮件传输适配器 |

## 6. 存储策略

| 侧 | 默认存储 | 理由 |
| :--- | :--- | :--- |
| 客户端（buyer/seller/ops） | SQLite | 零运维、零配置、安装即用，不需要用户额外启动数据库进程 |
| 平台（platform-api） | PostgreSQL | 多租户并发写入、事务隔离、聚合查询、多实例共享 |

设计约束：

- 存储层通过适配器抽象（`sqlite-store`、`postgres-store`）注入，业务逻辑不直接耦合具体存储实现。
- 默认选择不等于唯一选择——适配器接口保持统一，后续如有需要可以切换。
- 拆分后 `sqlite-store` 跟随 client 仓库，`postgres-store` 跟随 platform-selfhost 仓库，两个存储包不再有交集。

客户端选择 SQLite 的具体收益：

- 用户通过 `npx @delexec/ops` 启动后，SQLite 文件自动创建在本地数据目录，无需任何前置安装。
- 不引入额外的运行时进程，降低本地资源占用与排障复杂度。
- 离线场景下仍可查看历史请求记录。

平台选择 PostgreSQL 的具体收益：

- 支持多个 seller heartbeat、多个 buyer 的 token 签发和事件上报并发到达。
- 支持审核状态变更、目录条目更新等需要事务隔离的操作。
- 支持指标聚合查询与运维观测。
- 支持多实例水平扩展共享同一数据库。

## 7. 需要提前解决的问题

### 7.1 共享包发布管道

当前所有包为 `private: true`。拆分前需要：

- 确认最终 scope 名称（暂定 `@delexec/`，见 §2）。
- 选定发布渠道（npm public 或 GitHub Packages）。
- 建立发布流水线（CI 自动发版或手动 tag 触发）。

### 7.2 ops CLI 对 transport-relay 的直接依赖

当前 `ops` 应用直接依赖 `buyer-controller`、`seller-controller`、`transport-relay` 三个 app 作为 workspace 依赖。拆分后 `transport-relay` 归入自部署仓库。

解决方案：

- 方案 A：ops 中内嵌轻量本地 relay（用于 playground 场景）。
- 方案 B：ops 通过网络调用远端 relay，不再直接依赖其源码。

建议采用方案 B，同时在 ops 中提供 `--local-relay` 选项，自动拉起一个独立 relay 进程用于本地开发。

### 7.3 E2E 测试拆分

当前 `tests/` 目录是统一的，e2e 测试跨 buyer/seller/platform 全链路。

拆分策略：

| 测试类型 | 归属 | 说明 |
| :--- | :--- | :--- |
| unit | 各仓库各自携带 | 跟随源码 |
| integration | 各仓库各自携带 | 跟随源码 |
| e2e | platform-selfhost | 需要全栈环境，通过发布的镜像拉取各组件 |
| compose smoke | platform-selfhost | 同上 |

### 7.4 CI 拆分

当前 `ci.yml` 是统一流水线。拆分后各仓库需要独立 CI：

- protocol：lint + unit test + npm publish。
- client：lint + unit + integration + 客户端侧 smoke。
- platform-selfhost：lint + unit + integration + compose smoke + e2e + 镜像构建发布。

### 7.5 模板与目录同步

能力声明模板存放在协议仓库。平台需要通过 API 下发这些模板。

同步机制候选：

- 平台构建时从协议仓库 npm 包中提取模板文件。
- 平台侧维护 git submodule 指向协议仓库的 templates 目录。
- 平台 API 代理透传，运行时从协议仓库发布产物中读取。

建议在 L0 阶段使用构建时提取方案，后续可迁移到独立存储。

## 8. 拆分时机

建议在以下条件全部满足后执行拆分：

| 条件 | 原因 |
| :--- | :--- |
| L0 closeout checklist minimum bar 三项全部关闭 | 协议层趋于稳定，跨端联动改动大幅减少 |
| contracts 包接口冻结并有明确版本号 | 协议包是拆分根基，必须先稳定 |
| 至少跑通一次完整的 published-image compose smoke | 证明各组件可通过发布产物协作 |
| ops CLI 对 relay 的直接依赖已解耦 | 否则拆分会直接破坏 ops 功能 |

在此之前，保持 monorepo 开发。全链路联调在 monorepo 中效率最高——改一处跑一遍 `npm run test:e2e` 即可验证，无需跨仓库协调发版。

## 9. 预拆分准备（monorepo 内可提前完成）

以下工作可在不拆分的前提下完成，每完成一项都会降低将来拆分的成本。

### 9.1 冻结 contracts 公共 API 表面

- 整理 `packages/contracts/src/index.js` 的完整导出列表。
- 明确每个导出项的类型签名和语义。
- 标记版本号并写入 CHANGELOG。

### 9.2 存储包去耦

- 确认 `postgres-store` 和 `sqlite-store` 没有对特定 app 的隐式假设。
- 确保两者可作为独立 npm 包被任意仓库消费。

### 9.3 E2E 测试走 HTTP 调用

- 将 e2e 测试中的"源码直接 import"改为通过 HTTP 调用各服务。
- 拆分后测试不需要重写，只需改变服务启动方式。

### 9.4 ops CLI 解耦 relay

- 将 ops 中对 `transport-relay` 的直接代码依赖改为"启动外部进程或连接外部服务"模式。
- 保留 `--local-relay` 选项用于本地开发。

### 9.5 镜像独立构建验证

- 确认 CI 的 `images.yml` 中每个 app 的镜像能独立构建和发布。
- 不依赖 monorepo workspace 解析。

## 10. 执行顺序

1. 完成预拆分准备（§9）。
2. 确认最终 npm scope（§2），执行全局 scope 替换。
3. 将 `packages/contracts` 改为可发布的公共包，确定版本策略、发布渠道。
4. 拆出协议仓库——contracts 包 + 协议文档 + 模板。
5. 拆出自部署仓库——platform-api、platform-console、transport-relay、deploy 配置。
6. 剩余部分即为客户端仓库——调整 ops 对 relay 的依赖方式。
7. 重建 e2e 测试和 CI——这是拆分中最复杂的部分，需要全栈 compose 环境通过发布镜像拉取各组件。
