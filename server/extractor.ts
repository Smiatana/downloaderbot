import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Agent, fetch as undiciFetch } from 'undici';
import type {
  ExtractionOptions,
  ExtractionResult,
  MediaAsset,
  MediaKind,
  ParsedMediaUrl,
  PlatformId,
  YouTubeQuality,
} from './types.ts';

const execFileAsync = promisify(execFile);

const DEFAULT_LIMIT_BYTES = 50 * 1024 * 1024;
const BIN_DIR = path.resolve(process.cwd(), 'bin');
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');
const TMP_BIN_DIR = path.join(os.tmpdir(), 'streambot-bin');
const TMP_YTDLP_PATH = path.join(TMP_BIN_DIR, 'yt-dlp');
const MIN_YTDLP_STANDALONE_BYTES = 15_000_000;
const YTDLP_RELEASE_URL =
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

const metadataHttpAgent = new Agent({
  connections: 32,
  keepAliveTimeout: 20_000,
  connectTimeout: 10_000,
});

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let ytDlpEnsurePromise: Promise<string> | null = null;

function isValidExecutableYtDlp(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < MIN_YTDLP_STANDALONE_BYTES) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureYtDlpBinary(): Promise<string> {
  if (isValidExecutableYtDlp(YTDLP_PATH)) {
    return YTDLP_PATH;
  }
  // Attempt chmod if standalone binary exists in /app/bin without +x
  try {
    const stat = fs.statSync(YTDLP_PATH);
    if (stat.isFile() && stat.size >= MIN_YTDLP_STANDALONE_BYTES) {
      await chmod(YTDLP_PATH, 0o755);
      if (isValidExecutableYtDlp(YTDLP_PATH)) return YTDLP_PATH;
    }
  } catch {
    // Ignore and check tmpdir or download
  }

  if (isValidExecutableYtDlp(TMP_YTDLP_PATH)) {
    return TMP_YTDLP_PATH;
  }

  if (!ytDlpEnsurePromise) {
    ytDlpEnsurePromise = (async () => {
      const res = await undiciFetch(YTDLP_RELEASE_URL, {
        dispatcher: metadataHttpAgent,
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new Error(`Failed to bootstrap yt-dlp binary (${res.status})`);
      }
      const buf = Buffer.from(await res.arrayBuffer());

      // Try project bin/ first; if EACCES/EPERM (e.g. root-owned folder), use os.tmpdir()
      for (const [dir, target] of [
        [BIN_DIR, YTDLP_PATH],
        [TMP_BIN_DIR, TMP_YTDLP_PATH],
      ] as const) {
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(target, buf, { mode: 0o755 });
          await chmod(target, 0o755);
          if (isValidExecutableYtDlp(target)) {
            return target;
          }
        } catch {
          // Try next writable directory
        }
      }
      throw new Error('Could not write executable yt-dlp binary to disk.');
    })().finally(() => {
      ytDlpEnsurePromise = null;
    });
  }
  return ytDlpEnsurePromise;
}

function sanitizeFilename(rawTitle: string, ext: string): string {
  const cleaned = rawTitle
    .replace(/[^\p{L}\p{N}\s._-]/gu, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 64);
  const base = cleaned || `media_${Date.now()}`;
  return `${base}.${ext.replace(/^\./, '')}`;
}

async function probeContentLength(
  url: string,
  headers?: Record<string, string>
): Promise<number | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await undiciFetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': USER_AGENT,
        ...headers,
      },
      dispatcher: metadataHttpAgent,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const len = res.headers.get('content-length');
    if (len) {
      const parsed = Number(len);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // Ignore HEAD probe failures
  }
  return undefined;
}

interface YtDlpFormat {
  format_id?: string;
  url?: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  filesize?: number;
  filesize_approx?: number;
  tbr?: number;
  protocol?: string;
  cookies?: string;
  http_headers?: Record<string, string>;
}

interface YtDlpEntry {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  creator?: string;
  webpage_url?: string;
  url?: string;
  ext?: string;
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
  filesize?: number;
  filesize_approx?: number;
  vcodec?: string;
  acodec?: string;
  cookies?: string;
  http_headers?: Record<string, string>;
  formats?: YtDlpFormat[];
  entries?: YtDlpEntry[];
  _type?: string;
}

const COOKIE_ATTR_NAMES = new Set([
  'domain',
  'path',
  'expires',
  'max-age',
  'secure',
  'httponly',
  'samesite',
  'priority',
  'partitioned',
]);

function mergeCookieHeader(
  baseHeaders?: Record<string, string>,
  rawCookies?: string
): Record<string, string> | undefined {
  if (!rawCookies) return baseHeaders;
  const pairs: string[] = [];
  for (const part of rawCookies.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || COOKIE_ATTR_NAMES.has(name.toLowerCase())) continue;
    const val = part.slice(eq + 1).trim();
    pairs.push(`${name}=${val}`);
  }
  if (pairs.length === 0) return baseHeaders;
  return {
    ...(baseHeaders ?? {}),
    Cookie: pairs.join('; '),
  };
}

function isProgressiveMp4(fmt: YtDlpFormat): boolean {
  return (
    Boolean(fmt.url) &&
    fmt.ext === 'mp4' &&
    fmt.vcodec !== 'none' &&
    fmt.acodec !== 'none' &&
    !fmt.protocol?.includes('m3u8')
  );
}

