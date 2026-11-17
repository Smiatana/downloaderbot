export type PlatformId =
  | 'instagram'
  | 'tiktok'
  | 'twitter'
  | 'reddit'
  | 'tumblr'
  | 'youtube'
  | 'youtube_shorts';

export type MediaKind = 'video' | 'photo' | 'animation' | 'audio';

export type StreamStrategy =
  | 'direct_http'
  | 'ffmpeg_mux_dash'
  | 'ffmpeg_extract_mp3'
  | 'ffmpeg_compress'
  | 'ytdlp_stdout';

export type YouTubeQuality = '360' | '720' | '1080';

export interface ParsedMediaUrl {
  platform: PlatformId;
  originalUrl: string;
  normalizedUrl: string;
  hostname: string;
}

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
  headers?: Record<string, string>;
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

export interface ExtractionOptions {
  youtubeQuality?: YouTubeQuality;
  maxLimitBytes?: number;
  proxyUrl?: string;
  cookiesHeader?: string;
}

export interface BotConfig {
  token: string;
  apiRoot: string;
  concurrency: number;
  youtubeQuality: YouTubeQuality;
  autoCompressOverLimit: boolean;
  proxyUrl: string;
  cookiesHeader: string;
}

export interface BotStatusSnapshot {
  running: boolean;
  botUsername: string | null;
  botId: number | null;
  apiRoot: string;
  limitMb: number;
  concurrency: number;
  youtubeQuality: YouTubeQuality;
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
