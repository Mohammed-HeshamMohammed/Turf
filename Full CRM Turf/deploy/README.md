# Deploy

`compose.yml` runs every service, Postgres and Redis on one machine. Only the gateway (port 8100) is published. It was written before Docker was available on the machine that scaffolded it, so it has **not been run yet**: treat the first `docker compose up --build` as its test.

Per-service environment variables go in `.env` files that are never committed (`*.local` and `.env` are ignored). Each service's README lists what it needs.
