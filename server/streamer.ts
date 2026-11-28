import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Agent, fetch as undiciFetch } from 'undici';
import { telemetry } from './telemetry.ts';
import type { MediaAsset } from './types.ts';
import { assertSafeUpstreamMediaUrl } from './urlRouter.ts';

const streamHttpAgent = new Agent({
  connections: 24,
  pipelining: 1,
  keepAliveTimeout: 60_000,
  connectTimeout: 10_000,
});

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function appendStderr(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString()}`.slice(-4096);
}

export interface OpenedZeroDiskStream {
  stream: Readable;
  contentType: string;
  filename: string;
  contentLength?: number;
  cleanup: () => void;
}

export interface OpenedVideoAudioStreams {
  video: Readable;
  audio: Readable;
  cleanup: () => void;
}

function attachByteMeter(
  source: Readable,
  onComplete?: (totalBytes: number, durationMs: number) => void
): PassThrough {
  const meter = new PassThrough({ highWaterMark: 256 * 1024 });
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

export function assertReadableHasData(
  source: Readable,
  timeoutMs = 15_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.off('data', onData);
      source.off('end', onEnd);
      source.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer) => {
      source.pause();
      try {
        source.unshift(chunk);
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onEnd = () => finish(new Error('Media source ended without sending data.'));
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for the first media bytes.')),
      timeoutMs
    );

    source.once('data', onData);
    source.once('end', onEnd);
    source.once('error', onError);
  });
}

export async function splitVideoStreamForAudio(
  source: Readable,
  metadata: { title?: string; author?: string } = {}
): Promise<OpenedVideoAudioStreams> {
  const video = new PassThrough({ highWaterMark: 256 * 1024 });
  const proc = spawn(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn', '-sn', '-dn',
      '-c:a', 'libmp3lame',
      '-q:a', '3',
      '-compression_level', '2',
      '-id3v2_version', '3',
      ...(metadata.title ? ['-metadata', `title=${metadata.title.replace(/[\r\n]/g, ' ')}`] : []),
      ...(metadata.author ? ['-metadata', `artist=${metadata.author.replace(/[\r\n]/g, ' ')}`] : []),
      '-f', 'mp3', 'pipe:1',
    ],
    { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  let stderrMsg = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrMsg = appendStderr(stderrMsg, chunk);
  });
  proc.stdin.on('error', () => {});
  source.on('error', (error) => {
    video.destroy(error);
    if (!proc.killed) proc.kill('SIGKILL');
  });
  source.pipe(video);
  source.pipe(proc.stdin);
  proc.on('error', (error) => proc.stdout.destroy(error));
  proc.on('close', (code) => {
    if (code && code !== 0 && !proc.stdout.destroyed) {
      proc.stdout.destroy(
        new Error(`FFmpeg audio extraction exited ${code}: ${stderrMsg.slice(-300)}`)
      );
    }
  });

  return {
    video,
    audio: proc.stdout,
    cleanup: () => {
      source.destroy();
      video.destroy();
      proc.stdout.destroy();
      if (!proc.killed) proc.kill('SIGKILL');
    },
  };
}

function isYouTubePlatform(platform: MediaAsset['platform']): boolean {
  return (
    platform === 'youtube' ||
    platform === 'youtube_shorts' ||
    platform === 'youtube_music'
  );
}

async function openYtDlpFallback(
  asset: MediaAsset,
  mode: 'audio' | 'video',
  onComplete?: (totalBytes: number, durationMs: number) => void
): Promise<OpenedZeroDiskStream> {
  if (isYouTubePlatform(asset.platform)) {
    throw new Error(
      `Direct stream failed for ${asset.platform}; yt-dlp fallback is disabled for YouTube.`
    );
  }
  const { ensureYtDlpBinary, isTermuxEnvironment } = await import('./extractor.ts');
  const ytDlpBin = await ensureYtDlpBinary();
  const formatSelector = mode === 'audio' ? 'bestaudio/best' : 'best[ext=mp4]/best';
  const args = [
    '-f',
    formatSelector,
    ...(isTermuxEnvironment() ? [] : ['--js-runtimes', 'node']),
    '--no-warnings',
    '-o',
    '-',
    asset.sourceUrl,
  ];
  const proc = spawn(ytDlpBin, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrMsg = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrMsg = appendStderr(stderrMsg, chunk);
  });
  proc.on('error', (err) => proc.stdout.destroy(err));
  proc.on('close', (code) => {
    if (code && code !== 0 && !proc.stdout.destroyed) {
      proc.stdout.destroy(
        new Error(`yt-dlp ${mode} fallback exited ${code}: ${stderrMsg.slice(-200)}`)
      );
    }
  });

  try {
    await assertReadableHasData(proc.stdout, 15_000);
  } catch (error) {
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.off('close', onClose);
          if (!proc.killed) proc.kill('SIGKILL');
          resolve();
        }, 1000);
        const onClose = () => {
          clearTimeout(timer);
          resolve();
        };
        proc.once('close', onClose);
      });
    }
    if (!proc.killed) proc.kill('SIGKILL');
    const detail = stderrMsg.trim().slice(-1200);
    throw new Error(
      detail
        ? `yt-dlp ${mode} fallback produced no media bytes: ${detail}`
        : `yt-dlp ${mode} fallback produced no media bytes: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    stream: attachByteMeter(proc.stdout, onComplete),
    contentType: mode === 'audio' ? asset.mimeType : 'video/mp4',
    filename: asset.filename,
    cleanup: () => {
      if (!proc.killed) proc.kill('SIGKILL');
    },
  };
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
    const isAudioAacCompatible =
      asset.audioExt === 'm4a' ||
      asset.audioExt === 'mp4' ||
      /\.m4a(\?|$)|DASH_AUDIO/i.test(asset.audioStreamUrl);
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
      ...(isAudioAacCompatible ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']),
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
      stderrMsg = appendStderr(stderrMsg, d);
    });
    proc.on('error', (err) => proc.stdout.destroy(err));
    proc.on('close', (code) => {
      if (code && code !== 0 && !proc.stdout.destroyed) {
        proc.stdout.destroy(
          new Error(`FFmpeg DASH mux exited with ${code}: ${stderrMsg.slice(0, 200)}`)
        );
      }
    });

    const metered = attachByteMeter(proc.stdout, options.onComplete);
    try {
      await assertReadableHasData(metered, 15_000);
    } catch (err) {
      metered.destroy();
      if (!proc.killed) proc.kill('SIGKILL');
      if (asset.sourceUrl && !shouldCompress) {
        return openYtDlpFallback(asset, 'video', options.onComplete);
      }
      const detail = stderrMsg.trim().slice(-400);
      throw new Error(
        detail
          ? `FFmpeg DASH mux produced no media bytes: ${detail}`
          : `FFmpeg DASH mux produced no media bytes: ${err instanceof Error ? err.message : String(err)}`
      );
    }

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
    // (disabled for YouTube family, which uses direct InnerTube streams)
    if (
      !isYouTubePlatform(asset.platform) &&
      (asset.kind === 'video' || asset.kind === 'audio' || shouldExtractMp3) &&
      !shouldCompress &&
      asset.sourceUrl
    ) {
      const { ensureYtDlpBinary } = await import('./extractor.ts');
      const ytDlpBin = await ensureYtDlpBinary();

      if (shouldExtractMp3) {
        const { isTermuxEnvironment } = await import('./extractor.ts');
        const ytdlpProc = spawn(
          ytDlpBin,
          [
            '-f',
            'bestaudio/best',
            ...(isTermuxEnvironment() ? [] : ['--js-runtimes', 'node']),
            '--no-warnings',
            '-o',
            '-',
            asset.sourceUrl,
          ],
          { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        const ffmpegProc = spawn(
          'ffmpeg',
          [
            '-loglevel',
            'error',
            '-fflags',
            '+flush_packets',
            '-i',
            'pipe:0',
            '-vn',
            '-sn',
            '-dn',
            '-c:a',
            'libmp3lame',
            '-q:a',
            '3',
            '-compression_level',
            '2',
            '-id3v2_version',
            '3',
            ...(asset.title ? ['-metadata', `title=${asset.title.replace(/[\r\n]/g, ' ')}`] : []),
            ...(asset.author ? ['-metadata', `artist=${asset.author.replace(/[\r\n]/g, ' ')}`] : []),
            '-f',
            'mp3',
            'pipe:1',
          ],
          { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }
        );

        let stderrMsg = '';
        ffmpegProc.stderr.on('data', (d: Buffer) => {
          stderrMsg = appendStderr(stderrMsg, d);
        });
        ytdlpProc.stdout.pipe(ffmpegProc.stdin);
        ytdlpProc.stdout.on('error', (err) => {
          if (!ffmpegProc.killed) ffmpegProc.kill('SIGKILL');
          ffmpegProc.stdout.destroy(err);
        });
        ffmpegProc.stdin.on('error', () => {});
        ffmpegProc.on('close', (code) => {
          if (code && code !== 0 && !ffmpegProc.stdout.destroyed) {
            ffmpegProc.stdout.destroy(
              new Error(`yt-dlp MP3 fallback exited ${code}: ${stderrMsg.slice(0, 200)}`)
            );
          }
        });

        const metered = attachByteMeter(ffmpegProc.stdout, options.onComplete);
        try {
          await assertReadableHasData(metered, 15_000);
        } catch (err) {
          metered.destroy();
          if (!ytdlpProc.killed) ytdlpProc.kill('SIGKILL');
          if (!ffmpegProc.killed) ffmpegProc.kill('SIGKILL');
          throw err;
        }
        return {
          stream: metered,
          contentType: 'audio/mpeg',
          filename: asset.filename.replace(/\.[^.]+$/, '.mp3'),
          cleanup: () => {
            if (!ytdlpProc.killed) ytdlpProc.kill('SIGKILL');
            if (!ffmpegProc.killed) ffmpegProc.kill('SIGKILL');
          },
        };
      }

      if (asset.kind === 'audio') {
        return openYtDlpFallback(asset, 'audio', options.onComplete);
      }

      return openYtDlpFallback(asset, 'video', options.onComplete);
    }

    throw new Error(`Upstream media returned HTTP ${upstreamRes.status}`);
  }

  const upstreamReadable = Readable.fromWeb(
    upstreamRes.body as unknown as WebReadableStream
  );
  const upstreamContentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();

  if (asset.kind === 'audio' && !shouldExtractMp3) {
    try {
      await assertReadableHasData(upstreamReadable);
    } catch (error) {
      upstreamReadable.destroy();
      if (asset.sourceUrl) {
        return openYtDlpFallback(asset, 'audio', options.onComplete);
      }
      throw error;
    }
  }

  // Strategy 2: On-the-fly MP3 extraction via FFmpeg pipe:0 -> pipe:1
  // Skip FFmpeg completely if the upstream response is already MP3 (zero-transcode pass-through)
  if (
    shouldExtractMp3 &&
    !upstreamContentType.includes('audio/mpeg') &&
    !upstreamContentType.includes('audio/mp3')
  ) {
    const ffmpegArgs = [
      '-loglevel',
      'error',
      '-fflags',
      '+flush_packets',
      '-i',
      'pipe:0',
      '-vn',
      '-sn',
      '-dn',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '3',
      '-compression_level',
      '2',
      '-id3v2_version',
      '3',
      ...(asset.title ? ['-metadata', `title=${asset.title.replace(/[\r\n]/g, ' ')}`] : []),
      ...(asset.author ? ['-metadata', `artist=${asset.author.replace(/[\r\n]/g, ' ')}`] : []),
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
      stderrMsg = appendStderr(stderrMsg, d);
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
    try {
      await assertReadableHasData(metered, 15_000);
    } catch (err) {
      metered.destroy();
      upstreamReadable.destroy();
      if (!proc.killed) proc.kill('SIGKILL');
      if (asset.sourceUrl) {
        return openYtDlpFallback(asset, 'audio', options.onComplete);
      }
      throw err;
    }
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

    let stderrMsg = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderrMsg = appendStderr(stderrMsg, d);
    });
    upstreamReadable.pipe(proc.stdin);
    upstreamReadable.on('error', (err) => {
      if (!proc.killed) proc.kill('SIGKILL');
      proc.stdout.destroy(err);
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => proc.stdout.destroy(err));
    proc.on('close', (code) => {
      if (code && code !== 0 && !proc.stdout.destroyed) {
        proc.stdout.destroy(
          new Error(`FFmpeg compression pipe exited ${code}: ${stderrMsg.slice(0, 200)}`)
        );
      }
    });

    const metered = attachByteMeter(proc.stdout, options.onComplete);
    try {
      await assertReadableHasData(metered, 20_000);
    } catch (err) {
      metered.destroy();
      upstreamReadable.destroy();
      if (!proc.killed) proc.kill('SIGKILL');
      const detail = stderrMsg.trim().slice(-400);
      throw new Error(
        detail
          ? `FFmpeg compression produced no media bytes: ${detail}`
          : `FFmpeg compression produced no media bytes: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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

  // Strategy 4: Pure zero-copy HTTP pass-through stream.
  // Validate the stream has data before returning it to avoid Telegram's
  // "file must be non-empty" error when CDN URLs silently return 0 bytes.
  const contentLengthHeader = upstreamRes.headers.get('content-length');
  const contentLength = contentLengthHeader
    ? Number(contentLengthHeader)
    : asset.estimatedBytes;

  const metered = attachByteMeter(upstreamReadable, options.onComplete);

  try {
    await assertReadableHasData(metered, 12_000);
  } catch (streamErr) {
    metered.destroy();
    // If we have the original source URL, re-download via yt-dlp stdout as a
    // last-resort fallback rather than propagating a confusing "empty file" error.
    if (asset.sourceUrl) {
      return openYtDlpFallback(
        asset,
        asset.kind === 'audio' || shouldExtractMp3 ? 'audio' : 'video',
        options.onComplete
      );
    }
    throw streamErr;
  }

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
