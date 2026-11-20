# Notifications. Build with this folder as the context:
#   docker build -t callerwhale-notifications services/notifications
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM golang:1 AS build
WORKDIR /repo/services/notifications
COPY packages/go /repo/packages/go
COPY services/notifications/go.mod ./
COPY services/notifications/*.go ./
RUN CGO_ENABLED=0 go build -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Notifications"
COPY --from=build /out/service /service
ENV PORT=8102
EXPOSE 8102
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
