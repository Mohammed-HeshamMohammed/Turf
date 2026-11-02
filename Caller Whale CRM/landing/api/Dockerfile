# The landing site's backend (waitlist, contact messages, the latest download). Build with this folder as the context:
#   docker build -t callerwhale-landing-api landing/api
# It keeps its data in a SQLite file, so run ONE copy and give it a volume at /data.
FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM node:24-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Landing API"
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8095 CALLERWHALE_LANDING_DB=/data/landing.db
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 8095
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8095) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/server.mjs"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
