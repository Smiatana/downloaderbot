export interface ExportedFile {
  path: string;
  language: 'python' | 'text' | 'dockerfile' | 'markdown';
  description: string;
  content: string;
}

export function getPythonBotFiles(): ExportedFile[] {
  return [
    {
      path: 'requirements.txt',
      language: 'text',
      description: 'Async Python dependencies (aiogram v3, aiohttp, yt-dlp, pydantic-settings)',
      content: `aiogram>=3.13.1
aiohttp>=3.10.10
yt-dlp>=2024.10.22
pydantic-settings>=2.6.0
`,
    },
    {
      path: '.env.example',
      language: 'text',
      description: 'Only TELEGRAM_BOT_TOKEN is required; all other fields have safe defaults',
      content: `# REQUIRED: Get this from @BotFather on Telegram
TELEGRAM_BOT_TOKEN=

# OPTIONAL: Leave default unless running your own Local Bot API server
TELEGRAM_API_BASE=https://api.telegram.org
MAX_CONCURRENT_JOBS=10
DEFAULT_YT_QUALITY=720
PROXY_URL=
COOKIES_HEADER=
`,
    },
    {
      path: 'config.py',
      language: 'python',
      description: 'Typed runtime configuration with 50 MB / 2 GB Telegram limit detection',
      content: `from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    telegram_bot_token: str
    telegram_api_base: str = "https://api.telegram.org"
    max_concurrent_jobs: int = 10
    default_yt_quality: int = 720
    proxy_url: str = ""
    cookies_header: str = ""

    @property
    def max_upload_bytes(self) -> int:
        # Local Telegram Bot API server supports up to 2000 MB uploads
        if self.telegram_api_base.rstrip("/") != "https://api.telegram.org":
            return 2000 * 1024 * 1024
        return 50 * 1024 * 1024

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
`,
    },
    {
      path: 'url_router.py',
      language: 'python',
      description: 'Domain router, URL sanitizer, and SSRF / command-injection guard',
      content: `import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse

Platform = Literal[
    "instagram",
    "tiktok",
    "twitter",
    "reddit",
    "tumblr",
    "youtube",
    "youtube_shorts",
]

URL_REGEX = re.compile(r"https?://[^\\s<>\\\"'\\)\\]]+", re.IGNORECASE)
UNSAFE_CHARS = re.compile(r"[\\x00-\\x1f\\x7f]")
PRIVATE_HOST_RE = re.compile(
    r"^(localhost|127\\.\\d+\\.\\d+\\.\\d+|10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(1[6-9]|2\\d|3[0-1])\\.\\d+\\.\\d+|0\\.0\\.0\\.0|::1)$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ParsedUrl:
    platform: Platform
    url: str


def detect_platform(raw_url: str) -> ParsedUrl | None:
    if not raw_url or len(raw_url) > 2048 or UNSAFE_CHARS.search(raw_url):
        return None
    parsed = urlparse(raw_url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    host = parsed.hostname.lower().removeprefix("www.")
    if PRIVATE_HOST_RE.match(host) or host.endswith((".local", ".internal")):
        return None

    if (host == "youtube.com" or host.endswith(".youtube.com")) and parsed.path.startswith("/shorts/"):
        return ParsedUrl("youtube_shorts", raw_url)
    if host in ("youtube.com", "youtu.be") or host.endswith(".youtube.com"):
        return ParsedUrl("youtube", raw_url)
    if host in ("instagram.com", "instagr.am") or host.endswith((".instagram.com", ".instagr.am")):
        return ParsedUrl("instagram", raw_url)
    if host == "tiktok.com" or host.endswith(".tiktok.com"):
        return ParsedUrl("tiktok", raw_url)
    if host in ("twitter.com", "x.com", "fxtwitter.com", "vxtwitter.com") or host.endswith((".twitter.com", ".x.com")):
        return ParsedUrl("twitter", raw_url)
    if host in ("reddit.com", "redd.it", "v.redd.it", "i.redd.it") or host.endswith(".reddit.com"):
        return ParsedUrl("reddit", raw_url)
    if host == "tumblr.com" or host.endswith(".tumblr.com"):
        return ParsedUrl("tumblr", raw_url)
    return None


def extract_urls_from_text(text: str) -> list[ParsedUrl]:
    if not text:
        return []
    seen: set[str] = set()
    out: list[ParsedUrl] = []
    for raw in URL_REGEX.findall(text):
        cleaned = raw.rstrip(".,!?;:")
        detected = detect_platform(cleaned)
        if detected and detected.url not in seen:
            seen.add(detected.url)
            out.append(detected)
    return out
`,
    },
    {
      path: 'streamer.py',
      language: 'python',
      description: 'Zero-disk aiogram InputFile implementations streaming HTTP & FFmpeg pipe:1 directly',
      content: `import asyncio
from typing import AsyncGenerator
import aiohttp
from aiogram import Bot
from aiogram.types import InputFile

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
}


class HttpStreamInputFile(InputFile):
    """Streams an upstream HTTP response straight into Telegram multipart upload without touching disk."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        url: str,
        filename: str,
        headers: dict[str, str] | None = None,
        chunk_size: int = 128 * 1024,
    ):
        super().__init__(filename=filename, chunk_size=chunk_size)
        self._session = session
        self._url = url
        self._headers = {**DEFAULT_HEADERS, **(headers or {})}

    async def read(self, bot: Bot) -> AsyncGenerator[bytes, None]:
        async with self._session.get(self._url, headers=self._headers) as resp:
            resp.raise_for_status()
            async for chunk in resp.content.iter_chunked(self.chunk_size):
                if chunk:
                    yield chunk


class SubprocessPipeInputFile(InputFile):
    """Streams stdout from FFmpeg (pipe:1) directly to Telegram with zero local temp files."""

    def __init__(
        self,
        cmd: list[str],
        filename: str,
        chunk_size: int = 64 * 1024,
    ):
        super().__init__(filename=filename, chunk_size=chunk_size)
        self._cmd = cmd

    async def read(self, bot: Bot) -> AsyncGenerator[bytes, None]:
        proc = await asyncio.create_subprocess_exec(
            *self._cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdout is not None
        try:
            while True:
                chunk = await proc.stdout.read(self.chunk_size)
                if not chunk:
                    break
                yield chunk
            rc = await proc.wait()
            if rc != 0:
                stderr = await proc.stderr.read() if proc.stderr else b""
                raise RuntimeError(f"FFmpeg stream failed ({rc}): {stderr.decode(errors='ignore')[:200]}")
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()


def build_ffmpeg_mp3_pipe_cmd(source_url: str) -> list[str]:
    """Extracts TikTok audio on-the-fly directly to MP3 stdout (zero disk storage)."""
    return [
        "ffmpeg",
        "-loglevel",
        "error",
        "-user_agent",
        DEFAULT_HEADERS["User-Agent"],
        "-i",
        source_url,
        "-vn",
        "-acodec",
        "libmp3lame",
        "-q:a",
        "2",
        "-f",
        "mp3",
        "pipe:1",
    ]


def build_ffmpeg_dash_mux_cmd(video_url: str, audio_url: str) -> list[str]:
    """Muxes Reddit/YouTube separate DASH video+audio into fragmented MP4 stdout."""
    return [
        "ffmpeg",
        "-loglevel",
        "error",
        "-user_agent",
        DEFAULT_HEADERS["User-Agent"],
        "-i",
        video_url,
        "-user_agent",
        DEFAULT_HEADERS["User-Agent"],
        "-i",
        audio_url,
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "pipe:1",
    ]
`,
    },
    {
      path: 'extractor.py',
      language: 'python',
      description: 'Async yt-dlp metadata extractor running in threadpool without writing files',
      content: `import asyncio
from dataclasses import dataclass
from typing import Literal
import yt_dlp
from config import settings
from url_router import ParsedUrl

MediaKind = Literal["video", "photo", "animation", "audio"]


@dataclass
class ExtractedAsset:
    kind: MediaKind
    stream_url: str
    filename: str
    title: str
    author: str | None = None
    audio_url: str | None = None
    width: int | None = None
    height: int | None = None
    duration: int | None = None
    filesize: int | None = None
    headers: dict[str, str] | None = None
    strategy: Literal["http", "ffmpeg_dash", "ffmpeg_mp3"] = "http"


def _sanitize_name(title: str, ext: str) -> str:
    safe = "".join(c if c.isalnum() or c in "._- " else "" for c in title).strip().replace(" ", "_")
    return f"{(safe or 'media')[:60]}.{ext}"


def _extract_sync(parsed: ParsedUrl, yt_quality: int) -> list[ExtractedAsset]:
    ydl_opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": parsed.platform in ("youtube", "youtube_shorts"),
    }
    if settings.proxy_url:
        ydl_opts["proxy"] = settings.proxy_url
    if settings.cookies_header:
        ydl_opts["http_headers"] = {"Cookie": settings.cookies_header}

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(parsed.url, download=False)

    entries = info.get("entries") if info.get("_type") == "playlist" else [info]
    assets: list[ExtractedAsset] = []

    for idx, entry in enumerate(entries or []):
        if not entry:
            continue
        title = entry.get("title") or f"{parsed.platform}_media"
        author = entry.get("uploader") or entry.get("channel")
        formats = entry.get("formats") or []
        ext = (entry.get("ext") or "mp4").lower()
        suffix = f"_{idx + 1}" if len(entries) > 1 else ""

        if ext in ("jpg", "jpeg", "png", "webp") and entry.get("url"):
            assets.append(
                ExtractedAsset(
                    kind="photo",
                    stream_url=entry["url"],
                    filename=_sanitize_name(f"{title}{suffix}", "jpg"),
                    title=title,
                    author=author,
                    width=entry.get("width"),
                    height=entry.get("height"),
                    headers=entry.get("http_headers"),
                )
            )
            continue

        # Prefer progressive MP4 for zero-overhead direct streaming
        progressive = sorted(
            [
                f
                for f in formats
                if f.get("url")
                and f.get("ext") == "mp4"
                and f.get("vcodec") != "none"
                and f.get("acodec") != "none"
                and "m3u8" not in (f.get("protocol") or "")
            ],
            key=lambda f: f.get("height") or 0,
            reverse=True,
        )

        chosen = next((f for f in progressive if (f.get("height") or 0) <= yt_quality), None) or (
            progressive[0] if progressive else None
        )

        if chosen:
            assets.append(
                ExtractedAsset(
                    kind="animation" if ext == "gif" else "video",
                    stream_url=chosen["url"],
                    filename=_sanitize_name(f"{title}{suffix}", "mp4"),
                    title=title,
                    author=author,
                    width=chosen.get("width"),
                    height=chosen.get("height"),
                    duration=entry.get("duration"),
                    filesize=chosen.get("filesize") or chosen.get("filesize_approx"),
                    headers=chosen.get("http_headers") or entry.get("http_headers"),
                )
            )
            continue

        # Separate DASH video + audio (Reddit / YouTube 1080p)
        v_only = sorted(
            [
                f
                for f in formats
                if f.get("url")
                and f.get("vcodec") != "none"
                and (not f.get("acodec") or f.get("acodec") == "none")
                and "m3u8" not in (f.get("protocol") or "")
            ],
            key=lambda f: f.get("height") or 0,
            reverse=True,
        )
        a_only = sorted(
            [
                f
                for f in formats
                if f.get("url")
                and f.get("acodec") != "none"
                and (not f.get("vcodec") or f.get("vcodec") == "none")
                and "m3u8" not in (f.get("protocol") or "")
            ],
            key=lambda f: f.get("tbr") or 0,
            reverse=True,
        )

        if v_only and a_only:
            v_pick = next((f for f in v_only if (f.get("height") or 0) <= yt_quality), v_only[0])
            a_pick = a_only[0]
            assets.append(
                ExtractedAsset(
                    kind="video",
                    stream_url=v_pick["url"],
                    audio_url=a_pick["url"],
                    filename=_sanitize_name(f"{title}{suffix}", "mp4"),
                    title=title,
                    author=author,
                    width=v_pick.get("width"),
                    height=v_pick.get("height"),
                    duration=entry.get("duration"),
                    strategy="ffmpeg_dash",
                )
            )
        elif entry.get("url"):
            assets.append(
                ExtractedAsset(
                    kind="video",
                    stream_url=entry["url"],
                    filename=_sanitize_name(f"{title}{suffix}", "mp4"),
                    title=title,
                    author=author,
                    duration=entry.get("duration"),
                    headers=entry.get("http_headers"),
                )
            )

    # TikTok requirement: append zero-disk MP3 audio extraction asset
    if parsed.platform == "tiktok":
        video_asset = next((a for a in assets if a.kind == "video"), None)
        if video_asset:
            assets.append(
                ExtractedAsset(
                    kind="audio",
                    stream_url=video_asset.stream_url,
                    filename=_sanitize_name(f"{video_asset.title}_audio", "mp3"),
                    title=f"{video_asset.title} (Audio)",
                    author=video_asset.author,
                    duration=video_asset.duration,
                    strategy="ffmpeg_mp3",
                )
            )

    return assets


async def extract_media_async(parsed: ParsedUrl, yt_quality: int = 720) -> list[ExtractedAsset]:
    return await asyncio.to_thread(_extract_sync, parsed, yt_quality)
`,
    },
    {
      path: 'bot.py',
      language: 'python',
      description: 'Main aiogram v3 async bot runner with semaphore concurrency & zero-disk streaming',
      content: `import asyncio
import logging
import aiohttp
from aiogram import Bot, Dispatcher, F
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.enums import ChatAction
from aiogram.filters import Command
from aiogram.types import InputMediaPhoto, InputMediaVideo, Message

from config import settings
from extractor import ExtractedAsset, extract_media_async
from streamer import (
    HttpStreamInputFile,
    SubprocessPipeInputFile,
    build_ffmpeg_dash_mux_cmd,
    build_ffmpeg_mp3_pipe_cmd,
)
from url_router import ParsedUrl, extract_urls_from_text

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("streambot")

semaphore = asyncio.Semaphore(settings.max_concurrent_jobs)
http_session: aiohttp.ClientSession | None = None


def to_input_file(asset: ExtractedAsset):
    assert http_session is not None
    if asset.strategy == "ffmpeg_mp3":
        return SubprocessPipeInputFile(
            build_ffmpeg_mp3_pipe_cmd(asset.stream_url),
            filename=asset.filename,
        )
    if asset.strategy == "ffmpeg_dash" and asset.audio_url:
        return SubprocessPipeInputFile(
            build_ffmpeg_dash_mux_cmd(asset.stream_url, asset.audio_url),
            filename=asset.filename,
        )
    return HttpStreamInputFile(
        http_session,
        asset.stream_url,
        filename=asset.filename,
        headers=asset.headers,
    )


async def handle_url(message: Message, parsed: ParsedUrl) -> None:
    async with semaphore:
        await message.bot.send_chat_action(message.chat.id, ChatAction.UPLOAD_VIDEO)
        try:
            assets = await extract_media_async(parsed, settings.default_yt_quality)
            if not assets:
                raise RuntimeError("No media extracted")

            visuals = [a for a in assets if a.kind != "audio"]
            audios = [a for a in assets if a.kind == "audio"]

            if len(visuals) > 1:
                for i in range(0, len(visuals), 10):
                    group = []
                    for item in visuals[i : i + 10]:
                        media = to_input_file(item)
                        if item.kind == "photo":
                            group.append(InputMediaPhoto(media=media))
                        else:
                            group.append(InputMediaVideo(media=media, supports_streaming=True))
                    await message.reply_media_group(group)
            elif len(visuals) == 1:
                item = visuals[0]
                if item.filesize and item.filesize > settings.max_upload_bytes:
                    await message.reply(
                        f"⚠️ File exceeds Telegram upload limit. Direct stream:\\n{item.stream_url}"
                    )
                else:
                    media = to_input_file(item)
                    if item.kind == "photo":
                        await message.reply_photo(media)
                    elif item.kind == "animation":
                        await message.reply_animation(media)
                    else:
                        await message.reply_video(media, supports_streaming=True)

            for audio in audios:
                await message.bot.send_chat_action(message.chat.id, ChatAction.RECORD_VOICE)
                await message.reply_audio(
                    to_input_file(audio),
                    title=audio.title,
                    performer=audio.author,
                )
        except Exception as exc:
            logger.exception("Failed handling %s: %s", parsed.url, exc)
            await message.reply(
                "❌ Sorry, I couldn't extract media from this link. It might be private or deleted."
            )


async def main() -> None:
    global http_session
    connector = aiohttp.TCPConnector(limit=64, ttl_dns_cache=300)
    http_session = aiohttp.ClientSession(connector=connector)

    api_server = TelegramAPIServer.from_base(settings.telegram_api_base)
    bot_session = AiohttpSession(api=api_server)
    bot = Bot(token=settings.telegram_bot_token, session=bot_session)
    dp = Dispatcher()

    @dp.message(Command("start", "help"))
    async def cmd_start(message: Message) -> None:
        await message.reply(
            "Send any link from Instagram, TikTok, Twitter/X, Reddit, Tumblr, YouTube, or YouTube Shorts.\\n"
            "All media streams directly in memory with zero local disk storage."
        )

    @dp.message(F.text | F.caption)
    async def on_message(message: Message) -> None:
        text = message.text or message.caption or ""
        urls = extract_urls_from_text(text)
        if not urls:
            return
        await asyncio.gather(*(handle_url(message, u) for u in urls))

    try:
        await dp.start_polling(bot)
    finally:
        await http_session.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
`,
    },
    {
      path: 'Dockerfile',
      language: 'dockerfile',
      description: 'Lightweight production container with Python 3.12 + FFmpeg (no temp disk needed)',
      content: `FROM python:3.12-slim

RUN apt-get update && \\
    apt-get install -y --no-install-recommends ffmpeg && \\
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
CMD ["python", "bot.py"]
`,
    },
    {
      path: 'docker-compose.yml',
      language: 'text',
      description: 'One-command Docker Compose launcher requiring only TELEGRAM_BOT_TOKEN in .env',
      content: `services:
  bot:
    build: .
    container_name: streambot-python
    restart: unless-stopped
    environment:
      TELEGRAM_BOT_TOKEN: "\${TELEGRAM_BOT_TOKEN}"
      TELEGRAM_API_BASE: "\${TELEGRAM_API_BASE:-https://api.telegram.org}"
      MAX_CONCURRENT_JOBS: "\${MAX_CONCURRENT_JOBS:-10}"
      DEFAULT_YT_QUALITY: "\${DEFAULT_YT_QUALITY:-720}"
      PROXY_URL: "\${PROXY_URL:-}"
      COOKIES_HEADER: "\${COOKIES_HEADER:-}"
`,
    },
  ];
}
