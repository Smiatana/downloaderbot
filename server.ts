import 'dotenv/config';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import express from 'express';
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { ensureYtDlpBinary, extractMedia } from './server/extractor.ts';
import { getPythonBotFiles } from './server/pythonGenerator.ts';
import { openZeroDiskStream } from './server/streamer.ts';
import { telegramBotManager } from './server/telegramBot.ts';
import { telemetry } from './server/telemetry.ts';
import type { MediaAsset, StreamEventLog, TelemetrySnapshot, YouTubeQuality } from './server/types.ts';
import { sanitizeAndParseUrl } from './server/urlRouter.ts';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME?.trim() || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_COOKIE = 'streambot_admin';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ASSET_CACHE_ENTRIES = 1000;

function readBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function createRateLimiter(maxRequests: number, windowMs: number): express.RequestHandler {
  const clients = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of clients) {
      if (entry.resetAt <= now) clients.delete(ip);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let entry = clients.get(ip);
    if (!entry || entry.resetAt <= now) {
      if (clients.size >= 10_000) {
        const oldestIp = clients.keys().next().value;
        if (oldestIp) clients.delete(oldestIp);
      }
      entry = { count: 0, resetAt: now + windowMs };
      clients.set(ip, entry);
    }

    entry.count += 1;
    if (entry.count > maxRequests) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Too many requests. Try again later.' });
      return;
    }
    next();
  };
}

// Ephemeral in-memory asset descriptor cache (20 min TTL, zero disk writes)
const assetCache = new Map<string, { asset: MediaAsset; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of assetCache.entries()) {
    if (entry.expiresAt < now) {
      assetCache.delete(key);
    }
  }
}, 60_000).unref();

