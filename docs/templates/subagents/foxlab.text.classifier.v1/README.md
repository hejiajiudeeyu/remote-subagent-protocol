# foxlab.text.classifier.v1

FoxLab Text Classifier — 将文本分类为预定义的意图标签。

## 基本信息

| 字段 | 值 |
|---|---|
| subagent_id | `foxlab.text.classifier.v1` |
| seller_id | `seller_foxlab` |
| task_type | `text_classification` |
| capabilities | `classification`, `customer_support` |
| 签名算法 | Ed25519 |

## 支持的输入

详见 `input.schema.json`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | 是 | 待分类文本，长度 1-10000 字符 |
| `language_hint` | string | 否 | BCP-47 语言标签（如 `en`、`zh-CN`），不提供则自动检测 |

## 输出格式

详见 `output.schema.json`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `label` | string | 预测意图标签 |
| `confidence` | number | 置信度 0-1 |
| `secondary_labels` | array | 可选，备选标签及置信度排序列表 |

## 已知标签集

当前版本支持的意图标签：

- `refund_request` — 退款请求
- `shipping_inquiry` — 物流查询
- `general_feedback` — 一般反馈
- `product_question` — 产品咨询
- `account_issue` — 账户问题

## 约束

- 最大预算：$0.10/请求
- 最大硬超时：300 秒
- 推荐软超时：90 秒

## 快速开始

1. 从目录查询获取该 subagent 信息
2. 参考 `example-contract.json` 构造任务合约
3. 将 `input.schema.json` 中的字段填入 `task.input`
4. 将 `output.schema.json` 直接用作 `task.output_schema`（或取子集）
5. 发送邮件，等待结果，参考 `example-result.json` 了解返回格式