function pickFormatsForEntry(
  entry: YtDlpEntry,
  _platform: PlatformId,
  quality: YouTubeQuality,
  maxLimitBytes: number
): {
  streamUrl: string;
  audioStreamUrl?: string;
  ext: string;
  kind: MediaKind;
  strategy: 'direct_http' | 'ffmpeg_mux_dash';
  width?: number;
  height?: number;
  estimatedBytes?: number;
  headers?: Record<string, string>;
  resolutionLabel?: string;
} | null {
  const formats = Array.isArray(entry.formats) ? entry.formats : [];
  const targetHeight = Number(quality);

  const imageExts = new Set(['jpg', 'jpeg', 'png', 'webp']);
  if (entry.url && entry.ext && imageExts.has(entry.ext.toLowerCase())) {
    return {
      streamUrl: entry.url,
      ext: entry.ext.toLowerCase() === 'jpeg' ? 'jpg' : entry.ext.toLowerCase(),
      kind: 'photo',
      strategy: 'direct_http',
      width: entry.width,
      height: entry.height,
      estimatedBytes: entry.filesize ?? entry.filesize_approx,
      headers: mergeCookieHeader(entry.http_headers, entry.cookies),
    };
  }

  if (entry.ext === 'gif' && entry.url) {
    return {
      streamUrl: entry.url,
      ext: 'gif',
      kind: 'animation',
      strategy: 'direct_http',
      width: entry.width,
      height: entry.height,
      estimatedBytes: entry.filesize ?? entry.filesize_approx,
      headers: mergeCookieHeader(entry.http_headers, entry.cookies),
    };
  }

  // Prefer H.264 (avc1/h264) progressive MP4 for maximum Telegram inline playback compatibility
  const progressive = formats
    .filter(isProgressiveMp4)
    .sort((a, b) => {
      const aH264 = /^(avc|h264)/i.test(a.vcodec || '') ? 1 : 0;
      const bH264 = /^(avc|h264)/i.test(b.vcodec || '') ? 1 : 0;
      if (aH264 !== bH264) return bH264 - aH264;
      return (b.height ?? 0) - (a.height ?? 0);
    });

  if (progressive.length > 0) {
    const fittingHeight = progressive.filter(
      (f) => (f.height ?? 0) <= targetHeight
    );
    const chosen =
      fittingHeight.find((f) => {
        const size = f.filesize ?? f.filesize_approx;
        return !size || size <= maxLimitBytes;
      }) ??
      fittingHeight[0] ??
      progressive[0];

    if (chosen?.url) {
      return {
        streamUrl: chosen.url,
        ext: 'mp4',
        kind: 'video',
        strategy: 'direct_http',
        width: chosen.width ?? entry.width,
        height: chosen.height ?? entry.height,
        estimatedBytes: chosen.filesize ?? chosen.filesize_approx,
        headers: mergeCookieHeader(
          chosen.http_headers ?? entry.http_headers,
          chosen.cookies ?? entry.cookies
        ),
        resolutionLabel: chosen.height ? `${chosen.height}p` : undefined,
      };
    }
  }

  // Separate video + audio DASH streams (Reddit v.redd.it, YouTube 1080p)
  const videoOnly = formats
    .filter(
      (f) =>
        Boolean(f.url) &&
        f.vcodec &&
        f.vcodec !== 'none' &&
        (!f.acodec || f.acodec === 'none') &&
        !f.protocol?.includes('m3u8')
    )
    .sort((a, b) => {
      const aMp4 = a.ext === 'mp4' ? 1 : 0;
      const bMp4 = b.ext === 'mp4' ? 1 : 0;
      if (aMp4 !== bMp4) return bMp4 - aMp4;
      return (b.height ?? 0) - (a.height ?? 0);
    });

  const audioOnly = formats
    .filter(
      (f) =>
        Boolean(f.url) &&
        f.acodec &&
        f.acodec !== 'none' &&
        (!f.vcodec || f.vcodec === 'none') &&
        !f.protocol?.includes('m3u8')
    )
    .sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0));

  if (videoOnly.length > 0 && audioOnly.length > 0) {
    const vMatch =
      videoOnly.find((f) => (f.height ?? 0) <= targetHeight) ?? videoOnly[0];
    const aMatch =
      audioOnly.find((f) => f.ext === 'm4a') ?? audioOnly[0];

    if (vMatch?.url && aMatch?.url) {
      const vSize = vMatch.filesize ?? vMatch.filesize_approx ?? 0;
      const aSize = aMatch.filesize ?? aMatch.filesize_approx ?? 0;
      return {
        streamUrl: vMatch.url,
        audioStreamUrl: aMatch.url,
        ext: 'mp4',
        kind: 'video',
        strategy: 'ffmpeg_mux_dash',
        width: vMatch.width ?? entry.width,
        height: vMatch.height ?? entry.height,
        estimatedBytes: vSize + aSize > 0 ? vSize + aSize : undefined,
        headers: vMatch.http_headers ?? entry.http_headers,
        resolutionLabel: vMatch.height ? `${vMatch.height}p` : undefined,
      };
    }
  }

  // Fallback to entry top-level direct URL (TikTok / Instagram / Tumblr single stream)
  if (entry.url && !entry.url.includes('.m3u8')) {
    const ext = entry.ext ?? 'mp4';
    const kind: MediaKind =
      ext === 'gif'
        ? 'animation'
        : imageExts.has(ext.toLowerCase())
          ? 'photo'
          : 'video';
    return {
      streamUrl: entry.url,
      ext,
      kind,
      strategy: 'direct_http',
      width: entry.width,
      height: entry.height,
      estimatedBytes: entry.filesize ?? entry.filesize_approx,
      headers: entry.http_headers,
      resolutionLabel: entry.height ? `${entry.height}p` : undefined,
    };
  }

  // Last resort: any HTTP video format
  const anyHttpVideo = formats.find(
    (f) => Boolean(f.url) && f.url!.startsWith('http') && !f.protocol?.includes('m3u8')
  );
  if (anyHttpVideo?.url) {
    return {
      streamUrl: anyHttpVideo.url,
      ext: anyHttpVideo.ext ?? 'mp4',
      kind: 'video',
      strategy: 'direct_http',
      width: anyHttpVideo.width ?? entry.width,
      height: anyHttpVideo.height ?? entry.height,
      estimatedBytes: anyHttpVideo.filesize ?? anyHttpVideo.filesize_approx,
      headers: anyHttpVideo.http_headers ?? entry.http_headers,
      resolutionLabel: anyHttpVideo.height ? `${anyHttpVideo.height}p` : undefined,
    };
  }

  return null;
}

