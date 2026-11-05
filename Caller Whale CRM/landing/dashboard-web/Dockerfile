# app.callerwhale.com: the CRM, the same screens as the desktop app (desktop/frontend/react) built for the browser, which
# only works signed in. The build context is the production branch root, which holds landing/dashboard-web and
# desktop/frontend/react at their paths. The auth service and the gateway are fixed at build time (they are also in the
# content security policy); the build stops without them, so an app that would talk to localhost is never made.
FROM golang:1 AS runtime-log-build
COPY landing/dashboard-web/runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM node:24-alpine AS build
WORKDIR /app
COPY desktop/frontend/react/package.json desktop/frontend/react/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY desktop/frontend/react/ ./
COPY landing/dashboard-web/scripts /headers
ARG VITE_CALLERWHALE_AUTH_URL
ARG VITE_CALLERWHALE_API_URL
ARG VITE_CALLERWHALE_SITE_URL=https://callerwhale.com
ENV VITE_CALLERWHALE_AUTH_URL=$VITE_CALLERWHALE_AUTH_URL \
    VITE_CALLERWHALE_API_URL=$VITE_CALLERWHALE_API_URL \
    VITE_CALLERWHALE_SITE_URL=$VITE_CALLERWHALE_SITE_URL \
    VITE_CALLERWHALE_REQUIRE_SIGN_IN=true
RUN node /headers/security-headers.mjs /app/security-headers.conf && npx tsc -p . && npx vite build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Dashboard"
COPY landing/dashboard-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist/client /usr/share/nginx/html
# Use labelled startup checks; retain nginx warnings and errors.
COPY landing/dashboard-web/start.sh /usr/local/bin/callerwhale-start
RUN sed -i 's@^error_log .*@error_log /dev/stderr warn;@' /etc/nginx/nginx.conf
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/bin/sh","/usr/local/bin/callerwhale-start"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
