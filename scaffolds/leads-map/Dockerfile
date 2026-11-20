# Build from scaffolds/ so the scaffolds' Cargo workspace is in context:
#   docker build -f leads-map/Dockerfile -t callerwhale-leads-map .
FROM golang:1 AS runtime-log-build
COPY leads-map/runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM rust:1 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY leads-map ./leads-map
COPY crm ./crm
COPY backup-restore ./backup-restore
RUN cargo build --release -p callerwhale-leads-map

FROM debian:bookworm-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Leads map"
COPY --from=build /src/target/release/callerwhale-leads-map /usr/local/bin/service
ENV PORT=8114
EXPOSE 8114
USER nobody
CMD ["service"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
