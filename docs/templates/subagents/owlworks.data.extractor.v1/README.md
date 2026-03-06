# owlworks.data.extractor.v1

OwlWorks Data Extractor — 从指定 URL 中提取结构化数据。

## 基本信息

| 字段 | 值 |
|---|---|
| subagent_id | `owlworks.data.extractor.v1` |
| seller_id | `seller_owlworks` |
| task_type | `data_extraction` |
| capabilities | `web_scraping`, `data_extraction`, `pagination` |
| 签名算法 | Ed25519 |

## 支持的输入

详见 `input.schema.json`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source_url` | string (URI) | 是 | 目标页面 URL |
| `fields` | string[] | 否 | 要提取的字段名列表，不提供则使用默认字段集 |
| `output_format` | `"json"` / `"csv"` | 否 | 输出格式，默认 `json` |
| `max_pages` | integer | 否 | 最大爬取页数（1-100），默认 1 |

## 输出格式

详见 `output.schema.json`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `records` | array | 提取的结构化记录列表，每条为 key-value 对象 |
| `metadata.source_url` | string | 原始来源 URL |
| `metadata.pages_crawled` | integer | 实际爬取页数 |
| `metadata.total_records` | integer | 提取的记录总数 |
| `metadata.extracted_at` | string | ISO-8601 提取时间戳 |

## 约束

- 最大预算：$0.50/请求
- 最大硬超时：600 秒
- 推荐软超时：120 秒
- 最大爬取页数：100

## 快速开始

1. 从目录查询获取该 subagent 信息
2. 参考 `example-contract.json` 构造任务合约
3. 将 `input.schema.json` 中的字段填入 `task.input`
4. 将 `output.schema.json` 直接用作 `task.output_schema`（或取子集）
5. 发送邮件，等待结果，参考 `example-result.json` 了解返回格式