async function bootstrap() {
  const app = express();
  const trustedProxyHops = readBoundedInt('TRUST_PROXY_HOPS', 0, 0, 5);
  if (trustedProxyHops > 0) app.set('trust proxy', trustedProxyHops);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use('/api', createRateLimiter(180, 60_000));
  app.use('/api/extract', createRateLimiter(12, 60_000));
  app.use('/api/stream', createRateLimiter(60, 60_000));
  app.use('/api/events', createRateLimiter(6, 60_000));
  app.use(express.json({ limit: '1mb' }));

  let activeExtractions = 0;
  let activeStreams = 0;
  const maxExtractions = readBoundedInt('MAX_EXTRACT_CONCURRENCY', 3, 1, 16);
  const maxStreams = readBoundedInt('MAX_STREAM_CONCURRENCY', 6, 1, 32);

  const adminSessions = new Map<string, number>();
  const loginAttempts = new Map<string, { attempts: number; resetAt: number }>();
  const getAdminSessionId = (cookieHeader: string | undefined) => {
    const cookie = cookieHeader
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
    const sessionId = cookie?.slice(ADMIN_SESSION_COOKIE.length + 1);
    return sessionId && /^[A-Za-z0-9_-]{43}$/.test(sessionId)
      ? sessionId
      : undefined;
  };
  const isAdminAuthenticated = (cookieHeader: string | undefined) => {
    const sessionId = getAdminSessionId(cookieHeader);
    if (!sessionId) return false;
    const expiresAt = adminSessions.get(sessionId);
    if (!expiresAt || expiresAt <= Date.now()) {
      adminSessions.delete(sessionId);
      return false;
    }
    return true;
  };
  const credentialsMatch = (provided: string, expected: string) => {
    const providedHash = createHash('sha256').update(provided).digest();
    const expectedHash = createHash('sha256').update(expected).digest();
    return timingSafeEqual(providedHash, expectedHash);
  };
  const setAdminSessionCookie = (
    res: express.Response,
    req: express.Request,
    sessionId: string,
    maxAgeSeconds: number
  ) => {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.setHeader(
      'Set-Cookie',
      `${ADMIN_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
    );
  };
  const requireAdmin: express.RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isAdminAuthenticated(req.headers.cookie)) {
      res.status(401).json({ error: 'Admin authentication required.' });
      return;
    }
    next();
  };

  app.get('/api/auth/status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      configured: Boolean(ADMIN_USERNAME && ADMIN_PASSWORD),
      authenticated: isAdminAuthenticated(req.headers.cookie),
    });
  });

  app.post('/api/auth/login', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
      res.status(503).json({
        error: 'Admin login is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD.',
      });
      return;
    }

    const username =
      typeof req.body?.username === 'string' ? req.body.username : '';
    const password =
      typeof req.body?.password === 'string' ? req.body.password : '';

    const now = Date.now();
    for (const [ip, entry] of loginAttempts) {
      if (entry.resetAt <= now) loginAttempts.delete(ip);
    }
    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let attempts = loginAttempts.get(clientIp);
    if (attempts && attempts.resetAt <= now) {
      loginAttempts.delete(clientIp);
      attempts = undefined;
    }
    if (attempts && attempts.attempts >= 10) {
      res.setHeader(
        'Retry-After',
        String(Math.ceil((attempts.resetAt - now) / 1000))
      );
      res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
      return;
    }

    const usernameMatches =
      username.length <= 128 && credentialsMatch(username, ADMIN_USERNAME);
    const passwordMatches =
      password.length <= 256 && credentialsMatch(password, ADMIN_PASSWORD);

    if (!usernameMatches || !passwordMatches) {
      if (!attempts) {
        if (loginAttempts.size >= 2000) {
          const oldestIp = loginAttempts.keys().next().value;
          if (oldestIp) loginAttempts.delete(oldestIp);
        }
        attempts = { attempts: 0, resetAt: now + 15 * 60 * 1000 };
        loginAttempts.set(clientIp, attempts);
      }
      attempts.attempts += 1;
      res.status(401).json({ error: 'Incorrect username or password.' });
      return;
    }

    loginAttempts.delete(clientIp);
    for (const [sessionId, expiresAt] of adminSessions) {
      if (expiresAt <= Date.now()) adminSessions.delete(sessionId);
    }
    if (adminSessions.size >= 100) {
      const oldestSession = adminSessions.keys().next().value;
      if (oldestSession) adminSessions.delete(oldestSession);
    }

    const sessionId = randomBytes(32).toString('base64url');
    adminSessions.set(sessionId, Date.now() + ADMIN_SESSION_TTL_MS);
    setAdminSessionCookie(
      res,
      req,
      sessionId,
      ADMIN_SESSION_TTL_MS / 1000
    );
    res.json({ authenticated: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const sessionId = getAdminSessionId(req.headers.cookie);
    if (sessionId) adminSessions.delete(sessionId);
    setAdminSessionCookie(res, req, '', 0);
    res.json({ authenticated: false });
  });

  app.use('/api/bot', requireAdmin);

  // Warm yt-dlp standalone binary silently on startup
  ensureYtDlpBinary().catch((err) => {
    telemetry.logEvent({
      source: 'system',
      level: 'warning',
      message: `yt-dlp bootstrap deferred: ${(err as Error).message}`,
    });
  });

  // Auto-start Telegram bot if TELEGRAM_BOT_TOKEN env var is configured
  if (process.env.TELEGRAM_BOT_TOKEN?.trim()) {
    telegramBotManager.start().catch((err) => {
      telemetry.logEvent({
        source: 'system',
        level: 'error',
        message: `Auto-start Telegram bot failed: ${(err as Error).message}`,
      });
    });
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      diskBytesWritten: 0,
    });
  });

  app.get('/api/telemetry', (_req, res) => {
    res.json(telemetry.getSnapshot());
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (eventName: string, data: unknown) => {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('snapshot', telemetry.getSnapshot());

    const onSnapshot = (snap: TelemetrySnapshot) => sendEvent('snapshot', snap);
    const onLog = (entry: StreamEventLog) => sendEvent('log', entry);

    telemetry.on('snapshot', onSnapshot);
    telemetry.on('log', onLog);

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 20_000);

    res.on('close', () => {
      clearInterval(heartbeat);
      telemetry.off('snapshot', onSnapshot);
      telemetry.off('log', onLog);
    });
  });

  app.post('/api/extract', async (req, res) => {
    const startedAt = Date.now();
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    const parsedUrl = sanitizeAndParseUrl(rawUrl);

    if (!parsedUrl) {
      res.status(400).json({
        error:
          'Unsupported or unsafe URL. Provide a valid Instagram, TikTok, Twitter/X, Reddit, Tumblr, YouTube, YouTube Shorts, or YouTube Music link.',
      });
      return;
    }

    const quality: YouTubeQuality =
      req.body?.youtubeQuality === '360' ||
      req.body?.youtubeQuality === '720' ||
      req.body?.youtubeQuality === '1080'
        ? req.body.youtubeQuality
        : '720';

    if (activeExtractions >= maxExtractions) {
      res.setHeader('Retry-After', '10');
      res.status(503).json({ error: 'Extraction capacity is busy. Try again shortly.' });
      return;
    }
    activeExtractions += 1;
    telemetry.incrementActiveWorkers();
    try {
      const result = await extractMedia(parsedUrl, {
        youtubeQuality: quality,
        maxLimitBytes: telegramBotManager.getLimitBytes(),
        proxyUrl: typeof req.body?.proxyUrl === 'string' ? req.body.proxyUrl : undefined,
        cookiesHeader:
          typeof req.body?.cookiesHeader === 'string'
            ? req.body.cookiesHeader
            : undefined,
      });

      const expiresAt = Date.now() + 20 * 60 * 1000;
      for (const asset of result.assets) {
        if (assetCache.size >= MAX_ASSET_CACHE_ENTRIES) {
          const oldestAssetId = assetCache.keys().next().value;
          if (oldestAssetId) assetCache.delete(oldestAssetId);
        }
        assetCache.set(asset.id, { asset, expiresAt });
      }

      telemetry.logEvent({
        source: 'sandbox',
        level: 'success',
        platform: result.platform,
        message: `Resolved ${result.assets.length} stream(s) via ${result.extractorUsed}`,
        durationMs: Date.now() - startedAt,
      });

      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      telemetry.recordStreamFailed();
      telemetry.logEvent({
        source: 'sandbox',
        level: 'error',
        platform: parsedUrl.platform,
        message,
        durationMs: Date.now() - startedAt,
      });
      res.status(422).json({
        error: "❌ Sorry, I couldn't extract media from this link. It might be private or deleted.",
        details: message,
      });
    } finally {
      activeExtractions = Math.max(0, activeExtractions - 1);
      telemetry.decrementActiveWorkers();
    }
  });

  app.get('/api/stream/:assetId', async (req, res) => {
    const cached = assetCache.get(req.params.assetId);
    if (!cached || cached.expiresAt < Date.now()) {
      res.status(404).json({ error: 'Stream session expired. Please re-extract the URL.' });
      return;
    }

    if (activeStreams >= maxStreams) {
      res.setHeader('Retry-After', '10');
      res.status(503).json({ error: 'Stream capacity is busy. Try again shortly.' });
      return;
    }
    activeStreams += 1;
    const forceExtractMp3 = req.query.mp3 === '1';
    const compressOverLimit = req.query.compress === '1';
    const asAttachment = req.query.download === '1';

    telemetry.incrementActiveWorkers();
    let cleanupFn: (() => void) | null = null;
    let workerReleased = false;
    const releaseWorker = () => {
      if (!workerReleased) {
        workerReleased = true;
        activeStreams = Math.max(0, activeStreams - 1);
        telemetry.decrementActiveWorkers();
      }
    };

    try {
      const opened = await openZeroDiskStream(cached.asset, {
        forceExtractMp3,
        compressOverLimit,
      });
      cleanupFn = opened.cleanup;

      res.setHeader('Content-Type', opened.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Zero-Disk-Stream', 'true');
      if (opened.contentLength) {
        res.setHeader('Content-Length', String(opened.contentLength));
      }
      if (asAttachment) {
        const safeName = opened.filename.replace(/["\r\n]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      }

      res.on('close', () => {
        cleanupFn?.();
        releaseWorker();
      });

      opened.stream.on('error', (streamErr) => {
        cleanupFn?.();
        releaseWorker();
        if (!res.headersSent) {
          res.status(502).json({ error: streamErr.message });
        } else {
          res.end();
        }
      });

      opened.stream.on('end', () => {
        releaseWorker();
      });

      opened.stream.pipe(res);
    } catch (err) {
      cleanupFn?.();
      releaseWorker();
      if (!res.headersSent) {
        res.status(502).json({
          error: err instanceof Error ? err.message : 'Upstream stream error',
        });
      }
    }
  });

  app.get('/api/bot/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(telegramBotManager.getStatus());
  });

  app.post('/api/bot/config', (req, res) => {
    const status = telegramBotManager.updateConfig({
      token: req.body?.token,
      apiRoot: req.body?.apiRoot,
      concurrency:
        typeof req.body?.concurrency === 'number'
          ? req.body.concurrency
          : undefined,
      youtubeQuality: req.body?.youtubeQuality,
      mediaMode: req.body?.mediaMode,
      autoCompressOverLimit: req.body?.autoCompressOverLimit,
      proxyUrl: req.body?.proxyUrl,
      cookiesHeader: req.body?.cookiesHeader,
    });
    res.json(status);
  });

  app.post('/api/bot/start', async (req, res) => {
    try {
      const status = await telegramBotManager.start({
        token: req.body?.token,
        apiRoot: req.body?.apiRoot,
        concurrency:
          typeof req.body?.concurrency === 'number'
            ? req.body.concurrency
            : undefined,
        youtubeQuality: req.body?.youtubeQuality,
        mediaMode: req.body?.mediaMode,
        autoCompressOverLimit: req.body?.autoCompressOverLimit,
        proxyUrl: req.body?.proxyUrl,
        cookiesHeader: req.body?.cookiesHeader,
      });
      res.json(status);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to start bot',
        status: telegramBotManager.getStatus(),
      });
    }
  });

  app.post('/api/bot/stop', async (_req, res) => {
    const status = await telegramBotManager.stop();
    res.json(status);
  });

  app.get('/api/export/python-files', (_req, res) => {
    res.json({ files: getPythonBotFiles() });
  });

  app.get('/api/export/python-bot.zip', async (_req, res) => {
    const zip = new JSZip();
    for (const file of getPythonBotFiles()) {
      zip.file(file.path, file.content);
    }
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="streambot-aiogram-zero-disk.zip"'
    );
    res.send(zipBuffer);
  });

  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build.');
      }
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`StreamBot server listening on http://0.0.0.0:${PORT}`);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
}

bootstrap().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
