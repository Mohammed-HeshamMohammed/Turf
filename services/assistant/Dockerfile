# Assistant (the helper chat on the website). Build with this folder as the context:
#   docker build -t callerwhale-assistant services/assistant
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM golang:1 AS build
WORKDIR /repo/services/assistant
COPY packages/go /repo/packages/go
COPY services/assistant/go.mod ./
COPY services/assistant/*.go ./
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Assistant"
COPY --from=build /out/service /service
ENV PORT=8109
EXPOSE 8109
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
