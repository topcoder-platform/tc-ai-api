# syntax=docker/dockerfile:1
FROM node:26.12.1-alpine3.24 AS build
RUN apk upgrade --no-cache && npm install --global pnpm@11.15.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tools/minimatch-compat ./tools/minimatch-compat
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run test:dependency-compat && pnpm run lint && pnpm test && pnpm run build

FROM alpine:3.24
RUN apk upgrade --no-cache && apk add --no-cache 'nodejs-current~26' ca-certificates \
    && addgroup -S -g 10001 app && adduser -S -D -u 10001 -G app -h /home/app app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 \
    TMPDIR=/tmp TEMP=/tmp TMP=/tmp MASTRA_STUDIO_DISABLED=true MASTRA_TELEMETRY_DISABLED=true \
    WORKSPACE_PATH=/app/workspace
WORKDIR /app
COPY --from=build --chown=app:app /app/.mastra/output ./.mastra/output
COPY --from=build --chown=app:app /app/workspace ./workspace
USER app
EXPOSE 3000
CMD ["node", "/app/.mastra/output/index.mjs"]
