import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import JSZip from 'jszip';
import {
  assertSafeUpstreamMediaUrl,
  extractSupportedUrlsFromText,
  isPrivateOrUnsafeHost,
  sanitizeAndParseUrl,
} from '../server/urlRouter.ts';
import {
  buildAssetsFromTikWmData,
  buildAssetsFromYtDlpPayload,
  getTermuxYtDlpPath,
  getYtDlpReleaseUrl,
  parseTikTokHtmlPayload,
  pickBestAudioFormat,
  pickFormatsForEntry,
  type YtDlpEntry,
} from '../server/extractor.ts';
import { getPythonBotFiles } from '../server/pythonGenerator.ts';
import {
  buildMediaOptionsKeyboard,
  telegramBotManager,
} from '../server/telegramBot.ts';
import { telemetry } from '../server/telemetry.ts';

const LIMIT_50MB = 50 * 1024 * 1024;

function runFfmpegToBuffer(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, {
      shell: false,
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      }
    });
    if (input && proc.stdin) {
      proc.stdin.on('error', () => {});
      proc.stdin.end(input);
    }
  });
}

test('URL Router: recognizes all 8 supported platforms including YouTube Music', () => {
  const cases: Array<[string, string]> = [
    ['https://www.instagram.com/reel/Cx123456789/?igsh=abc', 'instagram'],
    ['https://instagr.am/p/AbCdEf123/', 'instagram'],
    ['https://www.tiktok.com/@creator/video/7123456789012345678', 'tiktok'],
    ['https://vm.tiktok.com/ZM123456/', 'tiktok'],
    ['https://vt.tiktok.com/ZS123456/', 'tiktok'],
    ['https://twitter.com/nasa/status/123456789', 'twitter'],
    ['https://x.com/nasa/status/123456789?s=20', 'twitter'],
    ['https://fxtwitter.com/nasa/status/123456789', 'twitter'],
    ['https://www.reddit.com/r/aww/comments/abc123/cute/', 'reddit'],
    ['https://redd.it/abc123', 'reddit'],
    ['https://v.redd.it/xyz987', 'reddit'],
    ['https://staff.tumblr.com/post/123456789/hello', 'tumblr'],
    ['https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=12s&si=track', 'youtube'],
    ['https://youtu.be/aqz-KE-bpKQ?si=track', 'youtube'],
    ['https://www.youtube.com/shorts/aqz-KE-bpKQ?si=track', 'youtube_shorts'],
    ['https://music.youtube.com/watch?v=aqz-KE-bpKQ&list=RDAMVMaqz-KE-bpKQ&si=track', 'youtube_music'],
    ['https://music.youtube.com/playlist?list=OLAK5uy_example123', 'youtube_music'],
  ];

  for (const [url, expectedPlatform] of cases) {
    const parsed = sanitizeAndParseUrl(url);
    assert.ok(parsed, `Expected ${url} to parse`);
    assert.equal(parsed.platform, expectedPlatform, `Wrong platform for ${url}`);
  }
});

test('Extractor: selects a yt-dlp release matching x86_64 and ARM64', () => {
  assert.equal(
    getYtDlpReleaseUrl('x64'),
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux'
  );
  assert.equal(
    getYtDlpReleaseUrl('arm64'),
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64'
  );
  assert.throws(() => getYtDlpReleaseUrl('arm'), /not available for CPU architecture/);
});

test('Extractor: uses the Termux yt-dlp package path only in Termux', () => {
  assert.equal(getTermuxYtDlpPath('/data/data/com.termux/files/usr'),
    '/data/data/com.termux/files/usr/bin/yt-dlp');
  assert.equal(getTermuxYtDlpPath(undefined, '0.118.0'),
    '/data/data/com.termux/files/usr/bin/yt-dlp');
  assert.equal(getTermuxYtDlpPath('/usr'), undefined);
});

