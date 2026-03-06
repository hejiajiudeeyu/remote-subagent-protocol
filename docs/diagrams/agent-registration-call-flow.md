# Agent Registration Call Flow (Subagent Onboarding / Import)

## 关键澄清

- v0.1 下 seller 不直接维护线上 subagent 列表；由平台导入并建立 `seller_id -> subagent_id` 关联。
- seller agent 注册必须带 `owner_user_id`（提交人标识），用于审核与审计追踪。
- 只有当 agent 审核通过并导入成功后，`owner_user_id` 才可激活 `seller` 角色能力。
- `template_ref` 是模板语义绑定键；buyer 消费模板时走平台 API 下发。
- 注册与上架分离：`资料提交` 不等于 `active` 上架。
- 权限来源：seller 权限来自该用户自己的 API Key；不是单独再签发“seller 专用 key”。

## 阶段代号与编号规则（v1.1）

- `A`：提交 subagent 资料
- `B`：结构与合规校验
- `C`：人工审核
- `D`：导入目录与版本落库
- `E`：激活发布与回执

编号后缀：

- `-REQ`：请求消息
- `-RES`：响应消息
- `-ACT`：本地动作
- `-S*`：成功分支事件
- `-F*`：失败分支事件
- `-END_SUCCESS | -END_FAIL`：终态

```mermaid
sequenceDiagram
    autonumber
    participant SU as Seller User
    participant PORTAL as Seller Submission Form
    participant P as Platform API
    participant IAM as IAM / RBAC
    participant RV as Reviewer / Ops
    participant IMP as Import CLI / Pipeline
    participant CAT as Catalog Store
    participant TPL as Template Store (Repo)

    SU->>PORTAL: [A1-REQ] 填写 subagent 信息与模板引用（含 owner_user_id）
    PORTAL->>P: [A2-REQ] POST /v1/catalog/subagents (draft, owner_user_id)

    P->>P: [B1-ACT] 校验字段完整性（seller_id/subagent_id/capabilities 等）
    P->>IAM: [B1A-REQ] 校验 owner_user_id 对 seller_id 的提交权限
    alt 权限不足
        IAM-->>P: [B1A-F1] FORBIDDEN (USER_NOT_ALLOWED_FOR_SELLER)
        P-->>PORTAL: [B1A-F2] 403
        PORTAL-->>SU: [B1A-END_FAIL] 无提交权限
    else 权限通过
        IAM-->>P: [B1A-RES] allow
    end
    P->>TPL: [B2-REQ] 校验模板 5 件套存在与可读

    alt 结构或模板校验失败
        TPL-->>P: [B2-F1] TEMPLATE_NOT_FOUND / SCHEMA_INVALID
        P-->>PORTAL: [B2-F2] 400/422 + field_errors
        PORTAL-->>SU: [B2-END_FAIL] 返回修改建议
    else 校验通过
        TPL-->>P: [B2-RES] template bundle valid
        P->>P: [B3-ACT] 生成待审核草案（status=draft_pending_review）

        P-->>RV: [C1-REQ] 提交审核任务（含变更 diff）
        RV->>RV: [C2-ACT] 审核能力描述/约束/安全项

        alt 审核拒绝
            RV-->>P: [C2-F1] reject + review_comments
            P-->>PORTAL: [C2-F2] 409 REVIEW_REJECTED
            PORTAL-->>SU: [C2-END_FAIL] 驳回并返回意见
        else 审核通过
            RV-->>P: [C2-RES] approve

            P->>IMP: [D1-REQ] 触发导入（single/batch）
            IMP->>CAT: [D2-REQ] upsert catalog item + version bump
            alt 导入失败
                CAT-->>IMP: [D2-F1] import error / conflict
                IMP-->>P: [D2-F2] IMPORT_FAILED
                P-->>PORTAL: [D2-F3] 500/409
                PORTAL-->>SU: [D2-END_FAIL] 导入失败
            else 导入成功
                CAT-->>IMP: [D2-RES] catalog_version committed
                IMP-->>P: [D1-RES] import batch committed
                P->>IAM: [E0-REQ] 写入资源绑定（owner_user_id -> seller_id -> subagent_id）
                IAM-->>P: [E0-RES] resource binding persisted
                P->>IAM: [E0A-REQ] 为 owner_user_id 激活 seller 角色能力（若未激活）
                IAM-->>P: [E0A-RES] role_scopes updated

                P->>CAT: [E1-REQ] 设置 status=active（或按策略灰度）
                CAT-->>P: [E1-RES] published
                P-->>PORTAL: [E2-RES] 201 registered + active + catalog_version + seller_role_active
                PORTAL-->>SU: [E2-END_SUCCESS] 注册并上架成功
            end
        end
    end
```

## 最小状态机（建议）

- subagent 状态：`DRAFT_PENDING_REVIEW -> APPROVED -> IMPORTED -> ACTIVE`
- 驳回路径：`DRAFT_PENDING_REVIEW -> REJECTED -> RESUBMIT`

## 失败分支最小处置

- `TEMPLATE_NOT_FOUND/SCHEMA_INVALID`：卖家修模板后重提。
- `REVIEW_REJECTED`：按 review_comments 迭代资料。
- `IMPORT_FAILED`：回滚批次并重跑导入，保持目录版本单调。
- `USER_NOT_ALLOWED_FOR_SELLER`：先完成组织授权或管理员绑定后再提交。
