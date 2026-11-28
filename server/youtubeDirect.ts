import { randomUUID } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import type {
  ExtractionOptions,
  ExtractionResult,
  MediaAsset,
  ParsedMediaUrl,
  PlatformId,
  YouTubeQuality,
} from './types.ts';

const youtubeHttpAgent = new Agent({
  connections: 24,
  keepAliveTimeout: 20_000,
  connectTimeout: 10_000,
});

const DEFAULT_LIMIT_BYTES = 50 * 1024 * 1024;
const DEFAULT_INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface InnerTubeClientProfile {
  name: string;
  userAgent: string;
  clientNameHeader: string;
  clientVersion: string;
  contextClient: Record<string, unknown>;
}

const INNERTUBE_CLIENTS: InnerTubeClientProfile[] = [
  {
    name: 'ANDROID_VR',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    clientNameHeader: '28',
    clientVersion: '1.60.19',
    contextClient: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12L',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'IOS',
    userAgent:
      'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    clientNameHeader: '5',
    clientVersion: '20.10.4',
    contextClient: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'ANDROID',
    userAgent:
      'com.google.android.youtube/20.10.38 (Linux; U; Android 15; en_US) gzip',
    clientNameHeader: '3',
    clientVersion: '20.10.38',
    contextClient: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      androidSdkVersion: 35,
      osName: 'Android',
      osVersion: '15',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'MWEB',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Mobile/15E148 Safari/604.1',
    clientNameHeader: '2',
    clientVersion: '2.20250311.03.00',
    contextClient: {
      clientName: 'MWEB',
      clientVersion: '2.20250311.03.00',
      hl: 'en',
      gl: 'US',
    },
  },
];

export interface InnerTubeFormat {
  itag?: number;
  url?: string;
  mimeType?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  contentLength?: string;
  approxDurationMs?: string;
  audioQuality?: string;
  qualityLabel?: string;
}

export interface InnerTubePlayerResponse {
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
    thumbnail?: {
      thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
    };
  };
  streamingData?: {
    formats?: InnerTubeFormat[];
    adaptiveFormats?: InnerTubeFormat[];
  };
}

function sanitizeFilename(base: string, ext: string): string {
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72);
  return `${cleaned || 'media'}.${ext.replace(/[^a-z0-9]/gi, '') || 'mp4'}`;
}

function cleanAuthor(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/\s*-\s*Topic$/i, '').trim() || undefined;
}

export function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.hostname.replace(/^www\./, '') === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id || null;
    }
    const v = u.searchParams.get('v');
    if (v) return v;
    const pathMatch = u.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,})/);
    return pathMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

export function extractYouTubePlaylistId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const list = u.searchParams.get('list');
    return list && list.length >= 4 ? list : null;
  } catch {
    return null;
  }
}

function parseContentLength(raw?: string): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isMp4Format(fmt: InnerTubeFormat): boolean {
  return Boolean(fmt.mimeType?.toLowerCase().includes('video/mp4'));
}

function isAudioFormat(fmt: InnerTubeFormat): boolean {
  return Boolean(fmt.mimeType?.toLowerCase().startsWith('audio/'));
}

function isM4aAudioFormat(fmt: InnerTubeFormat): boolean {
  const mime = fmt.mimeType?.toLowerCase() ?? '';
  return mime.includes('audio/mp4') || mime.includes('mp4a');
}

