# Build from repository root. .dockerignore excludes all local credentials/data.
FROM oven/bun:1.4.4-slim AS build
WORKDIR /workspace/keychain
COPY keychain/package.json keychain/bun.lock ./
RUN bun install --frozen-lockfile && ln -s /workspace/keychain/node_modules /workspace/node_modules
COPY sdk/src /workspace/sdk/src
COPY keychain/src ./src
COPY keychain/scripts ./scripts
COPY keychain/prover ./prover
RUN bun scripts/prover-assets.ts --check && bun scripts/build-production.ts

FROM oven/bun:1.4.4-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5173
WORKDIR /app
COPY --from=build /workspace/keychain/dist ./dist
COPY --from=build /workspace/keychain/prover ./prover
COPY keychain/server.ts keychain/server-config.ts keychain/index.html keychain/style.css ./
COPY LICENSE ./LICENSE
# This image contains public code/assets only; private runtime files are separate mounts.
RUN chmod -R a+rX /app
USER bun
EXPOSE 5173
CMD ["bun", "run", "server.ts"]
