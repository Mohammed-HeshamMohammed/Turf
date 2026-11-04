# Build context is landing/site. The auth service's address is fixed at build time.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_CALLERWHALE_AUTH_URL
ENV VITE_CALLERWHALE_AUTH_URL=$VITE_CALLERWHALE_AUTH_URL
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
