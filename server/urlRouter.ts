import type { ParsedMediaUrl, PlatformId } from './types.ts';

const PRIVATE_IP_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
];

const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

const PLATFORM_DOMAIN_RULES: Array<{
  platform: PlatformId;
  match: (hostname: string, pathname: string) => boolean;
}> = [
  {
    platform: 'youtube_music',
    match: (host) => host === 'music.youtube.com',
  },
  {
    platform: 'youtube_shorts',
    match: (host, path) =>
      (host === 'youtube.com' || host.endsWith('.youtube.com')) &&
      /^\/shorts\/[A-Za-z0-9_-]{5,}/i.test(path),
  },
  {
    platform: 'youtube',
    match: (host) =>
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be',
  },
  {
    platform: 'instagram',
    match: (host) =>
      host === 'instagram.com' ||
      host.endsWith('.instagram.com') ||
      host === 'instagr.am' ||
      host.endsWith('.instagr.am') ||
      host === 'kkinstagram.com' ||
      host.endsWith('.kkinstagram.com'),
  },
  {
    platform: 'tiktok',
    match: (host) =>
      host === 'tiktok.com' ||
      host.endsWith('.tiktok.com') ||
      host === 'vxtiktok.com' ||
      host.endsWith('.vxtiktok.com'),
  },
  {
    platform: 'twitter',
    match: (host) =>
      host === 'twitter.com' ||
      host.endsWith('.twitter.com') ||
      host === 'x.com' ||
      host.endsWith('.x.com') ||
      host === 'fxtwitter.com' ||
      host === 'vxtwitter.com',
  },
  {
    platform: 'reddit',
    match: (host) =>
      host === 'reddit.com' ||
      host.endsWith('.reddit.com') ||
      host === 'redd.it' ||
      host === 'v.redd.it' ||
      host === 'i.redd.it',
  },
  {
    platform: 'tumblr',
    match: (host) =>
      host === 'tumblr.com' ||
      host.endsWith('.tumblr.com'),
  },
];

const URL_EXTRACT_REGEX = /https?:\/\/[^\s<>"'`)\]]+/gi;

export function isPrivateOrUnsafeHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(lower));
}

export function sanitizeAndParseUrl(rawInput: string): ParsedMediaUrl | null {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const trimmed = rawInput.trim();
  if (trimmed.length > 2048 || CONTROL_CHAR_REGEX.test(trimmed)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!hostname || isPrivateOrUnsafeHost(hostname)) {
    return null;
  }

  const rule = PLATFORM_DOMAIN_RULES.find((entry) =>
    entry.match(hostname, parsed.pathname)
  );
  if (!rule) {
    return null;
  }

  // Strip noisy tracking params while preserving essential video identifiers
  const trackingParams = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'igsh',
    'igshid',
    'fqnt',
    'fbclid',
    'si',
    's',
    't',
  ];
  const cleanUrlObj = new URL(parsed.toString());
  const tiktokShortPath = cleanUrlObj.pathname.match(/^\/([A-Za-z0-9_-]{6,})\/?$/);
  if (
    hostname === 'vxtiktok.com' ||
    (hostname === 'tiktok.com' && tiktokShortPath)
  ) {
    cleanUrlObj.hostname = 'vm.tiktok.com';
    if (tiktokShortPath) cleanUrlObj.pathname = `/${tiktokShortPath[1]}/`;
  } else if (hostname === 'kkinstagram.com') {
    cleanUrlObj.hostname = 'www.instagram.com';
  }
  const isYouTubeFamily =
    rule.platform === 'youtube' ||
    rule.platform === 'youtube_shorts' ||
    rule.platform === 'youtube_music';
  if (!isYouTubeFamily) {
    for (const key of trackingParams) {
      cleanUrlObj.searchParams.delete(key);
    }
  } else {
    // Preserve 'v', 'list', and 't' on YouTube platforms, strip tracking params
    for (const key of trackingParams) {
      if (key !== 't') cleanUrlObj.searchParams.delete(key);
    }
  }

  return {
    platform: rule.platform,
    originalUrl: trimmed,
    normalizedUrl: cleanUrlObj.toString(),
    hostname,
  };
}

export function extractSupportedUrlsFromText(text: string): ParsedMediaUrl[] {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(URL_EXTRACT_REGEX) ?? [];
  const seen = new Set<string>();
  const results: ParsedMediaUrl[] = [];

  for (const candidate of matches) {
    const cleaned = candidate.replace(/[.,!?;:]+$/, '');
    const parsed = sanitizeAndParseUrl(cleaned);
    if (parsed && !seen.has(parsed.normalizedUrl)) {
      seen.add(parsed.normalizedUrl);
      results.push(parsed);
    }
  }

  return results;
}

export function assertSafeUpstreamMediaUrl(rawUrl: string): URL {
  if (!rawUrl || CONTROL_CHAR_REGEX.test(rawUrl)) {
    throw new Error('Rejected unsafe upstream media URL.');
  }
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Upstream media URL must use HTTP or HTTPS.');
  }
  if (isPrivateOrUnsafeHost(parsed.hostname)) {
    throw new Error('Upstream media URL points to a restricted host.');
  }
  return parsed;
}
