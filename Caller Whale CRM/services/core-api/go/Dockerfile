# The CRM server's background worker (jobs, rules, outbox). Build with this folder as the context:
#   docker build -t callerwhale-core-api-worker services/core-api/go
# Any number of copies: they share the work through the database and Redis.
FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -o /out/worker ./cmd/callerwhale-worker

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Core API worker"
COPY --from=build /out/worker /worker
# The health endpoint listens on all interfaces so the platform can probe it.
ENV CALLERWHALE_WORKER_BIND=0.0.0.0:8090
EXPOSE 8090
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["/worker", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/worker"]
