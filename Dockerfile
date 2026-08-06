# syntax=docker/dockerfile:1

FROM node:24.13.0-alpine

RUN apk add --no-cache bash git

WORKDIR /app

# Use the exact pnpm version pinned in package.json "packageManager"
RUN corepack enable

# Copy lockfile + manifest first for layer caching
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Now copy the rest of the source
COPY . .
RUN pnpm run lint
RUN pnpm test
RUN pnpm run build
RUN chmod +x appStartUp.sh
CMD ["./appStartUp.sh"]