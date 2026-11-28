# app.callerwhale.com: the CRM, the same screens as the desktop app (apps/crm) built for the browser, which
# only works signed in. The build context is the repository root (npm workspaces, D383); Dockerfile.dockerignore beside
# this file sends only what the image needs. The auth service and the gateway are fixed at build time (they are also in the
# content security policy); the build stops without them, so an app that would talk to localhost is never made.
FROM golang:1 AS runtime-log-build
COPY packages/go/runtimelog /src
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log ./cmd/callerwhale-log

FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY packages/ packages/
# npm checks the lock file against every workspace, so the website's package.json comes too (only the CRM app's packages install).
COPY ["apps/website/package.json", "apps/website/"]
COPY ["apps/crm/package.json", "apps/crm/"]
RUN npm ci --workspace "apps/crm"
COPY ["apps/crm/", "apps/crm/"]
COPY ["apps/crm-web/scripts", "/headers"]
WORKDIR "/repo/apps/crm"
ARG VITE_CALLERWHALE_AUTH_URL
ARG VITE_CALLERWHALE_API_URL
# Where team chat is (the messaging service). Empty: the Inbox has no team chats.
ARG VITE_CALLERWHALE_MESSAGING_URL=
ARG VITE_CALLERWHALE_SITE_URL=https://callerwhale.com
# The next three come from the repository Actions variables CALLERWHALE_DIALER_URL, CALLERWHALE_REAL_CALL_NUMBERS and
# CALLERWHALE_REAL_CALL_FROM (tools/production.json); each may be left unset.
# Where the dialer is (services/telnyx through the gateway). Empty: calls stay demo calls.
ARG VITE_CALLERWHALE_DIALER_URL=
# Option B only: the team's own phones that may get a real call, comma separated, and the Trial account's caller ID. Empty: no real calls.
ARG VITE_CALLERWHALE_REAL_CALL_NUMBERS=
ARG VITE_CALLERWHALE_REAL_CALL_FROM=
ENV VITE_CALLERWHALE_AUTH_URL=$VITE_CALLERWHALE_AUTH_URL \
    VITE_CALLERWHALE_API_URL=$VITE_CALLERWHALE_API_URL \
    VITE_CALLERWHALE_MESSAGING_URL=$VITE_CALLERWHALE_MESSAGING_URL \
    VITE_CALLERWHALE_SITE_URL=$VITE_CALLERWHALE_SITE_URL \
    VITE_CALLERWHALE_DIALER_URL=$VITE_CALLERWHALE_DIALER_URL \
    VITE_CALLERWHALE_REAL_CALL_NUMBERS=$VITE_CALLERWHALE_REAL_CALL_NUMBERS \
    VITE_CALLERWHALE_REAL_CALL_FROM=$VITE_CALLERWHALE_REAL_CALL_FROM \
    VITE_CALLERWHALE_REQUIRE_SIGN_IN=true
RUN mkdir -p /out && node /headers/security-headers.mjs /out/security-headers.conf && npx tsc -p . && npx vite build && cp -r dist/client /out/client

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Dashboard"
COPY ["apps/crm-web/nginx.conf", "/etc/nginx/conf.d/default.conf"]
COPY --from=build /out/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /out/client /usr/share/nginx/html
# Use labelled startup checks; retain nginx warnings and errors.
COPY ["apps/crm-web/start.sh", "/usr/local/bin/callerwhale-start"]
RUN sed -i 's@^error_log .*@error_log /dev/stderr warn;@' /etc/nginx/nginx.conf
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/bin/sh","/usr/local/bin/callerwhale-start"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
