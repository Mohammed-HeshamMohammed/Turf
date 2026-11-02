FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# Use labelled startup checks; retain nginx warnings and errors.
COPY start.sh /usr/local/bin/callerwhale-start
RUN sed -i 's@^error_log .*@error_log /dev/stderr warn;@' /etc/nginx/nginx.conf
ENTRYPOINT ["/bin/sh", "/usr/local/bin/callerwhale-start"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
