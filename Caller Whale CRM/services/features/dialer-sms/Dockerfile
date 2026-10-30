FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8113
EXPOSE 8113
USER node
CMD ["node", "src/server.ts"]
