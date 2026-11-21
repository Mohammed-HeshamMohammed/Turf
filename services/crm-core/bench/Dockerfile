# A throwaway speed test of crm-core's merges, run as a temporary Coolify app so the numbers are the server's own (never production's
# database: it starts its own PostgreSQL 17 inside this container, fills it with made-up leads and calls, and prints the timings).
# Build with the repository root as the context:
#   docker build -f services/crm-core/bench/Dockerfile .
FROM golang:1 AS build
WORKDIR /repo/services/crm-core
COPY packages/go /repo/packages/go
COPY services/crm-core/go.mod services/crm-core/go.sum ./
RUN go mod download
COPY services/crm-core/*.go ./
COPY services/crm-core/migrations ./migrations
RUN CGO_ENABLED=0 go test -c -o /out/crm-core.test .

FROM postgres:17
COPY --from=build /out/crm-core.test /bench/crm-core.test
COPY services/crm-core/bench/run.sh /bench/run.sh
RUN chmod +x /bench/run.sh
ENV MERGE_SCALE=100000 CALL_SCALE=30000 EXISTING_LEADS=200000 EXPLAIN_MS=2000
ENTRYPOINT ["/bench/run.sh"]
