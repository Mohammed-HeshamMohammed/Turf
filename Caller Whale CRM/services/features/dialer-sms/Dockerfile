FROM golang:1 AS runtime-log-build
COPY runtime-log/main.go /src/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go

FROM node:26-slim
COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log
ENV CALLERWHALE_LOG_SERVICE="Dialer SMS"
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8113
EXPOSE 8113
USER node
CMD ["node", "src/server.ts"]

ENTRYPOINT ["/usr/local/bin/callerwhale-log"]
