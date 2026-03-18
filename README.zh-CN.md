<div align="center">
  <h1>Remote Subagent Protocol | 远程子代理协议</h1>
  <p><em>一套面向本地 Buyer Agent 与远程 Subagent 之间委托执行的开放协议</em></p>
</div>

[English](README.md) | 中文

---

## 项目概览

`Remote Subagent Protocol` 定义了一整套协作语义：买方本地智能体如何发现远程 subagent、申请任务授权、投递标准合约、验证签名结果，并在持续调用中积累可比较的信任信号。

这里的 `Remote` 指执行边界和信任边界，不等于“必须跨公网部署”。即使在单机 `L0 local transport` 模式下，只要 buyer 和 seller 仍是边界清晰的协议参与方，它仍然表达的是 remote execution 语义。

该协议要解决的是当前 Agent 系统里的一个普遍痛点：一旦任务需要外部工具、私有基础设施、领域专用工作流，或由另一套运行时长期维护的能力，接入方式往往就会退化成零散 API、prompt 约定和项目私有胶水代码。这样不仅难以复用、难以验收，也很难在不同宿主 Agent 之间迁移。`Remote Subagent Protocol` 采用 transport-neutral、contract-first 的方式，把目录发现、任务授权、投递、签名结果和信任积累收敛成统一协议链路，使 Buyer Agent 调用远程能力时，面对的是稳定协议能力，而不是一次性集成脚本。

这个仓库是协议真相源，目前包含：

- 协议架构与控制面规范
- buyer 侧本地智能体、remote subagent 运行时、platform 三端参考实现
- 合约模板、schema、时序图与接入手册
- 单元、集成、端到端与 compose smoke 测试

这个仓库当前处于“预拆分”阶段：

- `packages/contracts` 正在被收口为第一个可发布的协议产物
- client/runtime 与 platform/deploy 代码仍暂时保留在 monorepo 内，以保持联调效率
- 新 scope 和三仓命名目前只存在于规划文档中，尚未正式执行 rename

当前已实现的结果交付基线：

- platform 为单次请求下发双向 `delivery-meta`，同时包含 `task_delivery` 与 `result_delivery`
- seller 返回纯 JSON 结果正文，buyer controller 验证通过后才向上游 agent 暴露
- 文件产出通过附件传递，并由签名后的 `artifacts[]` 元数据绑定完整性
- `platform_inbox` 目前只在协议层预留，运行时尚未实现

## 仓库边界

这个仓库采用 protocol-first 定位。任何实现侧的产品逻辑、分发策略、业务流程以及其他非协议内容，都应放在独立实现中，并依赖本仓库这个协议真相源，而不是在外部实现里重复定义协议事实。

预拆分边界文档：

- [协议预拆分边界](docs/current/guides/protocol-pre-split-boundary.md)
- [预拆分命名矩阵](docs/current/guides/pre-split-naming-matrix.md)

## 核心文档

- [当前文档索引](docs/current/README.md)
- [架构基线](docs/current/spec/architecture.md)
- [协议控制面 API](docs/current/spec/platform-api-v0.1.md)
- [接入手册](docs/current/guides/integration-playbook.md)
- [默认参数](docs/current/spec/defaults-v0.1.md)
- [规划路线图](docs/planned/roadmap/evolution-roadmap.md)
- [适用范围](docs/current/spec/remote-subagent-scope.md)
- [Buyer 接入 Remote Subagent Skills 说明](docs/planned/design/buyer-remote-subagent-skills.md)
- [OpenClaw 适配指南](docs/planned/design/openclaw-adapter.md)
- [架构图索引](docs/current/diagrams/README.md)
- [当前实现状态](docs/current/status/current-implementation-status.md)
- [部署指南](docs/current/guides/deployment-guide.md)
- [产品可用性边界](docs/current/guides/product-readiness-boundary.md)
- [Release 兼容矩阵](docs/archive/releases/compatibility-matrix.md)
- [当前收尾清单](docs/current/status/current-closeout-checklist.md)
- [Release 流程](docs/current/guides/release-process.md)
- [协议预拆分边界](docs/current/guides/protocol-pre-split-boundary.md)
- [预拆分命名矩阵](docs/current/guides/pre-split-naming-matrix.md)
- [协议 Playground](site/protocol-playground.html)

## 参考实现

- [Platform API](apps/platform-api)
- [Buyer Controller](apps/buyer-controller)
- [Seller Controller](apps/seller-controller)
- [Contracts Package](packages/contracts)
- [Transport Packages](packages/transports)

