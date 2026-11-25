# StreamBot

StreamBot is a web console and Telegram bot for extracting media from supported
social platforms. It can send media to Telegram or let you test and download
streams from the browser. The app also includes a platform support matrix and
an exportable Python (aiogram v3) bot bundle.

## Features

- Telegram bot that accepts media links in chats and streams the results to
  Telegram.
- Browser-based stream tester for previewing and downloading extracted media.
- Instagram, TikTok, Twitter/X, Reddit, Tumblr, YouTube, YouTube Shorts, and
  YouTube Music support. TikTok, YouTube, YouTube Shorts, and Instagram video
  links also include extracted MP3 audio.
- Telegram bot controls for the bot token, API endpoint, concurrency, YouTube
  quality, video/music/both delivery mode, compression, proxy, and cookie settings.
- Live telemetry, a platform matrix, and generated Python bot source.
- Admin sign-in protecting the Telegram bot panel and all `/api/bot/*`
  endpoints.

Media is processed with streaming and FFmpeg pipelines. Audio-only streams are
sent in their source format when available; the service does not buffer whole
media files in RAM. YouTube metadata extraction enables yt-dlp's Node.js
JavaScript runtime. The standalone yt-dlp binary is downloaded automatically
if it is not already available.

## Requirements

- Node.js 22.19 or newer and npm.
- FFmpeg for local runs. The Docker image installs it for you.
- A Telegram bot token from [@BotFather](https://t.me/BotFather) to run the
  Telegram bot. The web stream tester can be used without one.

## Configure

Create a `.env` file in the project root using `.env.example` as a reference.
If you already have a `.env`, edit it rather than replacing it. Set unique
admin credentials before exposing the app:

```dotenv
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="replace-with-a-long-random-password"
TELEGRAM_BOT_TOKEN=""
TELEGRAM_API_ROOT="https://api.telegram.org"
BOT_CONCURRENCY="8"
PORT="3000"
```

`TELEGRAM_BOT_TOKEN` is optional if you plan to configure the token in the
signed-in bot panel. If it is set when the server starts, the bot starts
automatically. Keep `.env` private; do not commit credentials or tokens.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ADMIN_USERNAME` | Yes for bot panel access | — | Admin sign-in username. |
| `ADMIN_PASSWORD` | Yes for bot panel access | — | Admin sign-in password. Choose a long, unique value. |
| `TELEGRAM_BOT_TOKEN` | Only to run the bot | — | Token from @BotFather. If set, the server attempts to start the bot on launch. |
| `TELEGRAM_API_ROOT` | No | `https://api.telegram.org` | Telegram Bot API endpoint. Use a self-hosted Bot API server for the larger upload limit. |
| `BOT_CONCURRENCY` | No | `8` | Maximum number of concurrent bot media jobs (1–32). |
| `MAX_EXTRACT_CONCURRENCY` | No | `3` | Maximum simultaneous web extraction jobs (1–16). |
| `MAX_STREAM_CONCURRENCY` | No | `6` | Maximum simultaneous browser media streams (1–32). |
| `TRUST_PROXY_HOPS` | No | `0` | Number of trusted reverse-proxy hops. Set only when deployed behind a proxy you control. |
| `PORT` | No | `3000` | Host port for the web app. Docker Compose maps this host port to container port 3000. |

## Run locally

Install dependencies and start the development server:

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Select **Telegram Bot**
and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` to manage the bot.

### Run in Termux on Android

Termux uses Android's Bionic libc, so the standalone Linux yt-dlp ELF binary is
not compatible even on an `aarch64` phone. Install the Termux-native Python
package and its YouTube JavaScript support instead:

```bash
pkg update && pkg upgrade
pkg install nodejs-lts python-yt-dlp yt-dlp-ejs ffmpeg
npm ci
npm run dev
```

The app detects Termux and runs `$PREFIX/bin/yt-dlp` directly. Do not copy the
`yt-dlp_linux_aarch64` glibc binary into `bin/` on Android.

For a production-mode local run:

```bash
npm ci
npm run build
npm start
```

## Run with Docker Compose

After creating and configuring `.env`, build and start the app:

```bash
docker compose up --build -d
```

Open the port configured by `PORT` (3000 by default). To view logs or stop the
app:

```bash
docker compose logs -f streambot
docker compose down
```

The image installs FFmpeg, downloads yt-dlp, builds the frontend, and runs the
server. Docker Compose reads environment values from the project-root `.env`
file.

### Larger Telegram uploads

The standard Telegram Bot API has a 50 MB upload limit. For uploads up to
2000 MB, configure a self-hosted
[Telegram Bot API server](https://github.com/tdlib/telegram-bot-api):

1. Obtain `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from
   [my.telegram.org](https://my.telegram.org).
2. Uncomment the optional `telegram-bot-api` service in `docker-compose.yml`.
3. Add those credentials to `.env` and set
   `TELEGRAM_API_ROOT="http://telegram-bot-api:8081"`.
4. Restart with `docker compose up --build -d`.

## Using the app

### Stream tester

Paste a supported link into **Stream Tester** to extract and preview available
media. Use the result actions to stream or download it. YouTube quality can be
selected, and proxy/cookie values can be supplied for supported sources.

### Telegram bot

Sign in to the **Telegram Bot** panel, enter a token (unless already set in the
environment), and start the bot. Send a supported link to the bot in Telegram.
Use **Media to Send from Every Source** to choose video, music, or both. The
default is both, matching the prior behavior.
The bot also supports:

- `/start` — usage information.
- `/help` — supported platforms and the active upload limit.
- `/options` — toggle video and sound independently with inline checkboxes for this chat.
- `/quality` — select a preferred YouTube quality (360p, 720p, or 1080p).

### Python source export

Open **Python Export** to browse the generated aiogram v3 source or download it
as a ZIP bundle.

## Admin access and deployment security

- The bot panel and `/api/bot/*` API require admin credentials. If either admin
  variable is missing, login is disabled and the bot panel remains locked.
- Admin sessions use an HttpOnly, SameSite cookie, expire after 12 hours, and
  are stored in memory. Restarting the server invalidates all sessions.
- Login attempts are limited after repeated failures.
- Authentication is specifically for bot administration. The stream tester,
  telemetry, platform matrix, and Python source export are still public when
  the app is reachable. Do not expose the service publicly unless those
  features are appropriate for your deployment.
- Use HTTPS for any deployment beyond a trusted local network. If TLS
  terminates at a reverse proxy, configure it to forward the original HTTPS
  protocol.
- Put public deployments behind a CDN/WAF or reverse proxy with connection,
  body-size, and request-rate controls. The app adds per-IP API limits and
  bounded worker queues, but in-process limits cannot stop volumetric DDoS or
  coordinate limits across multiple replicas. When using a trusted proxy, set
  `TRUST_PROXY_HOPS` to its exact hop count; do not trust arbitrary forwarded
  headers.
- Docker Compose caps the container at 768 MiB, 2 CPUs, and 128 processes, and
  Node.js is limited to a 512 MiB heap. Adjust these together with media-job
  concurrency for the host's available resources.
- Keep admin credentials and the Telegram token out of source control and
  logs. Anyone with access to the bot panel can control the bot.

The health endpoint is available at `/api/health`.

## Development checks

```bash
npm run lint
npm run build
```
