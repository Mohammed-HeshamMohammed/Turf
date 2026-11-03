# Auth, in Go (plan: docs/plans/go-auth.md). Build with this folder as the context:
#   docker build -t callerwhale-auth-go services/auth-go
FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY database_setup ./database_setup
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service .

FROM gcr.io/distroless/static-debian12
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Auth"
COPY --from=build /out/service /service
ENV PORT=8101
EXPOSE 8101
USER nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["/service", "health"]
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/service"]
