# The CRM server and the website it serves. Build with the branch (or the "Caller Whale CRM" folder) as the context:
#   docker build -f services/core-api/Dockerfile -t callerwhale-core-api .
# Runs any number of copies: it keeps no state in memory that matters, and a person's session is a signed token.
# It needs PostgreSQL (DATABASE_URL, MIGRATION_DATABASE_URL) and its settings from env/core-api.env (env/README.md).
FROM rust:1 AS build
WORKDIR /src
COPY services/auth/verify ./services/auth/verify
COPY services/core-api/rust ./services/core-api/rust
WORKDIR /src/services/core-api/rust
RUN cargo build --release -p callerwhale-api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/services/core-api/rust/target/release/callerwhale-api /usr/local/bin/callerwhale-api
COPY services/core-api/website /srv/website
ENV CALLERWHALE_BIND=0.0.0.0:8088 \
    CALLERWHALE_SITE_DIR=/srv/website \
    CALLERWHALE_ARTIFACT_DIR=/var/lib/callerwhale/artifacts
RUN mkdir -p /var/lib/callerwhale/artifacts && chown -R 65534:65534 /var/lib/callerwhale
EXPOSE 8088
USER 65534:65534
CMD ["callerwhale-api"]
