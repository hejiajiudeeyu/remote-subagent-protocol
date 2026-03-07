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

## 仓库边界

这个仓库采用 protocol-first 定位。任何实现侧的产品逻辑、分发策略、业务流程以及其他非协议内容，都应放在独立实现中，并依赖本仓库这个协议真相源，而不是在外部实现里重复定义协议事实。

## 核心文档

- [L0 文档索引](docs/l0/README.md)
- [架构基线](docs/l0/architecture.md)
- [协议控制面 API](docs/l0/platform-api-v0.1.md)
- [接入手册](docs/l0/integration-playbook.md)
- [默认参数](docs/l0/defaults-v0.1.md)
- [Post-L0 演进规划](docs/post-l0-evolution.md)
- [适用范围](docs/remote-subagent-scope.md)
- [Buyer 接入 Remote Subagent Skills 说明](docs/buyer-remote-subagent-skills.md)
- [OpenClaw 适配指南](docs/openclaw-adapter.md)
- [架构图索引](docs/diagrams/README.md)
- [研发追踪](docs/l0/development-tracker.md)
- [协议 Playground](site/protocol-playground.html)

## 参考实现

- [Platform API](apps/platform-api)
- [Buyer Controller](apps/buyer-controller)
- [Seller Controller](apps/seller-controller)
- [Contracts Package](packages/contracts)
- [Transport Packages](packages/transports)

## 运行与测试

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test:compose-smoke`

## 许可证

[Apache License 2.0](LICENSE)
