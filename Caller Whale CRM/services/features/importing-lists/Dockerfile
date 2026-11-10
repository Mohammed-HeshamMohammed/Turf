FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM python:3.13-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Importing lists"
WORKDIR /app
COPY requirements.txt requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY server.py upload_api.py worker.py readers.py matching.py readymode.py linetype.py ./
RUN python -c "import worker"
# The worker's own persistent upload folder belongs to its app user.
RUN mkdir -p /data/imports && chown -R 65532:65532 /data
ENV PORT=8111
# Mount one persistent volume here on the worker only.
ENV IMPORT_DIR=/data/imports
EXPOSE 8111
USER 65532:65532
# The image has no curl or wget, so it checks itself; in Coolify turn its own Health Check off and this one is used.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8111/healthz', timeout=3)"]
CMD ["python", "server.py"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
ENV PYTHONUNBUFFERED=1
