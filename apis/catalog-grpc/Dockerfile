# Image of the catalog example, a gRPC service: docker build -t ghcr.io/rudney5000/plugbricks/catalog-grpc:0.1.0 apis/catalog-grpc
# Same Node version as .node-version at the repository root.

FROM node:22.23.5-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.5-alpine
ENV NODE_ENV=production PORT=50051
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY proto/service.proto ./proto/service.proto
# Never root at run time. The brick's healthcheck runs dist/health.js: node is in the image, grpc_health_probe is not.
USER node
EXPOSE 50051
CMD ["node", "dist/main.js"]