test('URL Router: strips tracking params and preserves v/list/t on YouTube family', () => {
  const yt = sanitizeAndParseUrl(
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=42&utm_source=x&si=share123'
  );
  assert.ok(yt);
  const ytUrl = new URL(yt.normalizedUrl);
  assert.equal(ytUrl.searchParams.get('v'), 'aqz-KE-bpKQ');
  assert.equal(ytUrl.searchParams.get('t'), '42');
  assert.equal(ytUrl.searchParams.get('utm_source'), null);
  assert.equal(ytUrl.searchParams.get('si'), null);

  const ytm = sanitizeAndParseUrl(
    'https://music.youtube.com/watch?v=aqz-KE-bpKQ&list=OLAK5uy_123&si=share123&t=5'
  );
  assert.ok(ytm);
  const ytmUrl = new URL(ytm.normalizedUrl);
  assert.equal(ytmUrl.searchParams.get('v'), 'aqz-KE-bpKQ');
  assert.equal(ytmUrl.searchParams.get('list'), 'OLAK5uy_123');
  assert.equal(ytmUrl.searchParams.get('t'), '5');
  assert.equal(ytmUrl.searchParams.get('si'), null);

  const ig = sanitizeAndParseUrl('https://www.instagram.com/reel/Abc/?igsh=foo&utm_medium=copy');
  assert.ok(ig);
  assert.equal(ig.normalizedUrl, 'https://www.instagram.com/reel/Abc/');
});

test('URL Router: blocks SSRF private/loopback hosts, control chars, and invalid protocols', () => {
  const blocked = [
    'http://localhost:3000/test',
    'https://127.0.0.1/watch?v=1',
    'https://10.0.0.5/video',
    'https://192.168.1.10/video',
    'https://172.16.0.1/video',
    'https://youtube.com.local/watch?v=1',
    'https://internal.service.internal/foo',
    'ftp://youtube.com/watch?v=1',
    'javascript:alert(1)',
    'https://youtube.com/watch?v=1\nrm -rf /',
    `https://youtube.com/watch?v=${'a'.repeat(2100)}`,
    'https://example.com/not-supported',
  ];

  for (const url of blocked) {
    assert.equal(sanitizeAndParseUrl(url), null, `Should reject ${url}`);
  }

  assert.equal(isPrivateOrUnsafeHost('127.0.0.1'), true);
  assert.equal(isPrivateOrUnsafeHost('youtube.com'), false);
  assert.throws(() => assertSafeUpstreamMediaUrl('http://127.0.0.1/video.mp4'));
  assert.throws(() => assertSafeUpstreamMediaUrl('file:///etc/passwd'));
  assert.doesNotThrow(() =>
    assertSafeUpstreamMediaUrl('https://cdn.example.com/media.mp4')
  );
});

test('URL Router: extracts multiple deduplicated URLs from chat message text', () => {
  const text =
    'Look at https://music.youtube.com/watch?v=abc123, also https://www.instagram.com/reel/XYZ123/! And duplicate https://music.youtube.com/watch?v=abc123.';
  const found = extractSupportedUrlsFromText(text);
  assert.equal(found.length, 2);
  assert.equal(found[0].platform, 'youtube_music');
  assert.equal(found[1].platform, 'instagram');
});

