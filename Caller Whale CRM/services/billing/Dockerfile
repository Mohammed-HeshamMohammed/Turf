FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8103
EXPOSE 8103
USER node
CMD ["node", "src/server.ts"]
