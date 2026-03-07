# Tests

本目录包含 MVP 阶段的测试骨架与联调能力。

## 目录

- `tests/unit`：纯逻辑单测
- `tests/integration`：单服务集成测试（HTTP + 内存状态）
- `tests/e2e`：三端联调场景（成功/超时/token 过期/结果不合规）
- `tests/mocks`：联调 mock（平台、transport 总线、时钟）
- `tests/helpers`：测试工具函数
- `tests/reports`：测试运行产物（`latest.json`）

## 运行

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test:e2e:ui`（Vitest Web UI）

## 流程图反馈

`npm run test:e2e` 会写出 `tests/reports/latest.json`，可在
`site/test-flow-dashboard.html` 中加载并把问题映射到时序图步骤编号（如 `F1-F1`）。