test('Extractor (YouTube & Shorts): emits video + original audio stream from audio-only format', async () => {
  const entry: YtDlpEntry = {
    id: 'aqz-KE-bpKQ',
    title: 'Big Buck Bunny',
    track: 'Big Buck Bunny Theme',
    artist: 'Blender Foundation',
    uploader: 'Blender Foundation',
    duration: 60,
    thumbnail: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
    formats: [
      {
        format_id: '137',
        url: 'https://cdn.example.com/video-1080p.mp4',
        ext: 'mp4',
        vcodec: 'avc1.640028',
        acodec: 'none',
        width: 1920,
        height: 1080,
        filesize: 25_000_000,
      },
      {
        format_id: '22',
        url: 'https://cdn.example.com/video-720p.mp4',
        ext: 'mp4',
        vcodec: 'avc1.64001F',
        acodec: 'mp4a.40.2',
        width: 1280,
        height: 720,
        filesize: 15_000_000,
      },
      {
        format_id: '140',
        url: 'https://cdn.example.com/audio-128k.m4a',
        ext: 'm4a',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        abr: 128,
        tbr: 128,
        filesize: 2_000_000,
      },
    ],
  };

  // 720p progressive + MP3 audio
  const yt720 = await buildAssetsFromYtDlpPayload(
    entry,
    sanitizeAndParseUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ')!,
    '720',
    LIMIT_50MB,
    { skipHeadProbe: true }
  );
  assert.equal(yt720.assets.length, 2);
  assert.equal(yt720.assets[0].kind, 'video');
  assert.equal(yt720.assets[0].strategy, 'direct_http');
  assert.equal(yt720.assets[0].streamUrl, 'https://cdn.example.com/video-720p.mp4');
  assert.equal(yt720.assets[1].kind, 'audio');
  assert.equal(yt720.assets[1].ext, 'm4a');
  assert.equal(yt720.assets[1].strategy, 'direct_http');
  // Audio should stream directly from the lightweight audio-only M4A, not the video!
  assert.equal(yt720.assets[1].streamUrl, 'https://cdn.example.com/audio-128k.m4a');
  assert.equal(yt720.assets[1].title, 'Big Buck Bunny Theme');
  assert.equal(yt720.assets[1].author, 'Blender Foundation');

  // 1080p DASH mux (audioExt='m4a') + MP3 audio
  const yt1080Entry: YtDlpEntry = {
    ...entry,
    formats: [entry.formats![0], entry.formats![2]],
  };
  const yt1080 = await buildAssetsFromYtDlpPayload(
    yt1080Entry,
    sanitizeAndParseUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ')!,
    '1080',
    LIMIT_50MB,
    { skipHeadProbe: true }
  );
  assert.equal(yt1080.assets.length, 2);
  assert.equal(yt1080.assets[0].strategy, 'ffmpeg_mux_dash');
  assert.equal(yt1080.assets[0].audioExt, 'm4a');
  assert.equal(yt1080.assets[1].kind, 'audio');
  assert.equal(yt1080.assets[1].streamUrl, 'https://cdn.example.com/audio-128k.m4a');

  // YouTube Shorts
  const shorts = await buildAssetsFromYtDlpPayload(
    entry,
    sanitizeAndParseUrl('https://www.youtube.com/shorts/aqz-KE-bpKQ')!,
    '720',
    LIMIT_50MB,
    { skipHeadProbe: true }
  );
  assert.equal(shorts.assets.length, 2);
  assert.equal(shorts.assets[0].platform, 'youtube_shorts');
  assert.equal(shorts.assets[1].kind, 'audio');
  assert.equal(shorts.assets[1].platform, 'youtube_shorts');
});

test('Extractor (YouTube Music): preserves source audio format and cleans artist metadata', async () => {
  const trackEntry: YtDlpEntry = {
    id: 'song1',
    title: 'Midnight City',
    track: 'Midnight City',
    artist: 'M83',
    uploader: 'M83 - Topic',
    duration: 243,
    thumbnail: 'https://lh3.googleusercontent.com/cover.jpg',
    formats: [
      {
        format_id: '18',
        url: 'https://cdn.example.com/video-360p.mp4',
        ext: 'mp4',
        vcodec: 'avc1',
        acodec: 'mp4a',
        height: 360,
      },
      {
        format_id: '251',
        url: 'https://cdn.example.com/audio-opus.webm',
        ext: 'webm',
        vcodec: 'none',
        acodec: 'opus',
        abr: 160,
        filesize: 4_500_000,
      },
    ],
  };

  const singleRes = await buildAssetsFromYtDlpPayload(
    trackEntry,
    sanitizeAndParseUrl('https://music.youtube.com/watch?v=song1')!,
    '720',
    LIMIT_50MB,
    { skipHeadProbe: true }
  );
  assert.equal(singleRes.assets.length, 1);
  assert.equal(singleRes.assets[0].kind, 'audio');
  assert.equal(singleRes.assets[0].platform, 'youtube_music');
  assert.equal(singleRes.assets[0].ext, 'webm');
  assert.equal(singleRes.assets[0].strategy, 'direct_http');
  assert.equal(singleRes.assets[0].streamUrl, 'https://cdn.example.com/audio-opus.webm');
  assert.equal(singleRes.assets[0].title, 'Midnight City');
  assert.equal(singleRes.assets[0].author, 'M83');
  assert.equal(singleRes.assets[0].filename, 'M83_-_Midnight_City.webm');

  // Playlist with " - Topic" fallback cleanup
  const playlistPayload: YtDlpEntry = {
    _type: 'playlist',
    title: 'Album Title',
    entries: [
      {
        ...trackEntry,
        artist: undefined,
        uploader: 'Synthwave Artist - Topic',
      },
      {
        ...trackEntry,
        id: 'song2',
        track: 'Outro',
        title: 'Outro',
        artist: undefined,
        uploader: 'Synthwave Artist - Topic',
      },
    ],
  };

  const playlistRes = await buildAssetsFromYtDlpPayload(
    playlistPayload,
    sanitizeAndParseUrl('https://music.youtube.com/playlist?list=OLAK5uy_123')!,
    '720',
    LIMIT_50MB,
    { skipHeadProbe: true }
  );
  assert.equal(playlistRes.assets.length, 2);
  assert.ok(playlistRes.assets.every((a) => a.kind === 'audio' && a.author === 'Synthwave Artist'));
});

