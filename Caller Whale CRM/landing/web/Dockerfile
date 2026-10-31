# The landing site's frontend: built once, served as static files. Build with this folder as the context:
#   docker build -t callerwhale-landing-web landing/web
# Any number of copies: there is nothing in it to keep in step.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Read by the build: SITE_URL turns on canonical links and sitemap.xml (scripts/prerender.mjs); VITE_CALLERWHALE_API_URL is
# Caller Whale's server (the core API), where people sign in and the dashboards get their data. Coolify passes its build-time
# settings as build arguments.
ARG SITE_URL="https://callerwhale.com"
ARG VITE_CALLERWHALE_API_URL="https://app.callerwhale.com"
# The landing API (waitlist and contact) has its own address, not a path on the site.
ARG VITE_CALLERWHALE_LANDING_API_URL="https://appapi.callerwhale.com"
RUN SITE_URL="$SITE_URL" VITE_CALLERWHALE_API_URL="$VITE_CALLERWHALE_API_URL" VITE_CALLERWHALE_LANDING_API_URL="$VITE_CALLERWHALE_LANDING_API_URL" npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
# The image fills the template in when it starts: the auth service's origin, and Caller Whale's server's origin for
# the content security policy. Override them in the container's environment.
ENV AUTH_ORIGIN="https://auth.callerwhale.com" API_ORIGIN="https://app.callerwhale.com" APPAPI_ORIGIN="https://appapi.callerwhale.com" GRAFANA_ORIGIN="https://app.callerwhale.com" NGINX_ENVSUBST_FILTER="^(AUTH_ORIGIN|API_ORIGIN|APPAPI_ORIGIN|GRAFANA_ORIGIN)$"
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
