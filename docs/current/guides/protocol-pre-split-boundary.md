# Protocol Pre-Split Boundary

本文件冻结 monorepo 预拆分阶段里“协议仓”应承载的内容边界。

当前阶段目标不是立即拆出三个 git 仓库，而是先把协议侧真相源做成可独立发布、可被实现仓消费的上游产物。

## 当前协议真相源

以下内容属于未来 `delegated-execution-protocol` 仓库范围：

- [packages/contracts](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/packages/contracts)
- [docs/current/spec/architecture.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/spec/architecture.md)
- [docs/current/spec/platform-api-v0.1.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/spec/platform-api-v0.1.md)
- [docs/current/spec/defaults-v0.1.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/spec/defaults-v0.1.md)
- [docs/current/spec/remote-subagent-scope.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/spec/remote-subagent-scope.md)
- [docs/current/guides/integration-playbook.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/guides/integration-playbook.md)
- [docs/current/diagrams/doc-truth-source-map.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/diagrams/doc-truth-source-map.md)
- [docs/templates](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/templates)

## 未来三仓归属

未来协议仓：

- `packages/contracts`
- 协议规范、模板、图、版本兼容说明

未来客户端仓：

- `packages/buyer-controller-core`
- `packages/seller-runtime-core`
- `packages/sqlite-store`
- `packages/transports` 中客户端侧适配器
- `apps/buyer-controller`
- `apps/seller-controller`
- `apps/ops`
- `apps/ops-console`

未来服务端仓：

- `apps/platform-api`
- `apps/platform-console`
- `apps/platform-console-gateway`
- `apps/transport-relay`
- `packages/postgres-store`
- `deploy`
- `Dockerfile.workspace`

已冻结的归属规则：

- `platform-console-gateway` 归服务端，不归客户端
- `transport-relay` 归服务端，不归客户端
- `ops` 可以连接远端 relay，也可以启动外部 relay 进程，但拆仓后不再要求 relay 源码留在客户端仓

## 不属于协议仓的内容

以下内容保留在未来 client / platform 仓库，不应倒灌回协议侧：

- buyer / seller / ops / relay / platform 的运行时代码
- SQLite / PostgreSQL 存储实现
- compose、镜像、部署和 operator 运维流程
- 只描述当前实现细节的产品文档

## 协议稳定面

这几个面向下游仓库的接口现在视为协议稳定面：

- `@delexec/contracts` 中的错误码注册表与默认 retry 语义
- `@delexec/contracts` 中的请求状态枚举
- `@delexec/contracts` 中的结果签名 canonicalization 规则
- `docs/templates` 中的 catalog 模板、subagent 模板与 JSON Schema
- 协议规范文档中的对象模型、签名字段和验证顺序

## 发布产物策略

预拆分阶段的协议发布物是 `@delexec/contracts`。

它现在承担两类职责：

1. 导出稳定的协议常量和 helper。
2. 在打包时附带模板与协议文档快照，供 client/platform 通过已发布产物读取，而不是继续依赖 monorepo 相对路径。

已固定的模板发布形式：

- 模板源仍由 [docs/templates](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/templates) 维护。
- `@delexec/contracts` 在 `npm pack` / publish 时会携带 `templates/` 和 `templates/manifest.json`。
- 下游实现应通过 `@delexec/contracts` 导出的路径 helper 或 manifest 消费这些模板。

## 当前约束

- 现阶段仍保留 monorepo 作为开发主仓。
- 现阶段仍保留 `@delexec/*` 命名，不做半途 rename。
- 在 `@delexec/contracts` 发布链路、模板消费链路、clean-room 安装校验稳定前，不执行物理拆仓。

## 当前预拆分完成信号

下面这些信号现在已经被明确纳入预拆分 gate：

- `npm run test:protocol:package`
- `npm run test:service:packages`
- `npm run test:e2e:packages`

这三条分别对应：

- 协议产物可 clean-room 安装
- client/platform 关键服务产物可 clean-room 安装并启动
- 跨边界 e2e 可优先使用已安装 tarball 命令，而不是源码入口
