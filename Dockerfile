# syntax=docker/dockerfile:1.6

# ---------- build stage ----------
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ---------- runtime stage ----------
FROM node:20-slim
WORKDIR /app

# Claude Code CLI must be on PATH inside the container so the
# server can spawn it. Auth tokens come from a mounted volume.
RUN npm install -g @anthropic-ai/claude-code

# Production-only deps (smaller image, faster install)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Built JS + shipped configs
COPY --from=build /app/dist ./dist
COPY configs ./configs

# Mount points exist so volume binds don't create root-owned dirs
RUN mkdir -p logs data /scratch

EXPOSE 3000

CMD ["node", "dist/bin.js", "--config", "configs/docker.json"]
