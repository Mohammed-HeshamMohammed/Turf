# The CRM server's background worker (jobs, rules, outbox). Build with this folder as the context:
#   docker build -t turf-core-api-worker services/core-api/go
# Any number of copies: they share the work through the database and Redis.
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -o /out/worker ./cmd/turf-worker

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/worker /worker
# The health endpoint listens on all interfaces so the platform can probe it.
ENV CALLERWHALE_WORKER_BIND=0.0.0.0:8090
EXPOSE 8090
USER nonroot
ENTRYPOINT ["/worker"]
