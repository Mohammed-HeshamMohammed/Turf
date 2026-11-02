# Build from the repository folder "Caller Whale CRM" so the Cargo workspace is in context:
#   docker build -f services/auth/Dockerfile -t callerwhale-auth .
FROM golang:1 AS runtime-log-build
COPY services/auth/runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM rust:1 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY services ./services
COPY desktop ./desktop
RUN cargo build --release -p callerwhale-auth

FROM debian:bookworm-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Auth"
COPY --from=build /src/target/release/callerwhale-auth /usr/local/bin/service
ENV PORT=8101
EXPOSE 8101
USER nobody
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["service", "health"]
CMD ["service"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
