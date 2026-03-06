<div align="center">
  <h1>Remote Subagent Protocol | 远程子代理协议</h1>
  <p><em>一套面向买家与远程 Subagent 之间委托执行的开放协议</em></p>
</div>

[English](README.md) | 中文

---

## 项目概览

`Remote Subagent Protocol` 定义了一整套协作语义：买家如何发现远程 subagent、申请任务授权、投递标准合约、验证签名结果，并在持续调用中积累可比较的信任信号。

这里的 `Remote` 指执行边界和信任边界，不等于“必须跨公网部署”。即使在单机 `L0 local transport` 模式下，只要 buyer 和 seller 仍是边界清晰的协议参与方，它仍然表达的是 remote execution 语义。

这个仓库是协议真相源，目前包含：

- 协议架构与控制面规范
- buyer、seller、platform 三端参考实现
- 合约模板、schema、时序图与接入手册
- 单元、集成、端到端与 compose smoke 测试

## 仓库边界

这个仓库采用 protocol-first 定位。市场界面、排序、定价、争议处理、运营逻辑等 market-specific 内容，应该放在独立的 market 仓库里，并依赖本仓库，而不是在 market 仓库中重复定义协议真相源。

## 核心文档

- [架构基线](docs/architecture-mvp.md)
- [协议控制面 API](docs/platform-api-v0.1.md)
- [接入手册](docs/integration-playbook-mvp.md)
- [默认参数](docs/defaults-v0.1.md)
- [适用范围](docs/remote-subagent-scope.md)
- [架构图索引](docs/diagrams/README.md)
- [研发追踪](docs/development-tracker.md)
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