async function extractWithYtDlp(
  parsedUrl: ParsedMediaUrl,
  options: ExtractionOptions
): Promise<ExtractionResult> {
  const start = Date.now();
  const maxLimitBytes = options.maxLimitBytes ?? DEFAULT_LIMIT_BYTES;
  const quality = options.youtubeQuality ?? '720';
  const ytDlpBin = await ensureYtDlpBinary();

  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-check-certificates',
    '--skip-download',
    '--user-agent',
    USER_AGENT,
  ];

  if (options.proxyUrl?.trim()) {
    args.push('--proxy', options.proxyUrl.trim());
  }
  if (options.cookiesHeader?.trim()) {
    args.push('--add-header', `Cookie:${options.cookiesHeader.trim()}`);
  }
  if (
    parsedUrl.platform === 'youtube' ||
    parsedUrl.platform === 'youtube_shorts'
  ) {
    args.push('--no-playlist');
  }

  args.push(parsedUrl.normalizedUrl);

  const { stdout } = await execFileAsync(ytDlpBin, args, {
    shell: false,
    timeout: 28_000,
    maxBuffer: 20 * 1024 * 1024,
  });

  const payload = JSON.parse(stdout) as YtDlpEntry;
  const entries =
    payload._type === 'playlist' && Array.isArray(payload.entries)
      ? payload.entries
      : [payload];

  const assets: MediaAsset[] = [];
  const warnings: string[] = [];
  const title = payload.title || entries[0]?.title || `${parsedUrl.platform} media`;
  const author =
    payload.uploader ||
    payload.channel ||
    payload.creator ||
    entries[0]?.uploader;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const picked = pickFormatsForEntry(
      entry,
      parsedUrl.platform,
      quality,
      maxLimitBytes
    );
    if (!picked) continue;

    let estimatedBytes = picked.estimatedBytes;
    if (!estimatedBytes && picked.strategy === 'direct_http') {
      estimatedBytes = await probeContentLength(picked.streamUrl, picked.headers);
    }

    const exceedsLimit =
      typeof estimatedBytes === 'number' && estimatedBytes > maxLimitBytes;

    const itemTitle = entry.title || title;
    const suffix = entries.length > 1 ? `_${i + 1}` : '';

    assets.push({
      id: randomUUID(),
      kind: picked.kind,
      title: itemTitle,
      author,
      platform: parsedUrl.platform,
      sourceUrl: parsedUrl.normalizedUrl,
      streamUrl: picked.streamUrl,
      audioStreamUrl: picked.audioStreamUrl,
      thumbnailUrl: entry.thumbnail ?? payload.thumbnail,
      filename: sanitizeFilename(`${itemTitle}${suffix}`, picked.ext),
      mimeType:
        picked.kind === 'photo'
          ? `image/${picked.ext === 'jpg' ? 'jpeg' : picked.ext}`
          : picked.kind === 'animation'
            ? 'image/gif'
            : 'video/mp4',
      ext: picked.ext,
      width: picked.width,
      height: picked.height,
      durationSeconds: entry.duration,
      estimatedBytes,
      exceedsLimit,
      limitBytes: maxLimitBytes,
      strategy: picked.strategy,
      headers: picked.headers,
      resolutionLabel: picked.resolutionLabel,
    });
  }

  // TikTok special requirement: extract and send MP3 audio alongside video/slideshow
  if (parsedUrl.platform === 'tiktok') {
    const audioOnlyFormat = (payload.formats ?? []).find(
      (f) =>
        Boolean(f.url) &&
        f.acodec &&
        f.acodec !== 'none' &&
        (!f.vcodec || f.vcodec === 'none')
    );

    const videoSource = assets.find((a) => a.kind === 'video');
    const audioUpstream = audioOnlyFormat?.url ?? videoSource?.streamUrl;

    if (audioUpstream) {
      assets.push({
        id: randomUUID(),
        kind: 'audio',
        title: `${title} (Audio)`,
        author,
        platform: 'tiktok',
        sourceUrl: parsedUrl.normalizedUrl,
        streamUrl: audioUpstream,
        thumbnailUrl: payload.thumbnail,
        filename: sanitizeFilename(`${title}_audio`, 'mp3'),
        mimeType: 'audio/mpeg',
        ext: 'mp3',
        durationSeconds: payload.duration,
        estimatedBytes: undefined,
        exceedsLimit: false,
        limitBytes: maxLimitBytes,
        strategy: 'ffmpeg_extract_mp3',
        headers: audioOnlyFormat?.http_headers ?? videoSource?.headers,
      });
    }
  }

  if (assets.length === 0) {
    throw new Error('No downloadable media streams were found in extractor output.');
  }

  return {
    platform: parsedUrl.platform,
    sourceUrl: parsedUrl.normalizedUrl,
    title,
    author,
    extractorUsed: 'yt-dlp',
    extractionMs: Date.now() - start,
    isCarousel: assets.filter((a) => a.kind !== 'audio').length > 1,
    hasSeparateAudio: assets.some((a) => a.kind === 'audio'),
    assets,
    warnings,
  };
}