## 终端用户 Ops 客户端

- `npm run ops -- bootstrap --email you@example.com --platform http://127.0.0.1:8080`：单命令完成本地 buyer / seller bootstrap
- `npm run ops -- setup`：初始化统一本地客户端，配置写入 `~/.delexec`
- `npm run ops -- auth register --email you@example.com --platform http://127.0.0.1:8080`：注册 buyer API key
- `npm run ops -- add-subagent --type process --subagent-id local.echo.v1 --cmd "node worker.js"`：接入一个本地 seller subagent
- `npm run ops -- remove-subagent --subagent-id local.echo.v1`：从 seller 端本地删除一个 subagent
- `npm run ops -- disable-subagent --subagent-id local.echo.v1`：在 seller 端本地禁用一个 subagent
- `npm run ops -- enable-subagent --subagent-id local.echo.v1`：重新启用一个已禁用的本地 subagent
- `npm run ops -- submit-review`：提交当前本地 seller subagent 的平台审批
- `npm run ops -- enable-seller`：在本地启用 seller runtime
- `npm run ops -- start`：启动本地 supervisor、buyer 和 relay
- `npm run ops -- doctor`：检查本地 runtime 与 adapter 状态
- `npm run ops -- debug-snapshot`：导出包含最近事件与日志尾部的本地调试快照

## 仓库开发与测试命令

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test:compose-smoke`

## Web 控制台

- `npm run dev:ops-console`：buyer / seller 共用用户控制台
- `npm run dev:platform-console-gateway`：`platform-console` 使用的本地 operator gateway
- `npm run dev:platform-console`：平台管理控制台前端
- `ops-console` 已包含 setup wizard、请求 timeline / result 面板、runtime alerts 和本地 debug snapshot
- `ops-console` 现在支持本地 passphrase 解锁；敏感信息写入 `~/.delexec/secrets.enc.json`，不再放在浏览器存储中
- `platform-console` 现在必须通过 `platform-console-gateway` 访问平台管理接口；浏览器不再直接保存 `PLATFORM_ADMIN_API_KEY`
- `platform-console` 仍包含 reviewer guidance、review/audit 历史摘要，以及基于 reviewer notes 的 approve / reject / enable / disable 操作，并在 subagent 详情中展示最近一次隐藏审核测试结论

## 部署入口

- 终端用户安装 buyer / seller 的主路径：`npm install && npm run ops -- bootstrap --email you@example.com --platform http://127.0.0.1:8080`
- 手动路径：`npm install -> npm run ops -- setup -> auth register -> add-subagent -> submit-review -> enable-seller -> start`
- 完整终端用户步骤与排障说明见 [deploy/ops](deploy/ops)
- AI 辅助终端用户部署说明见 [End-User AI Deployment Guide](docs/current/guides/end-user-ai-deployment-guide.md)
- 终端用户本地日志默认写入 `~/.delexec/logs`，`ops-console` 通过 supervisor 读取这些日志
- Docker / Compose 继续主要用于 platform、relay、CI、本地联调和高级独立部署
- `make deploy-public-stack`：首个面向 operator 的公网入口 bundle
- `npm run test:public-stack-smoke`：验证公网入口 bundle
- `make deploy-platform`：独立部署 `platform-api` + PostgreSQL
- `make deploy-ops`：统一用户端分发入口（默认 buyer，seller 按需开启）
- `make deploy-relay`：独立部署共享 transport relay
- `make deploy-buyer`：独立部署 `buyer-controller`
- `make deploy-seller`：独立部署 `seller-controller`
- `make deploy-all`：单机联调整套系统

部署说明：

- `deploy/platform` 现在默认按生产导向配置，不会自动启用 bootstrap demo seller
- 需要本地 / 演示用的预置 bootstrap actor 时，优先使用 `deploy/all-in-one`，或在 platform 环境中显式设置 `ENABLE_BOOTSTRAP_SELLERS=true`

部署目录位于：

- [deploy/platform](deploy/platform)
- [deploy/public-stack](deploy/public-stack)
- [Public Stack Operator Guide](docs/current/guides/public-stack-operator-guide.md)
- [deploy/ops](deploy/ops)
- [deploy/relay](deploy/relay)
- [deploy/buyer](deploy/buyer)
- [deploy/seller](deploy/seller)
- [deploy/all-in-one](deploy/all-in-one)

## 许可证

[Apache License 2.0](LICENSE)
