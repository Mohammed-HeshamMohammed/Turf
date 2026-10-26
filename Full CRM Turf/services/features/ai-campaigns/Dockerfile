FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8116
EXPOSE 8116
USER node
CMD ["node", "src/server.ts"]
