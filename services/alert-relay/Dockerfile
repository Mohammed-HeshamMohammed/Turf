FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM golang:1 AS build
WORKDIR /repo/services/alert-relay
COPY packages/go /repo/packages/go
COPY services/alert-relay/go.mod ./
COPY services/alert-relay/*.go ./
RUN CGO_ENABLED=0 go build -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Alert relay"
COPY --from=build /out/service /service
ENV PORT=8121
EXPOSE 8121
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
