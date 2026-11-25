export type PlatformId =
  | 'instagram'
  | 'tiktok'
  | 'twitter'
  | 'reddit'
  | 'tumblr'
  | 'youtube'
  | 'youtube_shorts'
  | 'youtube_music';

export type MediaKind = 'video' | 'photo' | 'animation' | 'audio';

export type StreamStrategy =
  | 'direct_http'
  | 'ffmpeg_mux_dash'
  | 'ffmpeg_extract_mp3'
  | 'ffmpeg_compress'
  | 'ytdlp_stdout';

export type YouTubeQuality = '360' | '720' | '1080';
export type BotMediaMode = 'video' | 'music' | 'both';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  title: string;
  author?: string;
  platform: PlatformId;
  sourceUrl: string;
  streamUrl: string;
  audioStreamUrl?: string;
  thumbnailUrl?: string;
  filename: string;
  mimeType: string;
  ext: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  estimatedBytes?: number;
  exceedsLimit: boolean;
  limitBytes: number;
  strategy: StreamStrategy;
  resolutionLabel?: string;
}

export interface ExtractionResult {
  platform: PlatformId;
  sourceUrl: string;
  title: string;
  author?: string;
  extractorUsed: string;
  extractionMs: number;
  isCarousel: boolean;
  hasSeparateAudio: boolean;
  assets: MediaAsset[];
  warnings: string[];
}

export interface BotStatusSnapshot {
  running: boolean;
  botUsername: string | null;
  botId: number | null;
  apiRoot: string;
  limitMb: number;
  concurrency: number;
  youtubeQuality: YouTubeQuality;
  mediaMode: BotMediaMode;
  autoCompressOverLimit: boolean;
  hasToken: boolean;
  hasProxy: boolean;
  hasCookies: boolean;
  startedAt: number | null;
  lastError: string | null;
}

export interface StreamEventLog {
  id: string;
  timestamp: number;
  source: 'telegram' | 'sandbox' | 'system';
  level: 'info' | 'success' | 'warning' | 'error';
  platform?: PlatformId;
  chatLabel?: string;
  message: string;
  bytesStreamed?: number;
  durationMs?: number;
}

export interface TelemetrySnapshot {
  streamsCompleted: number;
  streamsFailed: number;
  bytesStreamed: number;
  diskBytesWritten: 0;
  activeWorkers: number;
  peakThroughputMbps: number;
  recentEvents: StreamEventLog[];
}

export interface ExportedFile {
  path: string;
  language: 'python' | 'text' | 'dockerfile' | 'markdown';
  description: string;
  content: string;
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) {
    return 'Streamed';
  }
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, idx);
  return `${val >= 100 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  twitter: 'Twitter / X',
  reddit: 'Reddit',
  tumblr: 'Tumblr',
  youtube: 'YouTube',
  youtube_shorts: 'YouTube Shorts',
  youtube_music: 'YouTube Music',
};

export const STRATEGY_LABELS: Record<StreamStrategy, string> = {
  direct_http: 'Direct HTTP Pipe',
  ffmpeg_mux_dash: 'FFmpeg DASH Mux Pipe',
  ffmpeg_extract_mp3: 'FFmpeg MP3 Audio Pipe',
  ffmpeg_compress: 'FFmpeg Transcode Pipe',
  ytdlp_stdout: 'Extractor Stdout Pipe',
};
