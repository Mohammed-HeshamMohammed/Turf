# crm-core. Build with the repository root as the context:
#   docker build -f services/crm-core/Dockerfile .
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM golang:1 AS build
WORKDIR /repo/services/crm-core
COPY packages/go /repo/packages/go
COPY services/crm-core/go.mod services/crm-core/go.sum ./
RUN go mod download
COPY services/crm-core/*.go ./
COPY services/crm-core/cmd ./cmd
COPY services/crm-core/migrations ./migrations
# The database tests need a PostgreSQL and are skipped here; run them with `go test` where one is available.
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service ./cmd/crm-core

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="CRM core"
COPY --from=build /out/service /service
ENV PORT=8107
EXPOSE 8107
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=6 CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
