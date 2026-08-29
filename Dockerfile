# Setun application image. adapter-node output, executed by the Bun runtime (PRD §5).
FROM oven/bun:1.4-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun --bun run build

FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/build ./build
# The production entry installs the process guard before adapter-node listens.
COPY server.js server-guard.js ./

EXPOSE 3000
CMD ["bun", "./server.js"]
