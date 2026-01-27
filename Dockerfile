# syntax=docker/dockerfile:1

FROM node:24.13.0-alpine

RUN apk add --no-cache bash
RUN apk update

WORKDIR /app
COPY . .
RUN npm install pnpm -g
RUN pnpm install
RUN pnpm run lint
RUN pnpm run build
RUN chmod +x appStartUp.sh
CMD ./appStartUp.sh