# Stage 1: Build
FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies for native compilation (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY patches ./patches
RUN npm install

COPY . .
RUN npm run build

# Stage 2: Production
FROM node:22-slim

WORKDIR /app

# Install runtime dependencies, Chromium for headless SPA rendering, FFmpeg for animated stickers, & compile native addons
COPY package*.json ./
COPY patches ./patches
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    tzdata \
    chromium \
    fonts-liberation \
    ffmpeg \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove build-essential python3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY config ./config

# Create persistent storage directories
RUN mkdir -p storage/auth storage/temp assets

# Set environment variables
ENV NODE_ENV=production
ENV TZ=Asia/Jakarta
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "dist/index.js"]
