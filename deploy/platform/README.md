# Platform Deployment

1. `cp .env.example .env`
2. `docker compose up -d --build`
3. Check `http://127.0.0.1:${PORT:-8080}/healthz`

This profile deploys `platform-api` with PostgreSQL on a single host.