test('Extractor (Instagram): extracts MP3 audio for videos/reels but not photo-only posts', async () => {
  const igVideoEntry: YtDlpEntry = {
    id: 'reel123',
    title: 'Cool Dance Reel',
    uploader: 'dancer_ig',
    duration: 18,
    formats: [
      {
        format_id: 'hd',
        url: 'https://scontent.cdninstagram.com/reel.mp4',
        ext: 'mp4',
        vcodec: 'avc1',
        acodec: 'mp4a',
        width: 720,
        height: 1280,
        filesize: 3_500_000,
      },
    ],
  };

  const reelRes = await buildAssetsFromYtDlpPayload(
    igVideoEntry,
    sanitizeAndParseUrl('https://www.instagram.com/reel/Cx123/')!,
    '720',
    LIMIT_50MB,
    { skipHeadProbe: true }
  );
  assert.equal(reelRes.assets.length, 2);
  assert.equal(reelRes.assets[0].kind, 'video');
  assert.equal(reelRes.assets[1].kind, 'audio');
  assert.equal(reelRes.assets[1].platform, 'instagram');
  assert.equal(reelRes.assets[1].strategy, 'ffmpeg_extract_mp3');
  assert.equal(reelRes.assets[1].streamUrl, 'https://scontent.cdninstagram.com/reel.mp4');

  const igPhotoEntry: YtDlpEntry = {
    id: 'photo123',
    title: 'Sunset Photo',
    url: 'https://scontent.cdninstagram.com/photo.jpg',
    ext: 'jpg',
    width: 1080,
    height: 1080,
    filesize: 250_000,
  };

  const photoRes = await buildAssetsFromYtDlpPayload(
    igPhotoEntry,
    sanitizeAndParseUrl('https://www.instagram.com/p/Px123/')!,
    '720',
    LIMIT_50MB,
    { skipHeadProbe: true }
  );
  assert.equal(photoRes.assets.length, 1);
  assert.equal(photoRes.assets[0].kind, 'photo');
});

test('Extractor (TikTok): fast TikWM and direct HTML parsers return video/slideshow + audio', () => {
  // TikWM with relative paths & direct MP3
  const tikwm = buildAssetsFromTikWmData(
    {
      id: '7123456',
      title: 'Funny Cat',
      cover: '/cover/cat.jpg',
      duration: 15,
      play: '/video/cat.mp4',
      hdplay: '/video/cat_hd.mp4',
      music: '/music/cat_sound.mp3',
      hd_size: 4_000_000,
      size: 2_000_000,
      music_info: { title: 'Meow Beat', author: 'DJ Cat' },
      author: { unique_id: 'catlover' },
    },
    'https://www.tiktok.com/@catlover/video/7123456',
    LIMIT_50MB
  );
  assert.equal(tikwm.assets.length, 2);
  assert.equal(tikwm.assets[0].kind, 'video');
  assert.equal(tikwm.assets[0].streamUrl, 'https://www.tikwm.com/video/cat_hd.mp4');
  assert.equal(tikwm.assets[1].kind, 'audio');
  assert.equal(tikwm.assets[1].strategy, 'direct_http');
  assert.equal(tikwm.assets[1].streamUrl, 'https://www.tikwm.com/music/cat_sound.mp3');

  // Direct HTML rehydration parser
  const fakePayload = {
    __DEFAULT_SCOPE__: {
      'webapp.video-detail': {
        itemInfo: {
          itemStruct: {
            id: '7999',
            desc: 'Direct HTML TikTok',
            author: { uniqueId: 'creator1' },
            video: {
              duration: 12,
              width: 720,
              height: 1280,
              cover: 'https://p16-sign.tiktokcdn-us.com/cover.jpg',
              bitrateInfo: [
                {
                  Bitrate: 1_500_000,
                  PlayAddr: {
                    UrlList: ['https://v16.tiktokcdn-us.com/hd.mp4'],
                    DataSize: 2_500_000,
                  },
                },
              ],
            },
            music: {
              title: 'Original Sound',
              authorName: 'creator1',
              playUrl: 'https://sf16.tiktokcdn-us.com/sound.mp3',
              duration: 12,
            },
          },
        },
      },
    },
  };
  const fakeHtml = `<html><head><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(
    fakePayload
  )}</script></head></html>`;
  const parsedHtml = parseTikTokHtmlPayload(
    fakeHtml,
    'https://www.tiktok.com/@creator1/video/7999',
    LIMIT_50MB,
    { Referer: 'https://www.tiktok.com/' }
  );
  assert.ok(parsedHtml);
  assert.equal(parsedHtml.assets.length, 2);
  assert.equal(parsedHtml.assets[0].kind, 'video');
  assert.equal(parsedHtml.assets[0].streamUrl, 'https://v16.tiktokcdn-us.com/hd.mp4');
  assert.equal(parsedHtml.assets[1].kind, 'audio');
  assert.equal(parsedHtml.assets[1].strategy, 'direct_http');
  assert.equal(parsedHtml.assets[1].streamUrl, 'https://sf16.tiktokcdn-us.com/sound.mp3');
});

