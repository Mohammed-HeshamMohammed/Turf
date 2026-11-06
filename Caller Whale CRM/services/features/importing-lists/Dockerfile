FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM python:3.13-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Importing lists"
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py worker.py readers.py matching.py ./
ENV PORT=8111
# The folder shared with crm-core, where upload pieces wait: one persistent volume mounted at the same path in both applications.
# The user id matches crm-core's (distroless "nonroot"), so both can write to it.
ENV IMPORT_DIR=/data/imports
EXPOSE 8111
USER 65532:65532
CMD ["python", "server.py"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
ENV PYTHONUNBUFFERED=1
