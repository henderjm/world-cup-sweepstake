FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
ENV NODE_ENV=production
COPY package.json release.json ./
COPY src ./src
COPY services/scores ./services/scores
USER node
STOPSIGNAL SIGTERM
CMD ["node", "services/scores/run-collector.mjs"]
