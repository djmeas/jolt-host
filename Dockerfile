# Build stage: compile app and native deps (better-sqlite3)
FROM node:20-bookworm AS builder

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Nitro resolves static assets from server/chunks/ (relative to the bundle), not from .output/public.
# Copy public assets so the runtime finds them at .output/server/chunks/public/
RUN cp -r .output/public .output/server/chunks/public

# Production stage
FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000

# Copy built output and production node_modules (with compiled better-sqlite3)
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# App writes to ./data and ./storage (mount volumes in production)
EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
