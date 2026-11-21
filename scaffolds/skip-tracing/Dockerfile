FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM python:3.15-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Skip tracing"
WORKDIR /app
COPY server.py ./
ENV PORT=8112
EXPOSE 8112
USER nobody
CMD ["python", "server.py"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
ENV PYTHONUNBUFFERED=1