export function buildAssetsFromInnerTubePlayer(
  player: InnerTubePlayerResponse,
  options: {
    platform: PlatformId;
    sourceUrl: string;
    quality: YouTubeQuality;
    maxLimitBytes: number;
    streamHeaders: Record<string, string>;
  }
): {
  title: string;
  author?: string;
  assets: MediaAsset[];
} {
  const title = player.videoDetails?.title?.trim() || 'YouTube Media';
  const author = cleanAuthor(player.videoDetails?.author);
  const durationSeconds = Number(player.videoDetails?.lengthSeconds);
  const validDuration =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : undefined;
  const thumbnails = player.videoDetails?.thumbnail?.thumbnails ?? [];
  const thumbnailUrl = thumbnails[thumbnails.length - 1]?.url;

  const progressive = (player.streamingData?.formats ?? [])
    .filter((f) => Boolean(f.url) && isMp4Format(f))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));

  const adaptive = player.streamingData?.adaptiveFormats ?? [];
  const videoOnly = adaptive
    .filter((f) => Boolean(f.url) && f.mimeType?.toLowerCase().startsWith('video/'))
    .sort((a, b) => {
      const aMp4 = isMp4Format(a) ? 1 : 0;
      const bMp4 = isMp4Format(b) ? 1 : 0;
      if (aMp4 !== bMp4) return bMp4 - aMp4;
      return (b.height ?? 0) - (a.height ?? 0);
    });

  const audioOnly = adaptive
    .filter((f) => Boolean(f.url) && isAudioFormat(f))
    .sort((a, b) => {
      const aM4a = isM4aAudioFormat(a) ? 1 : 0;
      const bM4a = isM4aAudioFormat(b) ? 1 : 0;
      if (aM4a !== bM4a) return bM4a - aM4a;
      return (b.bitrate ?? 0) - (a.bitrate ?? 0);
    });

  const targetHeight = Number(options.quality);
  const assets: MediaAsset[] = [];

  if (options.platform === 'youtube_music') {
    // Download progressive video (or audio stream fallback) and extract MP3 via FFmpeg
    const sourceFmt = progressive[0] ?? audioOnly[0];
    if (sourceFmt?.url) {
      const est = parseContentLength(sourceFmt.contentLength);
      assets.push({
        id: randomUUID(),
        kind: 'audio',
        title,
        author,
        platform: 'youtube_music',
        sourceUrl: options.sourceUrl,
        streamUrl: sourceFmt.url,
        thumbnailUrl,
        filename: sanitizeFilename(title, 'mp3'),
        mimeType: 'audio/mpeg',
        ext: 'mp3',
        durationSeconds: validDuration,
        estimatedBytes: est,
        exceedsLimit: typeof est === 'number' && est > options.maxLimitBytes,
        limitBytes: options.maxLimitBytes,
        strategy: 'ffmpeg_extract_mp3',
        headers: options.streamHeaders,
      });
    }
    return { title, author, assets };
  }

  let videoStreamUrlForAudio: string | undefined;

  const fittingProgressive = progressive.filter(
    (f) => (f.height ?? 0) <= targetHeight
  );
  const chosenProg =
    fittingProgressive.find((f) => {
      const sz = parseContentLength(f.contentLength);
      return !sz || sz <= options.maxLimitBytes;
    }) ??
    fittingProgressive[0] ??
    progressive[0];

  if (
    chosenProg?.url &&
    (targetHeight <= 720 || videoOnly.length === 0 || (chosenProg.height ?? 0) >= targetHeight)
  ) {
    const est = parseContentLength(chosenProg.contentLength);
    videoStreamUrlForAudio = chosenProg.url;
    assets.push({
      id: randomUUID(),
      kind: 'video',
      title,
      author,
      platform: options.platform,
      sourceUrl: options.sourceUrl,
      streamUrl: chosenProg.url,
      thumbnailUrl,
      filename: sanitizeFilename(title, 'mp4'),
      mimeType: 'video/mp4',
      ext: 'mp4',
      width: chosenProg.width,
      height: chosenProg.height,
      durationSeconds: validDuration,
      estimatedBytes: est,
      exceedsLimit: typeof est === 'number' && est > options.maxLimitBytes,
      limitBytes: options.maxLimitBytes,
      strategy: 'direct_http',
      headers: options.streamHeaders,
      resolutionLabel: chosenProg.height ? `${chosenProg.height}p` : undefined,
    });
  } else if (videoOnly.length > 0 && audioOnly.length > 0) {
    const vMatch =
      videoOnly.find((f) => (f.height ?? 0) <= targetHeight) ?? videoOnly[0];
    const aMatch = audioOnly.find(isM4aAudioFormat) ?? audioOnly[0];
    if (vMatch?.url && aMatch?.url) {
      const vEst = parseContentLength(vMatch.contentLength) ?? 0;
      const aEst = parseContentLength(aMatch.contentLength) ?? 0;
      const totalEst = vEst + aEst > 0 ? vEst + aEst : undefined;
      videoStreamUrlForAudio = chosenProg?.url ?? aMatch.url;
      assets.push({
        id: randomUUID(),
        kind: 'video',
        title,
        author,
        platform: options.platform,
        sourceUrl: options.sourceUrl,
        streamUrl: vMatch.url,
        audioStreamUrl: aMatch.url,
        audioExt: isM4aAudioFormat(aMatch) ? 'm4a' : 'webm',
        thumbnailUrl,
        filename: sanitizeFilename(title, 'mp4'),
        mimeType: 'video/mp4',
        ext: 'mp4',
        width: vMatch.width,
        height: vMatch.height,
        durationSeconds: validDuration,
        estimatedBytes: totalEst,
        exceedsLimit: typeof totalEst === 'number' && totalEst > options.maxLimitBytes,
        limitBytes: options.maxLimitBytes,
        strategy: 'ffmpeg_mux_dash',
        headers: options.streamHeaders,
        resolutionLabel: vMatch.height ? `${vMatch.height}p` : undefined,
      });
    }
  } else if (chosenProg?.url) {
    const est = parseContentLength(chosenProg.contentLength);
    videoStreamUrlForAudio = chosenProg.url;
    assets.push({
      id: randomUUID(),
      kind: 'video',
      title,
      author,
      platform: options.platform,
      sourceUrl: options.sourceUrl,
      streamUrl: chosenProg.url,
      thumbnailUrl,
      filename: sanitizeFilename(title, 'mp4'),
      mimeType: 'video/mp4',
      ext: 'mp4',
      width: chosenProg.width,
      height: chosenProg.height,
      durationSeconds: validDuration,
      estimatedBytes: est,
      exceedsLimit: typeof est === 'number' && est > options.maxLimitBytes,
      limitBytes: options.maxLimitBytes,
      strategy: 'direct_http',
      headers: options.streamHeaders,
      resolutionLabel: chosenProg.height ? `${chosenProg.height}p` : undefined,
    });
  }

  // Extract MP3 audio from the video stream (or audio stream fallback) via FFmpeg
  const audioExtractSource = videoStreamUrlForAudio ?? audioOnly[0]?.url;
  if (audioExtractSource) {
    assets.push({
      id: randomUUID(),
      kind: 'audio',
      title: `${title} (Audio)`,
      author,
      platform: options.platform,
      sourceUrl: options.sourceUrl,
      streamUrl: audioExtractSource,
      thumbnailUrl,
      filename: sanitizeFilename(`${title}_audio`, 'mp3'),
      mimeType: 'audio/mpeg',
      ext: 'mp3',
      durationSeconds: validDuration,
      exceedsLimit: false,
      limitBytes: options.maxLimitBytes,
      strategy: 'ffmpeg_extract_mp3',
      headers: options.streamHeaders,
    });
  }

  return { title, author, assets };
}

