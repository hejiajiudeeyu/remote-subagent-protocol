# local.summary.v1

`local.summary.v1` is the official local demo subagent bundled with the ops client.

Use it to:

- learn the expected seller-side subagent shape
- validate local buyer -> seller self-call flow
- bootstrap coding agents with a stable, zero-dependency example

Input:

```json
{
  "text": "Summarize this local example request."
}
```

Output:

```json
{
  "summary": "Summarize this local example request."
}
```

Default metadata:

- `subagent_id`: `local.summary.v1`
- `task_types`: `["text_summarize"]`
- `capabilities`: `["text.summarize"]`
- `tags`: `["local", "example", "demo"]`
- `adapter_type`: `process`

The bundled worker is provided by:

- [example-subagent-worker.js](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/apps/ops/src/example-subagent-worker.js)
