# The landing site's frontend: built once, served as static files. Build with this folder as the context:
#   docker build -t turf-landing-web landing/web
# Any number of copies: there is nothing in it to keep in step.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Read by the build: SITE_URL turns on canonical links and sitemap.xml (scripts/prerender.mjs); VITE_TURF_API_URL is
# Turf's server (the core API), where people sign in and the dashboards get their data. Coolify passes its build-time
# settings as build arguments.
ARG SITE_URL=""
ARG VITE_TURF_API_URL="https://app.callerwhale.com"
RUN SITE_URL="$SITE_URL" VITE_TURF_API_URL="$VITE_TURF_API_URL" npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
# The image fills the template in when it starts: the Firebase project's sign-in host, and Turf's server's origin for
# the content security policy. Override them in the container's environment.
ENV FIREBASE_AUTH_HOST="project-34ff1df6-b240-40d4-be2.firebaseapp.com" API_ORIGIN="https://app.callerwhale.com" NGINX_ENVSUBST_FILTER="^(FIREBASE_AUTH_HOST|API_ORIGIN)$"
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
