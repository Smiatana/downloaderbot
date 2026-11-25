FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    amd64) yt_dlp_asset=yt-dlp_linux ;; \
    arm64) yt_dlp_asset=yt-dlp_linux_aarch64 ;; \
    *) echo "Unsupported architecture for standalone yt-dlp: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  mkdir -p /app/bin; \
  curl -fsSL -o /app/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$yt_dlp_asset"; \
  chmod 755 /app/bin/yt-dlp

RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.ts"]