export function extractBalancedJsonObject(
  text: string,
  startSearchIdx: number
): string | null {
  const openIdx = text.indexOf('{', startSearchIdx);
  if (openIdx === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openIdx, i + 1);
      }
    }
  }
  return null;
}

export function parseWatchPageBootstrap(html: string): {
  apiKey: string;
  visitorData?: string;
  playerResponse?: InnerTubePlayerResponse;
} {
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  const visitorMatch = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/);
  let playerResponse: InnerTubePlayerResponse | undefined;

  for (const marker of [
    'var ytInitialPlayerResponse = ',
    'window["ytInitialPlayerResponse"] = ',
    'ytInitialPlayerResponse = ',
  ]) {
    const idx = html.indexOf(marker);
    if (idx !== -1) {
      const jsonText = extractBalancedJsonObject(html, idx + marker.length);
      if (jsonText) {
        try {
          playerResponse = JSON.parse(jsonText) as InnerTubePlayerResponse;
          break;
        } catch {
          // Try next marker
        }
      }
    }
  }

  return {
    apiKey: apiKeyMatch?.[1] || DEFAULT_INNERTUBE_API_KEY,
    visitorData: visitorMatch?.[1],
    playerResponse,
  };
}

async function fetchWatchPageBootstrap(
  videoId: string,
  cookiesHeader?: string
): Promise<{
  apiKey: string;
  visitorData?: string;
  playerResponse?: InnerTubePlayerResponse;
}> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (cookiesHeader?.trim()) {
    headers.Cookie = cookiesHeader.trim();
  }

  try {
    const res = await undiciFetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000),
      dispatcher: youtubeHttpAgent,
    });
    if (!res.ok) {
      return { apiKey: DEFAULT_INNERTUBE_API_KEY };
    }
    const html = await res.text();
    return parseWatchPageBootstrap(html);
  } catch {
    return { apiKey: DEFAULT_INNERTUBE_API_KEY };
  }
}

