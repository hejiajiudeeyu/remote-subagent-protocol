# Coding Agent Onboarding

This repo now includes a stable local demo path for coding agents.

The shortest bootstrap path is:

```bash
npm install
npm run ops -- bootstrap --email coding-agent@local.test --platform http://127.0.0.1:8080
```

The wrapper script remains available and delegates to the same CLI flow:

```bash
node scripts/coding-agent-bootstrap.mjs --email coding-agent@local.test --platform http://127.0.0.1:8080
```

The bootstrap flow will attempt to complete:

1. `delexec-ops setup`
2. buyer registration
3. official example subagent install
4. seller review submission
5. seller enable
6. supervisor start
7. seller/subagent approval when a local operator environment has access to `PLATFORM_ADMIN_API_KEY`
8. local example self-call through the normal buyer -> seller protocol path

Recommended environment:

```bash
export PLATFORM_API_BASE_URL=http://127.0.0.1:8080
export PLATFORM_ADMIN_API_KEY=sk_admin_xxx
export BOOTSTRAP_BUYER_EMAIL=coding-agent@local.test
```

`PLATFORM_ADMIN_API_KEY` is intended for local bootstrap automation or
`platform-console-gateway`. Browser clients should not store or use it directly.

Success criteria:

- output is JSON
- `steps` contains `setup_ok`, `buyer_registered`, `example_subagent_added`, `review_submitted`, `seller_enabled`
- terminal success returns:

```json
{
  "ok": true,
  "request_id": "req_xxx",
  "status": "SUCCEEDED"
}
```

If admin approval is missing, the command exits with:

- `stage: "awaiting_admin_approval"`

Useful follow-up commands:

```bash
npm run ops -- add-example-subagent
npm run ops -- run-example --text "Summarize this request."
```

Useful logs and snapshots:

- local ops home: `~/.delexec`
- runtime logs: `~/.delexec/logs`
- debug snapshot: `GET http://127.0.0.1:8079/debug/snapshot`
- supervisor status: `GET http://127.0.0.1:8079/status`