// Fast Fallback 1: Twitter / X via FxTwitter JSON API (handles multi-photo, GIF, video)
async function extractTwitterFallback(
  parsedUrl: ParsedMediaUrl,
  maxLimitBytes: number
): Promise<ExtractionResult> {
  const start = Date.now();
  const u = new URL(parsedUrl.normalizedUrl);
  const match = u.pathname.match(/\/([^/]+)\/status\/(\d+)/);
  if (!match) {
    throw new Error('Could not parse Twitter/X status ID.');
  }
  const [, handle, statusId] = match;
  const apiUrl = `https://api.fxtwitter.com/${handle}/status/${statusId}`;
  const res = await undiciFetch(apiUrl, {
    headers: { 'User-Agent': USER_AGENT },
    dispatcher: metadataHttpAgent,
  });
  if (!res.ok) {
    throw new Error(`FxTwitter fallback failed (${res.status})`);
  }
  const data = (await res.json()) as {
    tweet?: {
      text?: string;
      author?: { name?: string; screen_name?: string };
      media?: {
        all?: Array<{
          type: 'photo' | 'video' | 'gif';
          url: string;
          thumbnail_url?: string;
          width?: number;
          height?: number;
          duration?: number;
        }>;
      };
    };
  };

  const mediaList = data.tweet?.media?.all ?? [];
  if (mediaList.length === 0) {
    throw new Error('No media attachments found on tweet.');
  }

  const title = (data.tweet?.text || `Tweet ${statusId}`).slice(0, 80);
  const author = data.tweet?.author?.screen_name
    ? `@${data.tweet.author.screen_name}`
    : data.tweet?.author?.name;

  const assets: MediaAsset[] = await Promise.all(
    mediaList.map(async (item, idx) => {
      const kind: MediaKind =
        item.type === 'photo'
          ? 'photo'
          : item.type === 'gif'
            ? 'animation'
            : 'video';
      const ext = kind === 'photo' ? 'jpg' : 'mp4';
      const estimatedBytes = await probeContentLength(item.url);
      return {
        id: randomUUID(),
        kind,
        title,
        author,
        platform: 'twitter',
        sourceUrl: parsedUrl.normalizedUrl,
        streamUrl: item.url,
        thumbnailUrl: item.thumbnail_url ?? (kind === 'photo' ? item.url : undefined),
        filename: sanitizeFilename(`x_${statusId}_${idx + 1}`, ext),
        mimeType: kind === 'photo' ? 'image/jpeg' : 'video/mp4',
        ext,
        width: item.width,
        height: item.height,
        durationSeconds: item.duration,
        estimatedBytes,
        exceedsLimit:
          typeof estimatedBytes === 'number' && estimatedBytes > maxLimitBytes,
        limitBytes: maxLimitBytes,
        strategy: 'direct_http',
        resolutionLabel: item.height ? `${item.height}p` : undefined,
      };
    })
  );

  return {
    platform: 'twitter',
    sourceUrl: parsedUrl.normalizedUrl,
    title,
    author,
    extractorUsed: 'fxtwitter-json',
    extractionMs: Date.now() - start,
    isCarousel: assets.length > 1,
    hasSeparateAudio: false,
    assets,
    warnings: [],
  };
}

