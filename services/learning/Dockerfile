# Learning store (plan: docs/plans/learning-store-compliance.md). Build with this folder as the context:
#   docker build -t callerwhale-learning services/learning
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM golang:1 AS build
WORKDIR /repo/services/learning
COPY packages/go /repo/packages/go
COPY services/learning/go.mod services/learning/go.sum ./
RUN go mod download
COPY services/learning/*.go ./
# The database test needs a PostgreSQL and is skipped here; run it with LEARNING_TEST_URL set where one is available.
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Learning"
COPY --from=build /out/service /service
ENV PORT=8112
EXPOSE 8112
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
