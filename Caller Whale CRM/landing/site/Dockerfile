# Build context: the repository root (npm workspaces, D383); Dockerfile.dockerignore beside this file sends only what the
# image needs. The auth service's address is fixed at build time (it is also in the content security policy);
# the build stops without it, so a site that would send people to localhost is never made.
FROM golang:1 AS runtime-log-build
COPY ["Caller Whale CRM/landing/site/runtime-log/main.go", "/src/main.go"]
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY packages/ packages/
# npm checks the lock file against every workspace, so the CRM app's package.json comes too (only the website's packages install).
COPY ["Caller Whale CRM/desktop/frontend/react/package.json", "Caller Whale CRM/desktop/frontend/react/"]
COPY ["Caller Whale CRM/landing/site/package.json", "Caller Whale CRM/landing/site/"]
RUN npm ci --workspace "Caller Whale CRM/landing/site"
COPY ["Caller Whale CRM/landing/site/", "Caller Whale CRM/landing/site/"]
WORKDIR "/repo/Caller Whale CRM/landing/site"
ARG VITE_CALLERWHALE_AUTH_URL
ENV VITE_CALLERWHALE_AUTH_URL=$VITE_CALLERWHALE_AUTH_URL
ARG VITE_CALLERWHALE_GATEWAY_URL=https://gate.callerwhale.com
ENV VITE_CALLERWHALE_GATEWAY_URL=$VITE_CALLERWHALE_GATEWAY_URL
ARG VITE_CALLERWHALE_ASSISTANT_URL=https://assistant.callerwhale.com
ENV VITE_CALLERWHALE_ASSISTANT_URL=$VITE_CALLERWHALE_ASSISTANT_URL
RUN mkdir -p /out && npm test && npm run build && node scripts/security-headers.mjs /out/security-headers.conf dist && cp -r dist /out/dist

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Landing"
COPY ["Caller Whale CRM/landing/site/nginx.conf", "/etc/nginx/conf.d/default.conf"]
COPY --from=build /out/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /out/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/callerwhale-log", "/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