// Fast Fallback 2: Reddit JSON API (handles DASH video+audio muxing, galleries, GIFs, images)
async function extractRedditFallback(
  parsedUrl: ParsedMediaUrl,
  maxLimitBytes: number
): Promise<ExtractionResult> {
  const start = Date.now();
  let targetUrl = parsedUrl.normalizedUrl;

  // Resolve redd.it and /r/.../s/... share shortlinks to canonical /comments/... URL
  if (
    parsedUrl.hostname === 'redd.it' ||
    /\/s\/[A-Za-z0-9]+/i.test(targetUrl)
  ) {
    try {
      const resolveRes = await undiciFetch(targetUrl, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
        dispatcher: metadataHttpAgent,
      });
      if (resolveRes.url) {
        targetUrl = resolveRes.url;
      }
    } catch {
      // Continue with original URL if redirect resolution fails
    }
  }

  const parsedTarget = new URL(targetUrl);
  parsedTarget.search = '';
  const clean = parsedTarget.toString().replace(/\/$/, '');
  const jsonUrl = clean.endsWith('.json') ? clean : `${clean}.json?raw_json=1`;

  let res = await undiciFetch(jsonUrl, {
    headers: {
      'User-Agent': 'linux:streambot:v1.0 (by /u/streambot)',
      Accept: 'application/json',
    },
    redirect: 'follow',
    dispatcher: metadataHttpAgent,
  });

  if (!res.ok) {
    const oldUrl = jsonUrl.replace('://www.reddit.com', '://old.reddit.com');
    res = await undiciFetch(oldUrl, {
      headers: {
        'User-Agent': 'linux:streambot:v1.0 (by /u/streambot)',
        Accept: 'application/json',
      },
      redirect: 'follow',
      dispatcher: metadataHttpAgent,
    });
  }

  if (!res.ok) {
    // Cloud IP fallback A: RapidSave (extracts both video_url and audio_url from Reddit)
    try {
      const rapidUrl = `https://rapidsave.com/info?url=${encodeURIComponent(targetUrl)}`;
      const rapidRes = await undiciFetch(rapidUrl, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
        dispatcher: metadataHttpAgent,
      });
      if (rapidRes.ok) {
        const html = await rapidRes.text();
        const dlMatch = html.match(/href="(https:\/\/[^"]*rapidsave\.com\/download\.php\?[^"]+)"/i);
        if (dlMatch?.[1]) {
          const dlUrl = new URL(dlMatch[1].replace(/&amp;/g, '&'));
          const videoUrl = dlUrl.searchParams.get('video_url');
          const rawAudio = dlUrl.searchParams.get('audio_url');
          const audioUrl =
            rawAudio && rawAudio !== 'false' && rawAudio.startsWith('http')
              ? rawAudio
              : undefined;
          const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
          const title = titleMatch?.[1]?.replace(/ - RapidSave.*/i, '').trim() || 'Reddit Video';

          if (videoUrl && videoUrl.startsWith('http')) {
            const vSize = await probeContentLength(videoUrl);
            return {
              platform: 'reddit',
              sourceUrl: parsedUrl.normalizedUrl,
              title,
              extractorUsed: 'rapidsave-async',
              extractionMs: Date.now() - start,
              isCarousel: false,
              hasSeparateAudio: false,
              assets: [
                {
                  id: randomUUID(),
                  kind: 'video',
                  title,
                  platform: 'reddit',
                  sourceUrl: parsedUrl.normalizedUrl,
                  streamUrl: videoUrl,
                  audioStreamUrl: audioUrl,
                  filename: sanitizeFilename(title, 'mp4'),
                  mimeType: 'video/mp4',
                  ext: 'mp4',
                  estimatedBytes: vSize,
                  exceedsLimit: typeof vSize === 'number' && vSize > maxLimitBytes,
                  limitBytes: maxLimitBytes,
                  strategy: audioUrl ? 'ffmpeg_mux_dash' : 'direct_http',
                },
              ],
              warnings: [],
            };
          }
        }
      }
    } catch {
      // Fall through to vxReddit fallback
    }

    // Cloud IP fallback B: vxReddit OpenGraph + v.redd.it DASH audio probing
    const vxUrl = `https://vxreddit.com${parsedTarget.pathname}`;
    const vxRes = await undiciFetch(vxUrl, {
      headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' },
      redirect: 'follow',
      dispatcher: metadataHttpAgent,
    });
    if (vxRes.ok) {
      const html = await vxRes.text();
      const decodeHtml = (s: string) => s.replace(/&amp;/g, '&');
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
      const rawTitle = titleMatch?.[1] ? decodeHtml(titleMatch[1]) : 'Reddit Media';
      const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
      const isErrorPage =
        rawTitle === 'vxReddit' &&
        descMatch?.[1]?.includes('Failed to get data from Reddit');

      if (!isErrorPage) {
        const vxAssets: MediaAsset[] = [];
        const seen = new Set<string>();

        for (const m of html.matchAll(/<meta property="og:video(?::secure_url)?" content="([^"]+)"/gi)) {
          const vUrl = decodeHtml(m[1]);
          if (!vUrl.startsWith('http') || seen.has(vUrl)) continue;
          seen.add(vUrl);

          let audioUrl: string | undefined;
          if (vUrl.includes('v.redd.it/')) {
            const cleanBase = vUrl.split('?')[0];
            const baseDir = cleanBase.substring(0, cleanBase.lastIndexOf('/'));
            for (const cand of [
              `${baseDir}/DASH_AUDIO_128.mp4`,
              `${baseDir}/DASH_AUDIO_64.mp4`,
              `${baseDir}/DASH_audio.mp4`,
            ]) {
              const sz = await probeContentLength(cand);
              if (sz && sz > 0) {
                audioUrl = cand;
                break;
              }
            }
          }

          const est = await probeContentLength(vUrl);
          vxAssets.push({
            id: randomUUID(),
            kind: 'video',
            title: rawTitle,
            platform: 'reddit',
            sourceUrl: parsedUrl.normalizedUrl,
            streamUrl: vUrl,
            audioStreamUrl: audioUrl,
            filename: sanitizeFilename(rawTitle, 'mp4'),
            mimeType: 'video/mp4',
            ext: 'mp4',
            estimatedBytes: est,
            exceedsLimit: typeof est === 'number' && est > maxLimitBytes,
            limitBytes: maxLimitBytes,
            strategy: audioUrl ? 'ffmpeg_mux_dash' : 'direct_http',
          });
        }

        if (vxAssets.length === 0) {
          for (const m of html.matchAll(/<meta property="og:image" content="([^"]+)"/gi)) {
            const iUrl = decodeHtml(m[1]);
            if (!iUrl.startsWith('http') || seen.has(iUrl)) continue;
            seen.add(iUrl);
            const isGif = iUrl.toLowerCase().includes('.gif');
            const ext = isGif ? 'gif' : 'jpg';
            vxAssets.push({
              id: randomUUID(),
              kind: isGif ? 'animation' : 'photo',
              title: rawTitle,
              platform: 'reddit',
              sourceUrl: parsedUrl.normalizedUrl,
              streamUrl: iUrl,
              thumbnailUrl: iUrl,
              filename: sanitizeFilename(`${rawTitle}_${vxAssets.length + 1}`, ext),
              mimeType: isGif ? 'image/gif' : 'image/jpeg',
              ext,
              exceedsLimit: false,
              limitBytes: maxLimitBytes,
              strategy: 'direct_http',
            });
          }
        }

        if (vxAssets.length > 0) {
          return {
            platform: 'reddit',
            sourceUrl: parsedUrl.normalizedUrl,
            title: rawTitle,
            extractorUsed: 'vxreddit-og',
            extractionMs: Date.now() - start,
            isCarousel: vxAssets.length > 1,
            hasSeparateAudio: false,
            assets: vxAssets,
            warnings: [],
          };
        }
      }
    }
    throw new Error(`Reddit JSON fallback failed (${res.status})`);
  }

  const json = (await res.json()) as Array<{
    data?: {
      children?: Array<{
        data?: {
          title?: string;
          author?: string;
          url?: string;
          is_video?: boolean;
          is_gallery?: boolean;
          crosspost_parent_list?: Array<{
            is_video?: boolean;
            is_gallery?: boolean;
            url?: string;
            media?: {
              reddit_video?: {
                fallback_url?: string;
                width?: number;
                height?: number;
                duration?: number;
                has_audio?: boolean;
              };
            };
          }>;
          media?: {
            reddit_video?: {
              fallback_url?: string;
              width?: number;
              height?: number;
              duration?: number;
              has_audio?: boolean;
            };
          };
          media_metadata?: Record<
            string,
            {
              m?: string;
              s?: { u?: string; gif?: string; mp4?: string; x?: number; y?: number };
            }
          >;
          gallery_data?: { items?: Array<{ media_id: string }> };
          preview?: {
            images?: Array<{ source?: { url?: string } }>;
            reddit_video_preview?: { fallback_url?: string };
          };
        };
      }>;
    };
  }>;

  const rawPost = json?.[0]?.data?.children?.[0]?.data;
  if (!rawPost) {
    throw new Error('Reddit post data not found.');
  }
  const post =
    !rawPost.is_video &&
    !rawPost.is_gallery &&
    rawPost.crosspost_parent_list?.[0]
      ? { ...rawPost, ...rawPost.crosspost_parent_list[0] }
      : rawPost;

  const title = post.title || 'Reddit Media';
  const author = post.author ? `u/${post.author}` : undefined;
  const assets: MediaAsset[] = [];

  if (post.is_video && post.media?.reddit_video?.fallback_url) {
    const rv = post.media.reddit_video;
    const videoUrl = rv.fallback_url!.split('?')[0];
    const baseDir = videoUrl.substring(0, videoUrl.lastIndexOf('/'));
    const audioCandidates = [
      `${baseDir}/DASH_AUDIO_128.mp4`,
      `${baseDir}/DASH_AUDIO_64.mp4`,
      `${baseDir}/DASH_audio.mp4`,
    ];

    let audioUrl: string | undefined;
    for (const candidate of audioCandidates) {
      const size = await probeContentLength(candidate);
      if (size && size > 0) {
        audioUrl = candidate;
        break;
      }
    }

    const vSize = await probeContentLength(videoUrl);
    assets.push({
      id: randomUUID(),
      kind: 'video',
      title,
      author,
      platform: 'reddit',
      sourceUrl: parsedUrl.normalizedUrl,
      streamUrl: videoUrl,
      audioStreamUrl: audioUrl,
      thumbnailUrl: post.preview?.images?.[0]?.source?.url?.replace(/&amp;/g, '&'),
      filename: sanitizeFilename(title, 'mp4'),
      mimeType: 'video/mp4',
      ext: 'mp4',
      width: rv.width,
      height: rv.height,
      durationSeconds: rv.duration,
      estimatedBytes: vSize,
      exceedsLimit: typeof vSize === 'number' && vSize > maxLimitBytes,
      limitBytes: maxLimitBytes,
      strategy: audioUrl ? 'ffmpeg_mux_dash' : 'direct_http',
      resolutionLabel: rv.height ? `${rv.height}p` : undefined,
    });
  } else if (post.is_gallery && post.media_metadata && post.gallery_data?.items) {
    for (let i = 0; i < post.gallery_data.items.length; i += 1) {
      const mediaId = post.gallery_data.items[i]?.media_id;
      const meta = post.media_metadata[mediaId];
      const rawUrl = (meta?.s?.mp4 || meta?.s?.gif || meta?.s?.u)?.replace(/&amp;/g, '&');
      if (!rawUrl) continue;
      const isVideo = Boolean(meta?.s?.mp4);
      const isGif = Boolean(meta?.s?.gif) && !isVideo;
      const ext = isVideo ? 'mp4' : isGif ? 'gif' : 'jpg';
      assets.push({
        id: randomUUID(),
        kind: isVideo ? 'video' : isGif ? 'animation' : 'photo',
        title,
        author,
        platform: 'reddit',
        sourceUrl: parsedUrl.normalizedUrl,
        streamUrl: rawUrl,
        thumbnailUrl: rawUrl,
        filename: sanitizeFilename(`${title}_${i + 1}`, ext),
        mimeType: isVideo ? 'video/mp4' : isGif ? 'image/gif' : 'image/jpeg',
        ext,
        width: meta?.s?.x,
        height: meta?.s?.y,
        exceedsLimit: false,
        limitBytes: maxLimitBytes,
        strategy: 'direct_http',
      });
    }
  } else if (post.url && /\.(jpg|jpeg|png|gif|mp4)(\?.*)?$/i.test(post.url)) {
    const extMatch = post.url.match(/\.(jpg|jpeg|png|gif|mp4)/i);
    const ext = (extMatch?.[1] || 'jpg').toLowerCase();
    const kind: MediaKind =
      ext === 'mp4' ? 'video' : ext === 'gif' ? 'animation' : 'photo';
    const estimatedBytes = await probeContentLength(post.url);
    assets.push({
      id: randomUUID(),
      kind,
      title,
      author,
      platform: 'reddit',
      sourceUrl: parsedUrl.normalizedUrl,
      streamUrl: post.url,
      thumbnailUrl: post.url,
      filename: sanitizeFilename(title, ext),
      mimeType:
        kind === 'video'
          ? 'video/mp4'
          : kind === 'animation'
            ? 'image/gif'
            : 'image/jpeg',
      ext,
      estimatedBytes,
      exceedsLimit:
        typeof estimatedBytes === 'number' && estimatedBytes > maxLimitBytes,
      limitBytes: maxLimitBytes,
      strategy: 'direct_http',
    });
  }

  if (assets.length === 0) {
    throw new Error('No direct media assets found in Reddit post.');
  }

  return {
    platform: 'reddit',
    sourceUrl: parsedUrl.normalizedUrl,
    title,
    author,
    extractorUsed: 'reddit-json',
    extractionMs: Date.now() - start,
    isCarousel: assets.length > 1,
    hasSeparateAudio: false,
    assets,
    warnings: [],
  };
}

