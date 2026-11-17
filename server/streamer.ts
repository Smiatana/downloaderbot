import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Agent, fetch as undiciFetch } from 'undici';
import { telemetry } from './telemetry.ts';
import type { MediaAsset } from './types.ts';
import { assertSafeUpstreamMediaUrl } from './urlRouter.ts';

const streamHttpAgent = new Agent({
  connections: 64,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  connectTimeout: 12_000,
});

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface OpenedZeroDiskStream {
  stream: Readable;
  contentType: string;
  filename: string;
  contentLength?: number;
  cleanup: () => void;
}

function attachByteMeter(
  source: Readable,
  onComplete?: (totalBytes: number, durationMs: number) => void
): PassThrough {
  const meter = new PassThrough({ highWaterMark: 64 * 1024 });
  let totalBytes = 0;
  const startedAt = Date.now();
  let finalized = false;

  const finalize = (failed: boolean) => {
    if (finalized) return;
    finalized = true;
    if (failed) {
      telemetry.recordStreamFailed();
    } else {
      telemetry.recordStreamCompleted(totalBytes, Date.now() - startedAt);
      onComplete?.(totalBytes, Date.now() - startedAt);
    }
  };

  source.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
  });
  source.on('end', () => finalize(false));
  source.on('error', (err) => {
    finalize(true);
    meter.destroy(err);
  });

  source.pipe(meter);
  return meter;
}

function buildFfmpegHeadersArg(headers?: Record<string, string>): string {
  const merged: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    ...headers,
  };
  return (
    Object.entries(merged)
      .filter(([k]) => k.toLowerCase() !== 'host')
      .map(([k, v]) => `${k}: ${v.replace(/[\r\n]/g, '')}`)
      .join('\r\n') + '\r\n'
  );
}

