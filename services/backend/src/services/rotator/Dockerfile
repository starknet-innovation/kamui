# Built from backend/ as context:  docker compose build rotator
# Kamui: an exact version, not a floating tag. Pin the digest too when the image is built for production.
FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY deployments.env ./
COPY src ./src
# Workspace files can be0600; release source (never runtime secrets) must be readable by bun.
RUN chmod -R a+rX /app/src && chmod a+r /app/package.json /app/deployments.env
# Kamui: not root. `bun` is the image's unprivileged user.
USER bun
CMD ["bun", "run", "service:rotator"]