// Fast TikTok Extractor via TikWM API (HD watermark-free MP4, Photo Slideshows, and MP3 audio)
async function extractTikTokFallback(
  parsedUrl: ParsedMediaUrl,
  maxLimitBytes: number
): Promise<ExtractionResult> {
  const start = Date.now();
  const body = new URLSearchParams({
    url: parsedUrl.normalizedUrl,
    hd: '1',
  });
  const res = await undiciFetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: body.toString(),
    dispatcher: metadataHttpAgent,
  });
  if (!res.ok) {
    throw new Error(`TikWM request failed (${res.status})`);
  }
  const payload = (await res.json()) as {
    code: number;
    msg?: string;
    data?: {
      id?: string;
      title?: string;
      cover?: string;
      duration?: number;
      play?: string;
      hdplay?: string;
      music?: string;
      music_info?: { title?: string; author?: string };
      author?: { unique_id?: string; nickname?: string };
      images?: string[];
      size?: number;
      hd_size?: number;
    };
  };

  if (payload.code !== 0 || !payload.data) {
    throw new Error(payload.msg || 'TikWM returned no media data.');
  }

  const d = payload.data;
  const title = d.title || `TikTok ${d.id || ''}`.trim();
  const author = d.author?.unique_id ? `@${d.author.unique_id}` : d.author?.nickname;
  const assets: MediaAsset[] = [];

  if (Array.isArray(d.images) && d.images.length > 0) {
    d.images.forEach((imgUrl, idx) => {
      assets.push({
        id: randomUUID(),
        kind: 'photo',
        title,
        author,
        platform: 'tiktok',
        sourceUrl: parsedUrl.normalizedUrl,
        streamUrl: imgUrl,
        thumbnailUrl: imgUrl,
        filename: sanitizeFilename(`${title}_slide_${idx + 1}`, 'jpg'),
        mimeType: 'image/jpeg',
        ext: 'jpg',
        exceedsLimit: false,
        limitBytes: maxLimitBytes,
        strategy: 'direct_http',
      });
    });
  } else if (d.hdplay || d.play) {
    const videoUrl =
      d.hdplay && (!d.hd_size || d.hd_size <= maxLimitBytes) ? d.hdplay : d.play!;
    const est = d.hdplay === videoUrl ? d.hd_size : d.size;
    assets.push({
      id: randomUUID(),
      kind: 'video',
      title,
      author,
      platform: 'tiktok',
      sourceUrl: parsedUrl.normalizedUrl,
      streamUrl: videoUrl,
      thumbnailUrl: d.cover,
      filename: sanitizeFilename(title, 'mp4'),
      mimeType: 'video/mp4',
      ext: 'mp4',
      durationSeconds: d.duration,
      estimatedBytes: est,
      exceedsLimit: typeof est === 'number' && est > maxLimitBytes,
      limitBytes: maxLimitBytes,
      strategy: 'direct_http',
    });
  }

  // Always include separate MP3 audio track for TikTok
  const audioSrc = d.music || d.play;
  if (audioSrc) {
    const audioTitle = d.music_info?.title
      ? `${d.music_info.title}${d.music_info.author ? ` - ${d.music_info.author}` : ''}`
      : `${title} (Audio)`;
    assets.push({
      id: randomUUID(),
      kind: 'audio',
      title: audioTitle,
      author: d.music_info?.author || author,
      platform: 'tiktok',
      sourceUrl: parsedUrl.normalizedUrl,
      streamUrl: audioSrc,
      thumbnailUrl: d.cover,
      filename: sanitizeFilename(`${audioTitle}`, 'mp3'),
      mimeType: 'audio/mpeg',
      ext: 'mp3',
      durationSeconds: d.duration,
      exceedsLimit: false,
      limitBytes: maxLimitBytes,
      strategy: d.music ? 'direct_http' : 'ffmpeg_extract_mp3',
    });
  }

  if (assets.length === 0) {
    throw new Error('No media assets found in TikTok response.');
  }

  return {
    platform: 'tiktok',
    sourceUrl: parsedUrl.normalizedUrl,
    title,
    author,
    extractorUsed: 'tikwm-async',
    extractionMs: Date.now() - start,
    isCarousel: assets.filter((a) => a.kind !== 'audio').length > 1,
    hasSeparateAudio: assets.some((a) => a.kind === 'audio'),
    assets,
    warnings: [],
  };
}

