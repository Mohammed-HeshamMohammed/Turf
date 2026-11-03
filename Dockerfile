# The landing site's frontend: built once, served as static files. Build with this folder as the context:
#   docker build -t callerwhale-landing-web landing/web
# Any number of copies: there is nothing in it to keep in step.
FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Read by the build: SITE_URL turns on canonical links and sitemap.xml (scripts/prerender.mjs); VITE_CALLERWHALE_API_URL is
# Caller Whale's server (the core API), where people sign in and the dashboards get their data. Coolify passes its build-time
# settings as build arguments.
# No address is written in this file: every one comes from the environment (env/landing-web.production.example).
ARG SITE_URL
ARG VITE_CALLERWHALE_API_URL
RUN SITE_URL="$SITE_URL" VITE_CALLERWHALE_API_URL="$VITE_CALLERWHALE_API_URL" npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Website"
# The image fills the template in when it starts, from the container's environment (AUTH_ORIGIN, API_ORIGIN,
# GRAFANA_ORIGIN: the origins the content security policy allows). None has a default here.
ENV NGINX_ENVSUBST_FILTER="^(AUTH_ORIGIN|API_ORIGIN|GRAFANA_ORIGIN)$"
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
# Use labelled startup checks; retain nginx warnings and errors.
COPY start.sh /usr/local/bin/callerwhale-start
RUN sed -i 's@^error_log .*@error_log /dev/stderr warn;@' /etc/nginx/nginx.conf
ENTRYPOINT ["/usr/local/bin/callerwhale-log","/bin/sh","/usr/local/bin/callerwhale-start"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
