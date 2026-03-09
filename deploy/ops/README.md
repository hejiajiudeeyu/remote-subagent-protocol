# Ops Deployment

This compose profile is for local development, demo, and advanced self-managed use.
It is no longer the primary install path for the end-user ops client.

For end-user buyer/seller install, prefer:

1. `npx @croc/ops setup`
2. `npx @croc/ops auth register --email you@example.com --platform http://127.0.0.1:8080`
3. `npx @croc/ops add-subagent --type process --subagent-id local.echo.v1 --cmd "node worker.js"`
4. `npx @croc/ops submit-review`
5. `npx @croc/ops enable-seller`
6. `npx @croc/ops start`
7. `npx @croc/ops doctor` / `npx @croc/ops debug-snapshot`

This path starts a local supervisor that manages relay, buyer, and optional seller together.
Runtime logs are written to `~/.remote-subagent/logs` and can be inspected from `ops-console` or `debug-snapshot`.
`ops-console` now provides a setup wizard for the local buyer/seller onboarding flow, so end users do not need to memorize the full step order.

Compose profile behavior:
- `buyer-controller` is always on
- `relay` is always on
- `seller-controller` is optional and starts only when you enable the `seller` profile

Docker Compose Quick Start:
The following steps apply only to the compose profile under `deploy/ops`.
1. `cp .env.example .env`
2. Set `PLATFORM_API_BASE_URL`
3. Start buyer mode: `docker compose up -d --build`
4. Enable local seller later: `docker compose --profile seller up -d seller-controller`

Compose API key bootstrap:
1. Start `platform-api`
2. Run `npm run ops:auth -- register --email you@example.com --platform http://127.0.0.1:8080`
3. The command writes `~/.remote-subagent/.env.local` with:
   - `PLATFORM_API_BASE_URL`
   - `BUYER_PLATFORM_API_KEY`
   - `PLATFORM_API_KEY`
   - `BUYER_CONTACT_EMAIL`
4. Restart `buyer-controller` if it was already running so it picks up the new env file

Notes:
- Use `BUYER_PLATFORM_API_KEY` after registering the buyer account
- user-facing setup should prefer the unified `ops` supervisor instead of directly managing `seller-controller`
- The intended UX is a single user console where buyer is default and seller is an opt-in role
