# Seller Deployment

This profile is for standalone service deployment, CI, and advanced operators.
It is not the default install path for end-user seller setup on a personal computer.

For end-user seller install, prefer the CLI path:

1. `npx @croc/ops setup`
2. `npx @croc/ops auth register --email you@example.com --platform http://127.0.0.1:8080`
3. `npx @croc/ops add-subagent --type process --subagent-id local.echo.v1 --cmd "node worker.js"`
4. `npx @croc/ops submit-review`
5. `npx @croc/ops enable-seller`
6. `npx @croc/ops start`

## Standalone Docker Profile

Use the following path only for operator-managed standalone deployment, CI, or local integration.
This profile requires an external relay service; see `deploy/relay` for the companion relay profile.

1. `cp .env.example .env`
2. Set `PLATFORM_API_BASE_URL`, `PLATFORM_API_KEY`, `TRANSPORT_BASE_URL`, `SELLER_ID`, and `SUBAGENT_IDS`
3. `docker compose up -d --build`
4. Check `http://127.0.0.1:${PORT:-8082}/healthz`

This profile deploys `seller-controller` as a standalone service with SQLite by default and requires an external relay service.
