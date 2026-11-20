# dialer-sms (plan: docs/plans/messaging-sms-voice.md). Build with this folder as the context:
#   docker build -t callerwhale-dialer-sms services/features/dialer-sms
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM golang:1 AS build
WORKDIR /repo/services/dialer-sms
COPY packages/go /repo/packages/go
COPY services/dialer-sms/go.mod services/dialer-sms/go.sum ./
RUN go mod download
COPY services/dialer-sms/*.go ./
COPY services/dialer-sms/migrations ./migrations
# The database tests need a PostgreSQL and are skipped here; they run in .github/workflows/check-backend.yml.
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Dialer SMS"
COPY --from=build /out/service /service
ENV PORT=8113
EXPOSE 8113
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=6 CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
