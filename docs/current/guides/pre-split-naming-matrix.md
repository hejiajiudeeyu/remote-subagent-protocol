# Pre-Split Naming Matrix

本文件冻结未来三仓拆分时需要一起替换的命名矩阵。

当前阶段的命名冻结已经执行到仓内实现与当前文档，后续物理拆仓只剩 git 历史与仓库初始化。

## 当前名到目标名

| 维度 | 当前值 | 目标值 | 当前状态 |
| :--- | :--- | :--- | :--- |
| 协议仓库 | `remote-subagent-protocol` | `delegated-execution-protocol` | 仅规划，未执行 |
| 客户端仓库 | N/A | `delegated-execution-client` | 仅规划，未执行 |
| 服务端仓库 | N/A | `delegated-execution-platform-selfhost` | 仅规划，未执行 |
| npm scope | `@croc` | `@delexec` | 已执行 |
| 协议包 | `@delexec/contracts` | `@delexec/contracts` | 已执行 |
| CLI 包 | `@delexec/ops` | `@delexec/ops` | 已执行 |
| CLI 可执行名 | `croc-ops` | `delexec-ops` | 已执行，保留短兼容窗口 |
| JWT issuer | `croc-platform-api` | `delexec-platform-api` | 已执行 |
| 本地数据目录 | `~/.remote-subagent/` | `~/.delexec/` | 已执行，保留迁移逻辑 |
| SQLite 文件名 | `croc.sqlite` | `delexec.sqlite` | 已执行，保留迁移逻辑 |

## 执行规则

- scope、CLI 名、JWT issuer、本地目录名和 SQLite 文件名已经在同一轮仓内收口完成。
- 全文扫描现在改为确认旧命名只保留在迁移说明和历史规划文档中。
- client 与 platform 侧的 clean-room / packaged-e2e gate 继续作为物理拆仓前置条件。

## 当前冻结决定

- `@delexec` 现在视为正式定稿命名，不再作为占位。
- `delexec-ops`、`delexec-platform-api`、`~/.delexec/` 和 `delexec.sqlite` 已冻结为正式默认值。
- 兼容窗口与迁移细节见 [rename-local-state-migration-map.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/guides/rename-local-state-migration-map.md)。
