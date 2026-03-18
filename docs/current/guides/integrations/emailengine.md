# EmailEngine Integration

This project currently integrates against the EmailEngine REST API documented as:

- product docs page: `EmailEngine API 2.62.0`
- HTTP surface used by this repo: `REST API v1` paths under `/v1/...`

Reference:

- [EmailEngine API docs](https://learn.emailengine.app/docs/email-api)

## Current Scope

Implemented in:

- [packages/transports/emailengine/src/index.js](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/packages/transports/emailengine/src/index.js)

Current adapter capabilities:

- `send(envelope)`
- `poll({ limit })`
- `ack(message_id)`
- `health()`

Current model:

- single mailbox / shared mailbox
- unread inbox polling
- signed JSON result body stays in email text body
- artifacts travel as email attachments
- RSP metadata travels through custom headers such as `X-RSP-Request-Id`

Not implemented yet:

- webhook ingestion
- outbound/inbound folder routing strategy beyond `INBOX`
- multi-account routing
- bounce handling
- rate-limit aware backoff

## Config

`ops-console` and `ops supervisor` expect:

```json
{
  "type": "email",
  "email": {
    "provider": "emailengine",
    "sender": "buyer@example.com",
    "receiver": "seller@example.com",
    "poll_interval_ms": 5000,
    "emailengine": {
      "base_url": "http://127.0.0.1:3000",
      "account": "buyer@example.com"
    }
  }
}
```

Sensitive values are stored in local `.env`:

```env
TRANSPORT_EMAILENGINE_ACCESS_TOKEN=...
TRANSPORT_EMAILENGINE_BASE_URL=http://127.0.0.1:3000
TRANSPORT_EMAILENGINE_ACCOUNT=buyer@example.com
TRANSPORT_EMAIL_SENDER=buyer@example.com
TRANSPORT_EMAIL_RECEIVER=seller@example.com
TRANSPORT_EMAIL_PROVIDER=emailengine
TRANSPORT_TYPE=email
```

## API Endpoints Used

The current adapter uses these EmailEngine endpoints:

- `GET /v1/account/{account}`
  - used by supervisor connection test and adapter `health()`
- `POST /v1/account/{account}/submit`
  - send outbound RSP email
- `POST /v1/account/{account}/search`
  - poll unread inbox messages
- `GET /v1/account/{account}/message/{message}`
  - load full message body and headers
- `GET /v1/account/{account}/attachment/{attachment}`
  - fetch attachment bytes
- `PUT /v1/account/{account}/message/{message}`
  - mark as seen during `ack`

This mapping is intentionally conservative and does not depend on webhook or account-level automation features.

## Notes

- The adapter treats EmailEngine as a mailbox API backend, not as a transport protocol authority.
- RSP envelope semantics remain defined by this repo.
- Subject lines are prefixed with `[RSP]` to make mailbox filtering deterministic.
