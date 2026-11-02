# Build from the repository folder "Caller Whale CRM" so the Cargo workspace is in context:
#   docker build -f services/features/backup-restore/Dockerfile -t callerwhale-backup-restore .
FROM golang:1 AS runtime-log-build
COPY services/features/backup-restore/runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM rust:1 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY services ./services
COPY desktop ./desktop
RUN cargo build --release -p callerwhale-backup-restore

FROM debian:bookworm-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Backup restore"
COPY --from=build /src/target/release/callerwhale-backup-restore /usr/local/bin/service
ENV PORT=8118
EXPOSE 8118
USER nobody
CMD ["service"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
