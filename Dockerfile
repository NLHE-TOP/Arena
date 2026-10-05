# NLHE product-server image.
#
# This image contains only the product server. The PokerTools platform API,
# PostgreSQL, Redis and the custody worker are separate services and are never
# embedded or started here.
#
# @pokertools/{types,sdk} are installed from npm at exactly 2.0.3.
# Build the standalone product image:
#   docker build -t nlhe-product:0.3.0 .

FROM node:24-slim AS base
RUN npm install --global npm@12.2.0

FROM base AS build
WORKDIR /app
# better-sqlite3 may need a native build when no matching prebuild is available.
# Keep the compiler toolchain out of the final image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.web.json vite.config.ts vitest.config.ts ./
COPY src ./src
COPY web ./web
COPY tests ./tests
COPY migrations ./migrations
COPY scripts ./scripts
RUN npm test && npm run build && npm prune --omit=dev

FROM base
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATABASE_PATH=/data/product.sqlite CHALLENGE_ENABLED=0
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir /data && chown -R node:node /data /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