export async function openZeroDiskStream(
  asset: MediaAsset,
  options: {
    forceExtractMp3?: boolean;
    compressOverLimit?: boolean;
    onComplete?: (totalBytes: number, durationMs: number) => void;
  } = {}
): Promise<OpenedZeroDiskStream> {
  assertSafeUpstreamMediaUrl(asset.streamUrl);
  if (asset.audioStreamUrl) {
    assertSafeUpstreamMediaUrl(asset.audioStreamUrl);
  }

  const shouldExtractMp3 =
    options.forceExtractMp3 || asset.strategy === 'ffmpeg_extract_mp3';
  const shouldMuxDash =
    asset.strategy === 'ffmpeg_mux_dash' && Boolean(asset.audioStreamUrl);
  const shouldCompress =
    Boolean(options.compressOverLimit) &&
    asset.exceedsLimit &&
    asset.kind === 'video';

  // Strategy 1: Zero-disk DASH video+audio muxing via FFmpeg pipe:1
  if (shouldMuxDash && asset.audioStreamUrl) {
    const headerBlock = buildFfmpegHeadersArg(asset.headers);
    const ffmpegArgs = [
      '-loglevel',
      'error',
      '-headers',
      headerBlock,
      '-i',
      asset.streamUrl,
      '-headers',
      headerBlock,
      '-i',
      asset.audioStreamUrl,
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', ffmpegArgs, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrMsg = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderrMsg += d.toString();
    });
    proc.on('close', (code) => {
      if (code && code !== 0 && !proc.stdout.destroyed) {
        proc.stdout.destroy(
          new Error(`FFmpeg DASH mux exited with ${code}: ${stderrMsg.slice(0, 200)}`)
        );
      }
    });

    const metered = attachByteMeter(proc.stdout, options.onComplete);
    return {
      stream: metered,
      contentType: 'video/mp4',
      filename: asset.filename.replace(/\.[^.]+$/, '.mp4'),
      cleanup: () => {
        if (!proc.killed) proc.kill('SIGKILL');
      },
    };
  }

  // Open upstream HTTP stream directly in memory (zero local file storage)
  const upstreamRes = await undiciFetch(asset.streamUrl, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      ...asset.headers,
    },
    redirect: 'follow',
    dispatcher: streamHttpAgent,
  });

  if (!upstreamRes.ok || !upstreamRes.body) {
    // Fallback for signed CDN URLs that reject direct HTTP fetch: stream yt-dlp stdout directly
    if (
      asset.kind === 'video' &&
      !shouldExtractMp3 &&
      !shouldCompress &&
      asset.sourceUrl
    ) {
      const { ensureYtDlpBinary } = await import('./extractor.ts');
      const ytDlpBin = await ensureYtDlpBinary();
      const proc = spawn(
        ytDlpBin,
        [
          '-f',
          'best[ext=mp4]/best',
          '--no-warnings',
          '--no-check-certificates',
          '-o',
          '-',
          asset.sourceUrl,
        ],
        {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let stderrMsg = '';
      proc.stderr.on('data', (d: Buffer) => {
        stderrMsg += d.toString();
      });
      proc.on('close', (code) => {
        if (code && code !== 0 && !proc.stdout.destroyed) {
          proc.stdout.destroy(
            new Error(`yt-dlp stdout pipe exited ${code}: ${stderrMsg.slice(0, 200)}`)
          );
        }
      });

      const metered = attachByteMeter(proc.stdout, options.onComplete);
      return {
        stream: metered,
        contentType: 'video/mp4',
        filename: asset.filename,
        cleanup: () => {
          if (!proc.killed) proc.kill('SIGKILL');
        },
      };
    }

    throw new Error(`Upstream media returned HTTP ${upstreamRes.status}`);
  }

  const upstreamReadable = Readable.fromWeb(
    upstreamRes.body as unknown as WebReadableStream
  );

  // Strategy 2: On-the-fly TikTok MP3 extraction via FFmpeg pipe:0 -> pipe:1
  if (shouldExtractMp3) {
    const ffmpegArgs = [
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vn',
      '-acodec',
      'libmp3lame',
      '-q:a',
      '2',
      '-f',
      'mp3',
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', ffmpegArgs, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrMsg = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderrMsg += d.toString();
    });

    upstreamReadable.pipe(proc.stdin);
    upstreamReadable.on('error', (err) => {
      if (!proc.killed) proc.kill('SIGKILL');
      proc.stdout.destroy(err);
    });
    proc.stdin.on('error', () => {
      // Ignore EPIPE when ffmpeg finishes early
    });
    proc.on('close', (code) => {
      if (code && code !== 0 && !proc.stdout.destroyed) {
        proc.stdout.destroy(
          new Error(`FFmpeg MP3 pipe exited ${code}: ${stderrMsg.slice(0, 200)}`)
        );
      }
    });

    const metered = attachByteMeter(proc.stdout, options.onComplete);
    return {
      stream: metered,
      contentType: 'audio/mpeg',
      filename: asset.filename.replace(/\.[^.]+$/, '.mp3'),
      cleanup: () => {
        upstreamReadable.destroy();
        if (!proc.killed) proc.kill('SIGKILL');
      },
    };
  }

  // Strategy 3: On-the-fly FFmpeg compression pipe for >50MB videos
  if (shouldCompress) {
    const ffmpegArgs = [
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-vf',
      "scale='min(1280,iw)':-2",
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', ffmpegArgs, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    upstreamReadable.pipe(proc.stdin);
    upstreamReadable.on('error', (err) => {
      if (!proc.killed) proc.kill('SIGKILL');
      proc.stdout.destroy(err);
    });
    proc.stdin.on('error', () => {});

    const metered = attachByteMeter(proc.stdout, options.onComplete);
    return {
      stream: metered,
      contentType: 'video/mp4',
      filename: asset.filename.replace(/\.[^.]+$/, '.mp4'),
      cleanup: () => {
        upstreamReadable.destroy();
        if (!proc.killed) proc.kill('SIGKILL');
      },
    };
  }

  // Strategy 4: Pure zero-copy HTTP pass-through stream
  const contentLengthHeader = upstreamRes.headers.get('content-length');
  const contentLength = contentLengthHeader
    ? Number(contentLengthHeader)
    : asset.estimatedBytes;

  const metered = attachByteMeter(upstreamReadable, options.onComplete);
  return {
    stream: metered,
    contentType:
      upstreamRes.headers.get('content-type') || asset.mimeType || 'application/octet-stream',
    filename: asset.filename,
    contentLength:
      contentLength && Number.isFinite(contentLength) ? contentLength : undefined,
    cleanup: () => {
      upstreamReadable.destroy();
    },
  };
}
