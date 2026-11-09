# crm-core (plan: docs/plans/crm-core-and-imports.md). Build with this folder as the context:
#   docker build -t callerwhale-crm-core services/crm-core
FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM golang:1 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY migrations ./migrations
# The database tests need a PostgreSQL and are skipped here; run them with `go test` where one is available.
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="CRM core"
COPY --from=build /out/service /service
ENV PORT=8107
EXPOSE 8107
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
