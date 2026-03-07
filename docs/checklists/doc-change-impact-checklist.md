# 文档改动影响清单（新增业务步骤时）

用途：当你增加一个业务步骤（例如新增状态、新增 API、新增分支）时，快速判断要改哪些文档，避免口径漂移。

## A. 必改（规范主干）

- [ ] `../l0/architecture.md`
- [ ] `../l0/platform-api-v0.1.md`
- [ ] `../l0/integration-playbook.md`
- [ ] `../l0/defaults-v0.1.md`（若涉及默认参数）

## B. 必改（图与状态）

- [ ] `../diagrams/user-remote-subagent-call-flow.md`
- [ ] `../diagrams/README.md`（若规则/锚点变化）
- [ ] `../diagrams/doc-truth-source-map.md`（若真相源/衍生物层次变化）

## C. 建议同步

- [ ] `../l0/development-tracker.md`（新增待实现项）
- [ ] `../../README.md` / `../../README.zh-CN.md`（外部说明口径）
- [ ] `subagent-admission-checklist.md`（准入门槛）

## D. 一致性检查

- [ ] 接口路径在文档中唯一且一致（无旧接口残留）
- [ ] 状态枚举在架构、集成、时序图一致
- [ ] 错误码域一致（`AUTH_* / CONTRACT_* / EXEC_* ...`）
- [ ] 真相源与衍生物层次未倒置（说明层未自行发明协议事实）
- [ ] Mermaid 可渲染通过（`mmdc -i <file>.md -o /tmp/<file>.svg`）
