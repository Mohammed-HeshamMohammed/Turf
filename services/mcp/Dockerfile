# MCP (plan: docs/plans/ai-connectors.md). Build with this folder as the context:
#   docker build -t callerwhale-mcp services/mcp
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM golang:1 AS build
WORKDIR /repo/services/mcp
COPY packages/go /repo/packages/go
COPY services/mcp/go.mod ./
COPY services/mcp/*.go ./
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="MCP"
COPY --from=build /out/service /service
ENV PORT=8106
EXPOSE 8106
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
