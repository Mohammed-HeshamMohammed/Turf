FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM python:3.15-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Importing worker"
WORKDIR /app
COPY services/importing-worker/requirements.txt services/importing-worker/requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY services/importing-worker/server.py services/importing-worker/worker.py services/importing-worker/readers.py services/importing-worker/matching.py services/importing-worker/readymode.py services/importing-worker/linetype.py ./
RUN python -c "import worker"
# The worker's own persistent folder (the uploads it has fetched, kept IMPORT_KEEP_FILE_DAYS) belongs to its app user.
RUN mkdir -p /data/imports && chown -R 65532:65532 /data
ENV PORT=8119
# Mount the worker's own persistent volume here (not the upload service's).
ENV IMPORT_DIR=/data/imports
EXPOSE 8119
USER 65532:65532
# The image has no curl or wget, so it checks itself; in Coolify turn its own Health Check off and this one is used.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8119/healthz', timeout=3)"]
CMD ["python", "server.py"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
ENV PYTHONUNBUFFERED=1