test('Extractor (Old features): pickFormatsForEntry handles GIFs, photos, and DASH mux', () => {
  const gifPicked = pickFormatsForEntry(
    { url: 'https://media.tumblr.com/anim.gif', ext: 'gif', width: 320, height: 240 },
    'tumblr',
    '720',
    LIMIT_50MB
  );
  assert.equal(gifPicked?.kind, 'animation');
  assert.equal(gifPicked?.ext, 'gif');

  const photoPicked = pickFormatsForEntry(
    { url: 'https://i.redd.it/pic.jpeg', ext: 'jpeg', width: 800, height: 600 },
    'reddit',
    '720',
    LIMIT_50MB
  );
  assert.equal(photoPicked?.kind, 'photo');
  assert.equal(photoPicked?.ext, 'jpg');

  const bestAudio = pickBestAudioFormat({
    formats: [
      { url: 'https://cdn/low.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 64 },
      { url: 'https://cdn/high.webm', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 160 },
    ],
  });
  assert.equal(bestAudio?.url, 'https://cdn/high.webm');
});

test('FFmpeg Zero-Disk Pipelines: MP3 extraction with ID3 tags & fragmented MP4 DASH mux', async () => {
  // Generate 1 second synthetic video+audio fragmented MP4 in RAM
  const mp4Buffer = await runFfmpegToBuffer([
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=160x120:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ]);
  assert.ok(mp4Buffer.length > 1000, 'Synthetic MP4 should be non-empty');

  // Extract MP3 via pipe:0 -> pipe:1 with the exact production flags
  const mp3Buffer = await runFfmpegToBuffer(
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
      '-metadata',
      'title=Test Song',
      '-metadata',
      'artist=Test Artist',
      '-f',
      'mp3',
      'pipe:1',
    ],
    mp4Buffer
  );
  assert.ok(mp3Buffer.length > 1000, 'Extracted MP3 should be non-empty');
  assert.equal(mp3Buffer.subarray(0, 3).toString('ascii'), 'ID3');
  assert.ok(mp3Buffer.includes(Buffer.from('Test Song')));
  assert.ok(mp3Buffer.includes(Buffer.from('Test Artist')));
});

