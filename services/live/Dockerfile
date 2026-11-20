# The live server: Centrifugo with Caller Whale's own settings (config.json) and the shared Runtime Logs table.
# Build with this folder as the context:
#   docker build -t callerwhale-live services/live
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM centrifugo/centrifugo:v6.10.3
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Live server"
COPY services/live/config.json /centrifugo/config.json
EXPOSE 8000
USER centrifugo
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -q -O /dev/null http://localhost:8000/health || exit 1
ENTRYPOINT ["/usr/local/bin/callerwhale-log","centrifugo","--config=/centrifugo/config.json"]