// Fast Fallback 4: Tumblr HTML OpenGraph / media meta parser
async function extractTumblrFallback(
  parsedUrl: ParsedMediaUrl,
  maxLimitBytes: number
): Promise<ExtractionResult> {
  const start = Date.now();
  const res = await undiciFetch(parsedUrl.normalizedUrl, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
    dispatcher: metadataHttpAgent,
  });
  if (!res.ok) {
    throw new Error(`Tumblr fetch failed (${res.status})`);
  }
  const html = await res.text();
  const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
  const title = titleMatch?.[1] || 'Tumblr Post';

  const videoMatches = Array.from(
    html.matchAll(/<meta property="og:video(?::secure_url)?" content="([^"]+)"/gi)
  ).map((m) => m[1]);
  const imageMatches = Array.from(
    html.matchAll(/<meta property="og:image" content="([^"]+)"/gi)
  ).map((m) => m[1]);

  const assets: MediaAsset[] = [];
  const seen = new Set<string>();

  for (const vUrl of videoMatches) {
    if (seen.has(vUrl)) continue;
    seen.add(vUrl);
    const est = await probeContentLength(vUrl);
    assets.push({
      id: randomUUID(),
      kind: 'video',
      title,
      platform: 'tumblr',
      sourceUrl: parsedUrl.normalizedUrl,
      streamUrl: vUrl,
      filename: sanitizeFilename(title, 'mp4'),
      mimeType: 'video/mp4',
      ext: 'mp4',
      estimatedBytes: est,
      exceedsLimit: typeof est === 'number' && est > maxLimitBytes,
      limitBytes: maxLimitBytes,
      strategy: 'direct_http',
    });
  }

  if (assets.length === 0) {
    for (let i = 0; i < imageMatches.length; i += 1) {
      const iUrl = imageMatches[i];
      if (seen.has(iUrl) || iUrl.includes('avatar')) continue;
      seen.add(iUrl);
      const isGif = iUrl.toLowerCase().includes('.gif');
      const ext = isGif ? 'gif' : 'jpg';
      assets.push({
        id: randomUUID(),
        kind: isGif ? 'animation' : 'photo',
        title,
        platform: 'tumblr',
        sourceUrl: parsedUrl.normalizedUrl,
        streamUrl: iUrl,
        thumbnailUrl: iUrl,
        filename: sanitizeFilename(`${title}_${i + 1}`, ext),
        mimeType: isGif ? 'image/gif' : 'image/jpeg',
        ext,
        exceedsLimit: false,
        limitBytes: maxLimitBytes,
        strategy: 'direct_http',
      });
    }
  }

  if (assets.length === 0) {
    throw new Error('Could not locate media tags on Tumblr post.');
  }

  return {
    platform: 'tumblr',
    sourceUrl: parsedUrl.normalizedUrl,
    title,
    extractorUsed: 'tumblr-og',
    extractionMs: Date.now() - start,
    isCarousel: assets.length > 1,
    hasSeparateAudio: false,
    assets,
    warnings: [],
  };
}

