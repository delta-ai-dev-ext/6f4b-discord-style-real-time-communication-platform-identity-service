FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY tests ./tests
RUN bun x tsc --noEmit

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY drizzle.config.ts ./
COPY drizzle ./drizzle
COPY tests ./tests
RUN addgroup --system --gid 1001 bunuser \
    && adduser --system --uid 1001 --ingroup bunuser bunuser \
    && chown -R bunuser:bunuser /app
USER bunuser
EXPOSE 8080
CMD ["bun", "--smol", "run", "src/index.ts"]