test('Python Export Generator: produces valid Python syntax with all new features', async () => {
  const files = getPythonBotFiles();
  const paths = files.map((f) => f.path);
  for (const required of [
    'requirements.txt',
    'config.py',
    'url_router.py',
    'streamer.py',
    'extractor.py',
    'bot.py',
    'Dockerfile',
    'docker-compose.yml',
  ]) {
    assert.ok(paths.includes(required), `Missing exported file: ${required}`);
  }

  const pyFiles = files.filter((f) => f.language === 'python');
  for (const file of pyFiles) {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        'python3',
        ['-c', 'import ast, sys; ast.parse(sys.stdin.read(), filename=sys.argv[1])', file.path],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let err = '';
      p.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      p.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Python syntax error in ${file.path}: ${err}`));
      });
      p.stdin.end(file.content);
    });
  }

  const routerPy = files.find((f) => f.path === 'url_router.py')!;
  assert.ok(routerPy.content.includes('youtube_music'));
  assert.ok(routerPy.content.includes('music.youtube.com'));

  const extractorPy = files.find((f) => f.path === 'extractor.py')!;
  assert.ok(extractorPy.content.includes('"youtube_music"'));
  assert.ok(extractorPy.content.includes('"instagram"'));

  const zip = new JSZip();
  for (const file of files) zip.file(file.path, file.content);
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
  assert.ok(zipBuf.length > 1000);
});

test('Telegram Bot Manager & Telemetry: configuration, limits, and snapshot integrity', () => {
  const optionsKeyboard = buildMediaOptionsKeyboard({ video: true, music: false });
  assert.deepEqual(
    optionsKeyboard.inline_keyboard[0].map((button) => [
      button.text,
      'callback_data' in button ? button.callback_data : undefined,
    ]),
    [
      ['☑ Video', 'mediaopt:video'],
      ['☐ Sound', 'mediaopt:music'],
    ]
  );

  const initial = telegramBotManager.getStatus();
  assert.equal(initial.limitMb, 50);
  assert.equal(initial.mediaMode, 'both');

  const updated = telegramBotManager.updateConfig({
    apiRoot: 'http://localhost:8081',
    concurrency: 12,
    youtubeQuality: '1080',
    mediaMode: 'music',
    autoCompressOverLimit: true,
  });
  assert.equal(updated.limitMb, 2000);
  assert.equal(updated.concurrency, 12);
  assert.equal(updated.youtubeQuality, '1080');
  assert.equal(updated.mediaMode, 'music');
  assert.equal(updated.autoCompressOverLimit, true);

  // Restore defaults
  telegramBotManager.updateConfig({
    apiRoot: 'https://api.telegram.org',
    concurrency: 8,
    youtubeQuality: '720',
    mediaMode: 'both',
    autoCompressOverLimit: false,
  });
  assert.equal(telegramBotManager.getStatus().limitMb, 50);

  const snap = telemetry.getSnapshot();
  assert.equal(snap.diskBytesWritten, 0);
});

test('HTTP Server Integration: health, auth, bot guard, extract validation, and python export ZIP', async () => {
  const port = 3489;
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverProc = spawn('node', ['server.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      ADMIN_USERNAME: 'testadmin',
      ADMIN_PASSWORD: 'testpassword123',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    // Wait until server is listening
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        if (res.ok) {
          const data = (await res.json()) as { ok: boolean; diskBytesWritten: number };
          assert.equal(data.ok, true);
          assert.equal(data.diskBytesWritten, 0);
          assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
          assert.equal(res.headers.get('x-powered-by'), null);
          ready = true;
          break;
        }
      } catch {
        // Retry
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(ready, 'Server failed to become healthy within timeout');

    // Unauthenticated /api/bot/status must be 401
    const unauthBot = await fetch(`${baseUrl}/api/bot/status`);
    assert.equal(unauthBot.status, 401);

    // Login and access /api/bot/status
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: 'testpassword123' }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.ok(cookie.includes('streambot_admin='));

    const authBot = await fetch(`${baseUrl}/api/bot/status`, {
      headers: { Cookie: cookie },
    });
    assert.equal(authBot.status, 200);
    const botData = (await authBot.json()) as {
      limitMb: number;
      running: boolean;
      mediaMode: string;
    };
    assert.equal(botData.limitMb, 50);
    assert.equal(botData.running, false);
    assert.equal(botData.mediaMode, 'both');

    const configRes = await fetch(`${baseUrl}/api/bot/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ mediaMode: 'music' }),
    });
    assert.equal(configRes.status, 200);
    const configData = (await configRes.json()) as { mediaMode: string };
    assert.equal(configData.mediaMode, 'music');

    // /api/extract validation rejects unsupported/unsafe URLs
    const badExtract = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/secret' }),
    });
    assert.equal(badExtract.status, 400);
    const badBody = (await badExtract.json()) as { error: string };
    assert.ok(badBody.error.includes('YouTube Music'));

    for (let attempt = 0; attempt < 11; attempt += 1) {
      await fetch(`${baseUrl}/api/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1/secret' }),
      });
    }
    const limitedExtract = await fetch(`${baseUrl}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/secret' }),
    });
    assert.equal(limitedExtract.status, 429);
    assert.ok(limitedExtract.headers.has('retry-after'));

    // /api/stream expired asset returns 404
    const missingStream = await fetch(`${baseUrl}/api/stream/nonexistent-id`);
    assert.equal(missingStream.status, 404);

    // /api/export/python-bot.zip returns valid zip with updated files
    const zipRes = await fetch(`${baseUrl}/api/export/python-bot.zip`);
    assert.equal(zipRes.status, 200);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    const loadedZip = await JSZip.loadAsync(zipBuf);
    const routerCode = await loadedZip.file('url_router.py')?.async('string');
    assert.ok(routerCode?.includes('youtube_music'));
  } finally {
    serverProc.kill('SIGKILL');
  }
});
