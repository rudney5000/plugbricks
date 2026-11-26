# Image of the stock example, a REST API with no dependency: docker build -t ghcr.io/rudney5000/plugbricks/stock-rest:0.1.0 apis/stock-rest
# Same Node version as .node-version at the repository root.

FROM node:22.23.5-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json server.js main.js openapi.json ./
# Never root at run time. wget (busybox) stays available for the brick's healthcheck.
USER node
EXPOSE 8080
CMD ["node", "main.js"]
