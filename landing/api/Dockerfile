# The landing site's backend (waitlist, contact messages, the latest download). Build with this folder as the context:
#   docker build -t callerwhale-landing-api landing/api
# It keeps its data in a SQLite file, so run ONE copy and give it a volume at /data.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8095 CALLERWHALE_LANDING_DB=/data/landing.db
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 8095
USER node
CMD ["node", "src/server.mjs"]