// Fast Fallback 5: Instagram Embed / Mirror OpenGraph resolver for Reels & Posts
async function extractInstagramFallback(
  parsedUrl: ParsedMediaUrl,
  maxLimitBytes: number
): Promise<ExtractionResult> {
  const start = Date.now();
  const u = new URL(parsedUrl.normalizedUrl);
  const pathMatch = u.pathname.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (!pathMatch) {
    throw new Error('Could not parse Instagram post/reel shortcode.');
  }
  const [, kindSlug, shortcode] = pathMatch;
  const normalizedKind = kindSlug.toLowerCase() === 'reels' ? 'reel' : kindSlug.toLowerCase();

  // Try official public embed endpoint first, then kkinstagram/ddinstagram OpenGraph
  const candidateEndpoints = [
    `https://www.instagram.com/${normalizedKind}/${shortcode}/embed/captioned/`,
    `https://kkinstagram.com/${normalizedKind}/${shortcode}`,
  ];

  for (const endpoint of candidateEndpoints) {
    try {
      const res = await undiciFetch(endpoint, {
        headers: {
          'User-Agent':
            endpoint.includes('kkinstagram')
              ? 'TelegramBot (like TwitterBot)'
              : USER_AGENT,
        },
        redirect: 'follow',
        dispatcher: metadataHttpAgent,
      });
      if (!res.ok) continue;
      const html = await res.text();

      const decodeHtml = (s: string) =>
        s
          .replace(/&amp;/g, '&')
          .replace(/\\u0026/g, '&')
          .replace(/\\\//g, '/');

      const assets: MediaAsset[] = [];
      const seen = new Set<string>();

      const videoRegex =
        /(?:"video_url"\s*:\s*"([^"]+)"|<meta property="og:video(?::secure_url)?" content="([^"]+)")/gi;
      for (const m of html.matchAll(videoRegex)) {
        const raw = decodeHtml(m[1] || m[2] || '');
        if (!raw.startsWith('http') || seen.has(raw)) continue;
        seen.add(raw);
        const est = await probeContentLength(raw);
        assets.push({
          id: randomUUID(),
          kind: 'video',
          title: `Instagram ${normalizedKind} ${shortcode}`,
          platform: 'instagram',
          sourceUrl: parsedUrl.normalizedUrl,
          streamUrl: raw,
          filename: sanitizeFilename(`ig_${shortcode}_${assets.length + 1}`, 'mp4'),
          mimeType: 'video/mp4',
          ext: 'mp4',
          estimatedBytes: est,
          exceedsLimit: typeof est === 'number' && est > maxLimitBytes,
          limitBytes: maxLimitBytes,
          strategy: 'direct_http',
        });
      }

      if (assets.length === 0) {
        const imgRegex =
          /(?:"display_url"\s*:\s*"([^"]+)"|<meta property="og:image" content="([^"]+)")/gi;
        for (const m of html.matchAll(imgRegex)) {
          const raw = decodeHtml(m[1] || m[2] || '');
          if (!raw.startsWith('http') || seen.has(raw)) continue;
          seen.add(raw);
          assets.push({
            id: randomUUID(),
            kind: 'photo',
            title: `Instagram ${normalizedKind} ${shortcode}`,
            platform: 'instagram',
            sourceUrl: parsedUrl.normalizedUrl,
            streamUrl: raw,
            thumbnailUrl: raw,
            filename: sanitizeFilename(`ig_${shortcode}_${assets.length + 1}`, 'jpg'),
            mimeType: 'image/jpeg',
            ext: 'jpg',
            exceedsLimit: false,
            limitBytes: maxLimitBytes,
            strategy: 'direct_http',
          });
        }
      }

      if (assets.length > 0) {
        return {
          platform: 'instagram',
          sourceUrl: parsedUrl.normalizedUrl,
          title: `Instagram ${normalizedKind} ${shortcode}`,
          extractorUsed: endpoint.includes('kkinstagram')
            ? 'kkinstagram-og'
            : 'instagram-embed',
          extractionMs: Date.now() - start,
          isCarousel: assets.length > 1,
          hasSeparateAudio: false,
          assets,
          warnings: [],
        };
      }
    } catch {
      // Try next endpoint
    }
  }

  throw new Error('Instagram embed/OG extraction returned no public media.');
}

export async function extractMedia(
  parsedUrl: ParsedMediaUrl,
  options: ExtractionOptions = {}
): Promise<ExtractionResult> {
  const maxLimitBytes = options.maxLimitBytes ?? DEFAULT_LIMIT_BYTES;
  const errors: string[] = [];

  // For TikTok, TikWM resolves watermark-free HD MP4, photo slideshows, and MP3 in <1s without CDN cookie walls.
  if (parsedUrl.platform === 'tiktok') {
    try {
      return await extractTikTokFallback(parsedUrl, maxLimitBytes);
    } catch (err) {
      errors.push(`tikwm: ${(err as Error).message}`);
    }
  }

  try {
    return await extractWithYtDlp(parsedUrl, options);
  } catch (err) {
    errors.push(`yt-dlp: ${(err as Error).message}`);
  }

  if (parsedUrl.platform === 'instagram') {
    try {
      return await extractInstagramFallback(parsedUrl, maxLimitBytes);
    } catch (err) {
      errors.push(`instagram-fallback: ${(err as Error).message}`);
    }
  }

  if (parsedUrl.platform === 'twitter') {
    try {
      return await extractTwitterFallback(parsedUrl, maxLimitBytes);
    } catch (err) {
      errors.push(`fxtwitter: ${(err as Error).message}`);
    }
  }

  if (parsedUrl.platform === 'reddit') {
    try {
      return await extractRedditFallback(parsedUrl, maxLimitBytes);
    } catch (err) {
      errors.push(`reddit-fallback: ${(err as Error).message}`);
    }
  }

  if (parsedUrl.platform === 'tumblr') {
    try {
      return await extractTumblrFallback(parsedUrl, maxLimitBytes);
    } catch (err) {
      errors.push(`tumblr-og: ${(err as Error).message}`);
    }
  }

  throw new Error(
    `Extraction failed for ${parsedUrl.platform}. ${errors.join(' | ')}`
  );
}
