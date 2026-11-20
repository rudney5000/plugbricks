# Image of the orders-web example: docker build -t plugbricks-example/orders-web:0.1.0 apis/orders-web
# Same Node version as .node-version at the repository root. No runtime dependency: node:http and fetch.

FROM node:22.23.5-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.5-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
# package.json only for "type": "module"; there is nothing to install.
COPY package.json ./
COPY --from=build /app/dist ./dist
# Never root at run time. wget (busybox) stays available for the brick's healthcheck.
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
