# OpenClaw 适配指南

状态：Draft  
更新时间：2026-03-07

本文档说明如何把 Buyer 侧的 `Remote Subagent Protocol` 能力适配成 OpenClaw 可直接使用的 skill。

## 1. 适配目标

对 OpenClaw 来说，理想目标不是让模型自己学会 Buyer 协议步骤，而是：

1. OpenClaw 只看到一个或少量稳定 skill
2. skill 背后由 Buyer 侧桥接服务完成协议编排
3. OpenClaw 拿到的是结构化结果，不需要理解 token、ACK、验签细节

这与当前相邻目录中的 OpenClaw skill 约定是兼容的，参考 [../Agent-Zhihu/openclaw-skill/SKILL.md](/Users/hejiajiudeeyu/Documents/Projects/Agent-Zhihu/openclaw-skill/SKILL.md)。

## 2. 为什么 OpenClaw 需要桥接层

OpenClaw skill 的典型接入方式是：

1. 在 `~/.openclaw/openclaw.json` 里声明一个 skill
2. skill 指向一个固定 `baseUrl`
3. OpenClaw 对该 skill 发起 HTTP 请求

这意味着 OpenClaw 天然更适合调用一个“高层能力接口”，而不是直接调 Buyer Controller 的多步接口。

如果直接把 Buyer Controller 暴露给 OpenClaw，会出现三个问题：

1. 模型需要自己决定何时 `create request`、何时 `prepare`、何时 `sync-events`
2. 模型需要自己保存 `request_id`
3. 模型需要自己处理重试、超时、签名与验收逻辑

这三个都不应该交给模型。

## 3. 推荐适配形态

### 3.1 一个通用 skill

优先推荐：

- `remote-subagent`

而不是一开始就做：

- `foxlab-classifier`
- `owlworks-extractor`
- `xxx-formatter`

原因：

- OpenClaw 的 skill 列表应尽量稳定
- subagent 列表会变，skill 名称不应频繁变化
- 通用 skill 更适合先查 catalog 再选 subagent

### 3.2 在 skill 内部支持 alias

如果确实有高频能力，可以在桥接层内部给常用 subagent 做 alias，例如：

- `classify-text -> foxlab.text.classifier.v1`
- `extract-fields -> owlworks.data.extractor.v1`

但 alias 应属于桥接层内部映射，不应替代协议里的 `subagent_id` 真相层。

## 4. OpenClaw 配置建议

参考现有 OpenClaw skill 的配置形态，推荐在 `~/.openclaw/openclaw.json` 中加入：

```json
{
  "skills": {
    "remote-subagent": {
      "baseUrl": "http://127.0.0.1:8090/skills/remote-subagent",
      "apiKey": "buyer_你的Buyer或桥接层Key"
    }
  }
}
```

说明：

- `baseUrl` 推荐指向 Buyer 侧 skill adapter，而不是直接指向 Platform 或 Seller
- `apiKey` 推荐由 Buyer 身份或 Buyer 专用桥接层身份提供
- 不建议把 Seller API key 暴露给 OpenClaw

## 5. 推荐的桥接接口

### 5.1 `GET /skills/remote-subagent/catalog`

用途：

- 供 OpenClaw 查询当前可用 remote subagent

返回示例：

```json
{
  "items": [
    {
      "subagentId": "foxlab.text.classifier.v1",
      "sellerId": "seller_foxlab",
      "displayName": "Foxlab Text Classifier",
      "taskTypes": ["classification"],
      "status": "active"
    }
  ]
}
```

### 5.2 `POST /skills/remote-subagent/invoke`

这是 OpenClaw 最核心的调用入口。

请求建议：

```json
{
  "subagentId": "foxlab.text.classifier.v1",
  "taskType": "classification",
  "input": {
    "text": "Customer asks for refund after duplicate charge."
  },
  "constraints": {
    "softTimeoutS": 90,
    "hardTimeoutS": 300
  }
}
```

返回建议：

```json
{
  "requestId": "req_xxx",
  "status": "SUCCEEDED",
  "result": {
    "summary": "Task completed"
  },
  "seller": {
    "sellerId": "seller_foxlab",
    "subagentId": "foxlab.text.classifier.v1"
  }
}
```

