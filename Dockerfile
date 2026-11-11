# The Bulkhead agent on an ordinary host (testnet fallback, docs/superpowers/plans/2026-11-11-testnet-fallback-launch.md).
# Secrets come from the host's env at run time, never from the image.
FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production
USER bun
ENV NODE_ENV=production
EXPOSE 8787
CMD ["bun", "agent/src/main.ts"]
