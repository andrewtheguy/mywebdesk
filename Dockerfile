# Build stage
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build frontend assets
RUN bun run build

# Runtime stage
FROM oven/bun:1.3-alpine AS runner

RUN mkdir -p /home/bun/app && chown -R bun:bun /home/bun
WORKDIR /home/bun/app

# Copy package files
COPY --chown=bun:bun package.json bun.lock ./

# Install production dependencies only
USER bun
RUN bun install --frozen-lockfile --production

# Copy runtime assets
COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --from=builder --chown=bun:bun /app/server ./server

ENV NODE_ENV=production
EXPOSE 18890

CMD ["bun", "server/index.ts"]

# Runtime stage using a pre-built frontend bundle supplied via the build context
# (dist/). CI builds the arch-independent `vite build` output once and injects it
# here, so the Vite build doesn't re-run per architecture. For local builds use the
# default `runner` target, which builds dist/ itself.
FROM oven/bun:1.3-alpine AS runtime-prebuilt

RUN mkdir -p /home/bun/app && chown -R bun:bun /home/bun
WORKDIR /home/bun/app

# Copy package files
COPY --chown=bun:bun package.json bun.lock ./

# Install production dependencies only
USER bun
RUN bun install --frozen-lockfile --production

# Copy runtime assets (dist/ comes from the build context, pre-built by CI)
COPY --chown=bun:bun dist ./dist
COPY --chown=bun:bun server ./server

ENV NODE_ENV=production
EXPOSE 18890

CMD ["bun", "server/index.ts"]