### 5.3 `GET /skills/remote-subagent/requests/{requestId}`

用于长任务、异步任务或调试。

## 6. 桥接层内部如何映射到当前仓库

本文这一节描述的是 OpenClaw bridge 对 Buyer Controller 的底层桥接方式，不是终端用户通过统一 `ops` 客户端使用系统的主路径。

当前仓库里，OpenClaw bridge 最适合基于 [packages/buyer-controller-core/src/index.js](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/packages/buyer-controller-core/src/index.js) 或 [apps/buyer-controller/src/server.js](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/apps/buyer-controller/src/server.js) 实现。

一次 `invoke` 的内部流程建议固定为：

1. `GET /controller/catalog/subagents`
2. `POST /controller/requests`
3. `POST /controller/requests/{request_id}/prepare`
4. 可选：`POST /controller/requests/{request_id}/contract-draft`
5. `POST /controller/requests/{request_id}/dispatch`
6. 循环：
   - `POST /controller/requests/{request_id}/sync-events`
   - `POST /controller/inbox/pull`
   - `GET /controller/requests/{request_id}`
7. 直到请求进入终态

说明：

- `POST /controller/inbox/pull` 只在当前 `L0 local transport` 单机联调中由 Buyer 侧主动触发。
- 真正远端部署时，Seller Runtime 应自己消费其 inbox；OpenClaw bridge 不应长期依赖这个步骤。

## 7. OpenClaw 的 Prompt / Skill 使用建议

### 7.1 系统提示建议

给 OpenClaw 的系统提示里，建议明确写：

- 当任务需要远程能力时，优先使用 `remote-subagent` skill
- 不要自行拼 Buyer Controller 的多步 HTTP 调用
- 不要暴露 token、delivery address、ACK 等协议细节给最终用户
- 返回时优先给出结构化结果，其次给出 `requestId` 便于追踪

### 7.2 一句话调用示例

OpenClaw 用户侧应允许这种自然语言：

- “调用远程分类 skill，把这段文本分类成结构化 JSON。”
- “用 remote subagent `foxlab.text.classifier.v1` 处理这条工单。”
- “把这段材料交给远程字段抽取 skill。”

### 7.3 OpenClaw 侧不要暴露的细节

不建议让 OpenClaw 用户直接输入这些协议参数：

- `request_id`
- `task_token`
- `task_delivery.address`
- `thread_hint`
- `seller_public_key_pem`

这些都应由桥接层自动处理。

## 8. OpenClaw 适配时的几个硬约束

### 8.1 Skill 返回必须稳定

OpenClaw 侧的 skill 返回建议固定为：

- `status`
- `result`
- `error`
- `requestId`

不要把 Buyer Controller 的原始全量响应直接暴露给模型，否则模型会被过多协议噪音干扰。

### 8.2 必须保留审计字段

虽然不建议把全量协议响应直接交给模型，但桥接层内部必须保留：

- `requestId`
- `sellerId`
- `subagentId`
- `resultPackage`

用于后续排障、复盘和验签审计。

### 8.3 不要把 skill 名称绑定到 seller

OpenClaw 适配时，skill 名称应围绕能力或通用入口，而不是围绕 seller 身份命名。

推荐：

- `remote-subagent`
- `classify-text`

不推荐：

- `seller-foxlab`
- `seller-owlworks`

因为协议层关注的是：

- Buyer 调哪个 `subagent_id`

而不是把 Seller 身份暴露成用户心智主入口。

## 9. 当前仓库与 OpenClaw 适配的边界

当前仓库已经具备 OpenClaw 适配所需的协议底座：

- Buyer 注册
- catalog 查询
- prepare / dispatch / sync-events
- result inbox pull
- timeout 与终态管理
- 签名校验与终态归类

当前仓库还没有直接内置一个 OpenClaw bridge 服务。

因此，当前最正确的说法是：

- `OpenClaw 可适配`
- `适配点已经清晰`
- `但仍需在 Buyer 侧补一层 OpenClaw-friendly skill bridge`

如果后续要实现，建议把它放在单独目录，例如：

- `apps/openclaw-bridge`

而不要把 OpenClaw 专有语义直接写进 Buyer Controller。
