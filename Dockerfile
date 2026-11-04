# Build context is landing/site. The auth service's address is fixed at build time (it is also in the content security policy);
# the build stops without it, so a site that would send people to localhost is never made.
FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_CALLERWHALE_AUTH_URL
ENV VITE_CALLERWHALE_AUTH_URL=$VITE_CALLERWHALE_AUTH_URL
ARG VITE_CALLERWHALE_GATEWAY_URL=https://gate.callerwhale.com
ENV VITE_CALLERWHALE_GATEWAY_URL=$VITE_CALLERWHALE_GATEWAY_URL
RUN npm test && node scripts/security-headers.mjs /app/security-headers.conf && npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Landing"
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/callerwhale-log", "/docker-entrypoint.sh"]
