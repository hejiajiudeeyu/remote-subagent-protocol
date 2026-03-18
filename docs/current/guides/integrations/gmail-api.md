# Gmail API Integration

This project currently integrates against the Google Gmail API documented as:

- OAuth token refresh: Google OAuth 2.0 token endpoint
- mail API surface used by this repo: `gmail/v1`

References:

- [Gmail API REST reference](https://developers.google.com/workspace/gmail/api/reference/rest)
- [users.messages REST reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [Create and send email messages](https://developers.google.com/workspace/gmail/api/guides/sending)

## Current Scope

Implemented in:

- [packages/transports/gmail/src/index.js](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/packages/transports/gmail/src/index.js)

Current adapter capabilities:

- `send(envelope)`
- `poll({ limit })`
- `ack(message_id)`
- `health()`

Current model:

- single mailbox / shared mailbox
- refresh-token based server-side access
- unread inbox polling with Gmail search query
- RSP metadata embedded in MIME headers
- signed JSON result payload stays in plain-text message body
- artifacts travel as MIME attachments

Not implemented yet:

- `watch` / push notifications
- browser OAuth sign-in flow
- label customization beyond removing `UNREAD`
- multi-account routing
- Gmail thread-specific optimization

## Config

`ops-console` and `ops supervisor` expect:

```json
{
  "type": "email",
  "email": {
    "provider": "gmail",
    "sender": "buyer@example.com",
    "receiver": "seller@example.com",
    "poll_interval_ms": 5000,
    "gmail": {
      "client_id": "google-client-id",
      "user": "buyer@example.com"
    }
  }
}
```

Sensitive values are stored in local `.env`:

```env
TRANSPORT_GMAIL_CLIENT_ID=...
TRANSPORT_GMAIL_CLIENT_SECRET=...
TRANSPORT_GMAIL_REFRESH_TOKEN=...
TRANSPORT_GMAIL_USER=buyer@example.com
TRANSPORT_EMAIL_SENDER=buyer@example.com
TRANSPORT_EMAIL_RECEIVER=seller@example.com
TRANSPORT_EMAIL_PROVIDER=gmail
TRANSPORT_TYPE=email
```

## API Endpoints Used

The current adapter uses these endpoints:

- `POST https://oauth2.googleapis.com/token`
  - refresh access token from refresh token
- `POST https://gmail.googleapis.com/gmail/v1/users/{user}/messages/send`
  - send MIME message
- `GET https://gmail.googleapis.com/gmail/v1/users/{user}/messages`
  - poll unread inbox messages with Gmail query
- `GET https://gmail.googleapis.com/gmail/v1/users/{user}/messages/{message}?format=full`
  - load full headers/body/parts
- `GET https://gmail.googleapis.com/gmail/v1/users/{user}/messages/{message}/attachments/{attachment}`
  - fetch attachment bytes when needed
- `POST https://gmail.googleapis.com/gmail/v1/users/{user}/messages/{message}/modify`
  - remove `UNREAD` label during `ack`
- `GET https://gmail.googleapis.com/gmail/v1/users/{user}/profile`
  - health check and supervisor connection test

## Notes

- This repo treats Gmail as a mailbox backend, not as a source of protocol truth.
- The adapter currently uses MIME generation inside the transport package rather than a separate mail library.
- OAuth client creation, consent screen setup, and refresh token issuance remain operator-managed outside this repo.
