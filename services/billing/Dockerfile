# Billing (plan: docs/history/plans/billing-service.md). Build with this folder as the context:
#   docker build -t callerwhale-billing services/billing
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM python:3.15-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Billing"
WORKDIR /app
COPY services/billing/requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
COPY services/billing/callerwhale_billing ./callerwhale_billing
COPY services/billing/database_setup ./database_setup
ENV PORT=8103
EXPOSE 8103
USER nobody
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["python", "-m", "callerwhale_billing", "health"]
CMD ["python", "-m", "callerwhale_billing"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
ENV PYTHONUNBUFFERED=1
