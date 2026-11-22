# Authorization (plan: docs/history/plans/authorization-service.md). Build with this folder as the context:
#   docker build -t callerwhale-authz services/authz
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM golang:1 AS build
WORKDIR /repo/services/authz
COPY packages/go /repo/packages/go
COPY services/authz/go.mod services/authz/go.sum ./
RUN go mod download
COPY services/authz/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Authorization"
COPY --from=build /out/service /service
ENV PORT=8104
EXPOSE 8104
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
