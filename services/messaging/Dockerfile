# messaging (plan: docs/plans/messaging-sms-voice.md). Build with this folder as the context:
#   docker build -t callerwhale-messaging services/messaging
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM golang:1 AS build
WORKDIR /repo/services/messaging
COPY packages/go /repo/packages/go
COPY services/messaging/go.mod services/messaging/go.sum ./
RUN go mod download
COPY services/messaging/*.go ./
COPY services/messaging/migrations ./migrations
# The database tests need a PostgreSQL and are skipped here; they run in .github/workflows/check-backend.yml.
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Messaging"
COPY --from=build /out/service /service
ENV PORT=8108
EXPOSE 8108
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=6 CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
