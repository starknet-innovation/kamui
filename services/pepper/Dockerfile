# Kamui pepper service. Built from services/pepper/ as context:
#   docker build --platform linux/amd64 -t kamui-pepper:<tag> services/pepper
#
# The image holds no key and no configuration: the key stays in AWS KMS and every setting
# arrives as an environment variable (see .env.example). No .env file is copied in, so Bun's
# automatic .env loading finds nothing.

# Stage 1: production dependencies only, exactly as locked.
FROM oven/bun:1.4.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Stage 2: the runtime image. Same pinned base, source and dependencies, nothing else.
FROM oven/bun:1.4.4-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# The base image ships an unprivileged user `bun` (uid 1000).
USER bun
EXPOSE 8787
CMD ["bun", "run", "src/index.ts"]
