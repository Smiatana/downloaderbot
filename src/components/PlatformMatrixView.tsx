import { useMemo, useState } from 'react';
import { CheckCircle2, ShieldAlert } from 'lucide-react';

interface PlatformSpec {
  platform: string;
  domains: string;
  content: string;
  streamPipeline: string;
  specialBehavior: string;
}

const PLATFORM_SPECS: PlatformSpec[] = [
  {
    platform: 'Instagram',
    domains: 'instagram.com, instagr.am',
    content: 'Posts, Reels, Stories, Carousels',
    streamPipeline: 'yt-dlp metadata + HTTP Readable stream + FFmpeg MP3 pipe',
    specialBehavior:
      'Multi-item carousels stream into Telegram sendMediaGroup (batches of 10); videos also extract sound as MP3 music.',
  },
  {
    platform: 'TikTok',
    domains: 'tiktok.com, vm.tiktok.com, vt.tiktok.com',
    content: 'Videos, Photo Slideshows',
    streamPipeline: 'Fast TikWM / Direct HTML + zero-copy MP3 or FFmpeg MP3 pipe',
    specialBehavior:
      'Streams HD video and MP3 audio concurrently with zero-transcode pass-through when MP3 is provided directly.',
  },
  {
    platform: 'Twitter / X',
    domains: 'twitter.com, x.com, fxtwitter.com, vxtwitter.com',
    content: 'Videos, GIFs, Multi-image Tweets',
    streamPipeline: 'yt-dlp + FxTwitter JSON fallback + HTTP stream',
    specialBehavior:
      'GIFs route to sendAnimation; multi-photo tweets group cleanly in sendMediaGroup.',
  },
  {
    platform: 'Reddit',
    domains: 'reddit.com, redd.it, v.redd.it, i.redd.it',
    content: 'Videos (with audio), Images, GIFs, Galleries',
    streamPipeline: 'FFmpeg dual-input DASH mux -> fragmented MP4 pipe:1',
    specialBehavior:
      'Muxes separate v.redd.it video and DASH audio streams in memory without temp files.',
  },
  {
    platform: 'Tumblr',
    domains: 'tumblr.com, *.tumblr.com',
    content: 'Videos, Images, GIFs',
    streamPipeline: 'yt-dlp + OpenGraph asset fallback + HTTP stream',
    specialBehavior:
      'Resolves raw media assets directly from post pages and streams straight to chat.',
  },
  {
    platform: 'YouTube',
    domains: 'youtube.com, youtu.be',
    content: 'Long-form Videos (360p / 720p / 1080p) + MP3 Audio',
    streamPipeline: 'Progressive/DASH MP4 stream + audio-only FFmpeg MP3 pipe',
    specialBehavior:
      'Streams video and extracts video sound as MP3 music; checks 50 MB / 2 GB limit before streaming.',
  },
  {
    platform: 'YouTube Shorts',
    domains: 'youtube.com/shorts/*',
    content: 'Vertical Videos + MP3 Audio',
    streamPipeline: 'H.264 MP4 stream + audio-only FFmpeg MP3 pipe',
    specialBehavior:
      'Preserves vertical aspect dimensions and also extracts the video sound as MP3 music.',
  },
  {
    platform: 'YouTube Music',
    domains: 'music.youtube.com',
    content: 'Songs, Tracks, Playlists / Albums',
    streamPipeline: 'Best audio-only stream -> FFmpeg MP3 pipe with ID3 tags',
    specialBehavior:
      'Resolves track/artist metadata and streams MP3 music directly via sendAudio.',
  },
];

const SHELL_UNSAFE = /[`$();|&<>\\\n\r\0]/;
const URL_FINDER = /https?:\/\/[^\s<>"'`)\]]+/gi;

