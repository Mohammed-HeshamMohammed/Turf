# Assistant (the helper chat on the website). Build with this folder as the context:
#   docker build -t callerwhale-assistant services/assistant
FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM golang:1 AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
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
