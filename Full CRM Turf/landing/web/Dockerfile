# The landing site's frontend: built once, served as static files. Build with this folder as the context:
#   docker build -t turf-landing-web landing/web
# Any number of copies: there is nothing in it to keep in step.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
