FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM python:3.15-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Importing lists"
WORKDIR /app
COPY services/importing-lists/requirements.txt services/importing-lists/requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY services/importing-lists/server.py services/importing-lists/upload_api.py ./
RUN python -c "import server"
# The persistent upload folder belongs to the app user.
RUN mkdir -p /data/imports && chown -R 65532:65532 /data
ENV PORT=8111
# Mount this service's own persistent volume here: the uploads as they arrive. The importing worker has a volume of its own.
ENV IMPORT_DIR=/data/imports
EXPOSE 8111
USER 65532:65532
# The image has no curl or wget, so it checks itself; in Coolify turn its own Health Check off and this one is used.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8111/healthz', timeout=3)"]
CMD ["python", "server.py"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
ENV PYTHONUNBUFFERED=1
