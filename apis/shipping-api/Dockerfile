# Image of the shipping example subgraph: docker build -t ghcr.io/rudney5000/plugbricks/shipping-api:0.1.0 apis/shipping-api
# Same Node version as .node-version at the repository root.

FROM node:22.23.5-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.5-alpine
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY schema.graphql ./
# Never root at run time. wget (busybox) stays available for the brick's healthcheck.
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
