# End-User AI Deployment Guide

This guide describes the current supported path for letting an AI help an end user install and bootstrap the local client.

## Current Supported Install Strategy

Current truth:

- the repository contains the real `@delexec/ops` CLI workspace
- the repository does **not** yet contain a verified npm publish flow for `@delexec/ops`
- current user-facing install guidance should therefore use the **repo-local** path

Use:

```bash
npm install
npm run ops -- bootstrap --email you@example.com --platform http://127.0.0.1:8080
```

Do not assume `npx @delexec/ops ...` is available unless a separate publish workflow has been completed and documented.

## What The AI Should Do

The recommended AI flow is:

1. clone or open the repository on the user's machine
2. run `npm install`
3. run the single bootstrap command
4. inspect the JSON output
5. if approval is pending, tell the user or operator exactly that
6. after approval, rerun bootstrap or `run-example`

## Single-Command Bootstrap

```bash
npm run ops -- bootstrap --email you@example.com --platform http://127.0.0.1:8080
```

This flow attempts to:

1. initialize `~/.delexec`
2. register the buyer
3. install the official example subagent
4. submit seller and subagent review
5. enable the local seller runtime
6. start the local supervisor
7. run the local example self-call

## Expected Output

The command returns JSON. The AI should read the output instead of parsing shell text heuristically.

Success shape:

```json
{
  "ok": true,
  "request_id": "req_xxx",
  "status": "SUCCEEDED"
}
```

Pending-approval shape:

```json
{
  "ok": false,
  "stage": "awaiting_admin_approval"
}
```

## Useful Follow-Up Commands

```bash
npm run ops -- run-example --text "Summarize this request."
npm run ops -- doctor
npm run ops -- debug-snapshot
```

## What The AI Should Report Back

The AI should summarize only these user-relevant outcomes:

- setup completed or not
- buyer registration completed or not
- review submitted or not
- seller enabled or not
- admin approval still required or not
- example request succeeded or not

## Current Limits

- platform must already be reachable
- seller and subagent still require admin approval
- this is a repo-local install path, not yet a package-manager distribution promise
- email transport is optional and not required for the bootstrap path
