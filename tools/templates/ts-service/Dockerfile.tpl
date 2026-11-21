FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=__PORT__
EXPOSE __PORT__
USER node
CMD ["node", "src/server.ts"]