function clientPreviewRoute(text: string) {
  const candidates = text.match(URL_FINDER) ?? [];
  return candidates.map((raw) => {
    const cleaned = raw.replace(/[.,!?;:]+$/, '');
    if (SHELL_UNSAFE.test(cleaned)) {
      return { raw: cleaned, valid: false, reason: 'Blocked unsafe characters' };
    }
    try {
      const u = new URL(cleaned);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (
        host === 'localhost' ||
        /^127\.|^10\.|^192\.168\./.test(host)
      ) {
        return { raw: cleaned, valid: false, reason: 'Blocked private/loopback IP' };
      }
      if (host === 'music.youtube.com') {
        return { raw: cleaned, valid: true, platform: 'YouTube Music (MP3)' };
      }
      if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && u.pathname.startsWith('/shorts/')) {
        return { raw: cleaned, valid: true, platform: 'YouTube Shorts (+ MP3)' };
      }
      if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) {
        return { raw: cleaned, valid: true, platform: 'YouTube (+ MP3)' };
      }
      if (host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am' || host.endsWith('.instagr.am')) {
        return { raw: cleaned, valid: true, platform: 'Instagram (+ MP3 for video)' };
      }
      if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
        return { raw: cleaned, valid: true, platform: 'TikTok (+ MP3)' };
      }
      if (host === 'twitter.com' || host === 'x.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) {
        return { raw: cleaned, valid: true, platform: 'Twitter / X' };
      }
      if (host === 'reddit.com' || host === 'redd.it' || host.endsWith('.reddit.com')) {
        return { raw: cleaned, valid: true, platform: 'Reddit' };
      }
      if (host === 'tumblr.com' || host.endsWith('.tumblr.com')) {
        return { raw: cleaned, valid: true, platform: 'Tumblr' };
      }
      return { raw: cleaned, valid: false, reason: 'Unsupported domain' };
    } catch {
      return { raw: cleaned, valid: false, reason: 'Malformed URL' };
    }
  });
}

export function PlatformMatrixView() {
  const [sampleMessage, setSampleMessage] = useState(
    'Check this out https://www.tiktok.com/@scout2015/video/6718335390845095173 and https://x.com/nasa/status/1850000000000000000'
  );

  const routed = useMemo(() => clientPreviewRoute(sampleMessage), [sampleMessage]);

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">
            Supported Platform Matrix & Zero-Disk Pipelines
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            All eight target platforms execute inside an async worker semaphore with zero temporary files written to disk.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-600">
                <th className="py-3 px-5">Platform</th>
                <th className="py-3 px-5">Matched Domains</th>
                <th className="py-3 px-5">Supported Content</th>
                <th className="py-3 px-5">Zero-Disk Pipeline</th>
                <th className="py-3 px-5">Special Requirements</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {PLATFORM_SPECS.map((row) => (
                <tr key={row.platform} className="hover:bg-slate-50/70 align-top">
                  <td className="py-3.5 px-5 font-semibold text-slate-900 whitespace-nowrap">
                    {row.platform}
                  </td>
                  <td className="py-3.5 px-5 font-mono text-slate-600 whitespace-nowrap">
                    {row.domains}
                  </td>
                  <td className="py-3.5 px-5 text-slate-700">{row.content}</td>
                  <td className="py-3.5 px-5 font-mono text-sky-700">
                    {row.streamPipeline}
                  </td>
                  <td className="py-3.5 px-5 text-slate-600 max-w-sm">
                    {row.specialBehavior}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            URL Router & Injection Sanitizer Sandbox
          </h3>
          <p className="text-xs text-slate-600 mt-0.5">
            Test how incoming Telegram chat text is scanned, stripped of tracking parameters, and checked against SSRF and shell-injection rules.
          </p>
        </div>

        <textarea
          rows={3}
          value={sampleMessage}
          onChange={(e) => setSampleMessage(e.target.value)}
          className="w-full p-3.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-600/20 focus:border-sky-600"
          placeholder="Paste a sample Telegram message containing one or more links..."
        />

        {routed.length === 0 ? (
          <p className="text-xs text-slate-500">
            No HTTP/HTTPS URLs detected in message text.
          </p>
        ) : (
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
            {routed.map((item, idx) => (
              <div
                key={`${item.raw}-${idx}`}
                className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <span className="font-mono text-slate-800 truncate">
                  {item.raw}
                </span>
                {item.valid ? (
                  <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700 whitespace-nowrap shrink-0">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Matched: {item.platform}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 font-medium text-red-700 whitespace-nowrap shrink-0">
                    <ShieldAlert className="w-3.5 h-3.5" />
                    <span>Rejected: {item.reason}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
