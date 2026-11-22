# The calls and texts service, every part in one program (cmd/dialer-sms) until the telnyx-phone-* and telnyx-sms-* split.
# Build from the repository root: docker build -f services/telnyx/Dockerfile .
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM golang:1 AS build
WORKDIR /repo/services/telnyx
COPY packages/go /repo/packages/go
COPY services/telnyx/go.mod services/telnyx/go.sum ./
RUN go mod download
COPY services/telnyx/*.go ./
COPY services/telnyx/cmd ./cmd
COPY services/telnyx/migrations ./migrations
# The database tests need a PostgreSQL and are skipped here; they run in .github/workflows/check-backend.yml.
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service ./cmd/dialer-sms

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Dialer SMS"
COPY --from=build /out/service /service
ENV PORT=8113
EXPOSE 8113
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=6 CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