async function fetchInnerTubePlayer(
  videoId: string,
  profile: InnerTubeClientProfile,
  bootstrap: { apiKey: string; visitorData?: string },
  cookiesHeader?: string
): Promise<InnerTubePlayerResponse> {
  const endpoint = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(bootstrap.apiKey)}&prettyPrint=false`;

  const clientContext: Record<string, unknown> = {
    ...profile.contextClient,
    ...(bootstrap.visitorData ? { visitorData: bootstrap.visitorData } : {}),
  };

  const body: Record<string, unknown> = {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: clientContext,
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': profile.userAgent,
    'X-YouTube-Client-Name': profile.clientNameHeader,
    'X-YouTube-Client-Version': profile.clientVersion,
    Origin: 'https://www.youtube.com',
  };
  if (bootstrap.visitorData) {
    headers['X-Goog-Visitor-Id'] = bootstrap.visitorData;
  }
  if (cookiesHeader?.trim()) {
    headers.Cookie = cookiesHeader.trim();
  }

  const res = await undiciFetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    dispatcher: youtubeHttpAgent,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const snippet = errText.replace(/\s+/g, ' ').slice(0, 140);
    throw new Error(
      `InnerTube ${profile.name} returned HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`
    );
  }
  return (await res.json()) as InnerTubePlayerResponse;
}

async function fetchYouTubeMusicPlaylistVideoIds(
  listId: string,
  cookiesHeader?: string
): Promise<string[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
    'X-YouTube-Client-Name': '67',
    'X-YouTube-Client-Version': '1.20241120.01.00',
    Origin: 'https://music.youtube.com',
    Referer: 'https://music.youtube.com/',
  };
  if (cookiesHeader?.trim()) {
    headers.Cookie = cookiesHeader.trim();
  }

  const browseId = listId.startsWith('VL') ? listId : `VL${listId}`;
  const res = await undiciFetch(
    'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        browseId,
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20241120.01.00',
            hl: 'en',
            gl: 'US',
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
      dispatcher: youtubeHttpAgent,
    }
  );
  if (!res.ok) {
    throw new Error(`YouTube Music playlist browse returned HTTP ${res.status}`);
  }
  const text = await res.text();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
      if (ids.length >= 20) break;
    }
  }
  return ids;
}

async function resolveSingleYouTubeVideo(
  videoId: string,
  parsedUrl: ParsedMediaUrl,
  options: ExtractionOptions
): Promise<{
  title: string;
  author?: string;
  assets: MediaAsset[];
  extractorUsed: string;
}> {
  const maxLimitBytes = options.maxLimitBytes ?? DEFAULT_LIMIT_BYTES;
  const quality = options.youtubeQuality ?? '720';
  const errors: string[] = [];

  const bootstrap = await fetchWatchPageBootstrap(videoId, options.cookiesHeader);

  for (const profile of INNERTUBE_CLIENTS) {
    try {
      const player = await fetchInnerTubePlayer(
        videoId,
        profile,
        bootstrap,
        options.cookiesHeader
      );
      const status = player.playabilityStatus?.status;
      if (status && status !== 'OK') {
        errors.push(
          `${profile.name}: ${status} (${player.playabilityStatus?.reason ?? 'unplayable'})`
        );
        continue;
      }

      const streamHeaders: Record<string, string> = {
        'User-Agent': profile.userAgent,
        ...(options.cookiesHeader?.trim()
          ? { Cookie: options.cookiesHeader.trim() }
          : {}),
      };
      const built = buildAssetsFromInnerTubePlayer(player, {
        platform: parsedUrl.platform,
        sourceUrl: parsedUrl.normalizedUrl,
        quality,
        maxLimitBytes,
        streamHeaders,
      });

      if (built.assets.length > 0) {
        return {
          ...built,
          extractorUsed: `innertube-${profile.name.toLowerCase()}`,
        };
      }
      errors.push(`${profile.name}: no direct stream URLs`);
    } catch (err) {
      errors.push(`${profile.name}: ${(err as Error).message}`);
    }
  }

  // Fallback to watch page ytInitialPlayerResponse if it has direct URLs
  if (bootstrap.playerResponse?.streamingData) {
    const built = buildAssetsFromInnerTubePlayer(bootstrap.playerResponse, {
      platform: parsedUrl.platform,
      sourceUrl: parsedUrl.normalizedUrl,
      quality,
      maxLimitBytes,
      streamHeaders: {
        'User-Agent': BROWSER_USER_AGENT,
        Referer: 'https://www.youtube.com/',
      },
    });
    if (built.assets.length > 0) {
      return {
        ...built,
        extractorUsed: 'youtube-watch-html',
      };
    }
  }

  throw new Error(
    `Direct YouTube extraction failed: ${errors.join(' | ') || 'no playable streams found'}`
  );
}

export async function extractYouTubeDirect(
  parsedUrl: ParsedMediaUrl,
  options: ExtractionOptions = {}
): Promise<ExtractionResult> {
  const start = Date.now();
  const videoId = extractYouTubeVideoId(parsedUrl.normalizedUrl);

  if (videoId) {
    const resolved = await resolveSingleYouTubeVideo(videoId, parsedUrl, options);
    return {
      platform: parsedUrl.platform,
      sourceUrl: parsedUrl.normalizedUrl,
      title: resolved.title,
      author: resolved.author,
      extractorUsed: resolved.extractorUsed,
      extractionMs: Date.now() - start,
      isCarousel: resolved.assets.filter((a) => a.kind !== 'audio').length > 1,
      hasSeparateAudio: resolved.assets.some((a) => a.kind === 'audio'),
      assets: resolved.assets,
      warnings: [],
    };
  }

  if (parsedUrl.platform === 'youtube_music') {
    const listId = extractYouTubePlaylistId(parsedUrl.normalizedUrl);
    if (listId) {
      const videoIds = await fetchYouTubeMusicPlaylistVideoIds(
        listId,
        options.cookiesHeader
      );
      if (videoIds.length === 0) {
        throw new Error('No tracks found in YouTube Music playlist.');
      }
      const trackResults = await Promise.allSettled(
        videoIds.map((id) =>
          resolveSingleYouTubeVideo(
            id,
            {
              ...parsedUrl,
              normalizedUrl: `https://music.youtube.com/watch?v=${id}`,
            },
            options
          )
        )
      );
      const assets: MediaAsset[] = [];
      for (const res of trackResults) {
        if (res.status === 'fulfilled') {
          assets.push(...res.value.assets);
        }
      }
      if (assets.length === 0) {
        throw new Error('Could not resolve playable streams for playlist tracks.');
      }
      return {
        platform: 'youtube_music',
        sourceUrl: parsedUrl.normalizedUrl,
        title: `YouTube Music Playlist (${assets.length} tracks)`,
        extractorUsed: 'innertube-playlist',
        extractionMs: Date.now() - start,
        isCarousel: false,
        hasSeparateAudio: true,
        assets,
        warnings: [],
      };
    }
  }

  throw new Error('Could not extract YouTube video ID from URL.');
}
