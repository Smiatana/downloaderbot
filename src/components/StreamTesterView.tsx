import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  ArrowDownToLine,
  AudioLines,
  Film,
  Image as ImageIcon,
  Link2,
  Loader2,
  Play,
  SlidersHorizontal,
} from 'lucide-react';
import {
  formatBytes,
  PLATFORM_LABELS,
  STRATEGY_LABELS,
  type ExtractionResult,
  type MediaAsset,
  type YouTubeQuality,
} from '../types.ts';

const QUICK_EXAMPLES = [
  {
    label: 'YouTube Shorts',
    url: 'https://www.youtube.com/shorts/aqz-KE-bpKQ',
  },
  {
    label: 'YouTube Video',
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  },
  {
    label: 'Reddit Post',
    url: 'https://www.reddit.com/r/aww/',
  },
];

export function StreamTesterView() {
  const [urlInput, setUrlInput] = useState('');
  const [quality, setQuality] = useState<YouTubeQuality>('720');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('');
  const [cookiesHeader, setCookiesHeader] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [previewingIds, setPreviewingIds] = useState<Record<string, boolean>>({});

  async function runExtract(targetUrl: string) {
    const trimmed = targetUrl.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setErrorDetails(null);
    setResult(null);
    setPreviewingIds({});

    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: trimmed,
          youtubeQuality: quality,
          proxyUrl: proxyUrl.trim() || undefined,
          cookiesHeader: cookiesHeader.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Extraction failed.');
        setErrorDetails(data.details || null);
      } else {
        setResult(data as ExtractionResult);
      }
    } catch (err) {
      setError('Network error while contacting the extraction worker.');
      setErrorDetails(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void runExtract(urlInput);
  }

  function togglePreview(assetId: string) {
    setPreviewingIds((prev) => ({ ...prev, [assetId]: !prev[assetId] }));
  }

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col gap-1 mb-5">
          <h2 className="text-lg font-semibold text-slate-900">
            Zero-Disk Stream Inspector
          </h2>
          <p className="text-sm text-slate-600 max-w-2xl">
            Paste a link from Instagram, TikTok, Twitter/X, Reddit, Tumblr, YouTube, or YouTube Shorts to resolve direct streams and pipe media straight to your browser or Telegram without local file writes.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex flex-col lg:flex-row gap-3">
            <div className="relative flex-1">
              <Link2 className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="url"
                required
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://www.tiktok.com/@creator/video/... or any supported URL"
                className="w-full h-11 pl-10 pr-4 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-600/20 focus:border-sky-600 font-mono"
              />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div
                className="flex items-center p-1 bg-slate-100 rounded-lg border border-slate-200"
                role="group"
                aria-label="YouTube target resolution"
              >
                {(['360', '720', '1080'] as YouTubeQuality[]).map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQuality(q)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                      quality === q
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {q}p
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className={`h-11 px-3.5 text-sm font-medium border rounded-lg inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                  showAdvanced
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <SlidersHorizontal className="w-4 h-4" />
                <span>Options</span>
              </button>

              <button
                type="submit"
                disabled={loading || !urlInput.trim()}
                className="h-11 px-5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Resolving</span>
                  </>
                ) : (
                  <span>Resolve Stream</span>
                )}
              </button>
            </div>
          </div>

          {showAdvanced && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-slate-100">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  HTTP / SOCKS5 Proxy URL (for rate-limited platforms)
                </label>
                <input
                  type="text"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="http://user:pass@proxy.example.com:8080"
                  className="w-full h-10 px-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-sky-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Session Cookie Header (Instagram / Private Reels)
                </label>
                <input
                  type="password"
                  value={cookiesHeader}
                  onChange={(e) => setCookiesHeader(e.target.value)}
                  placeholder="sessionid=...; csrftoken=..."
                  className="w-full h-10 px-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-sky-600"
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate-500">
            <span>Quick test URLs:</span>
            {QUICK_EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => {
                  setUrlInput(ex.url);
                  void runExtract(ex.url);
                }}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md font-medium transition-colors whitespace-nowrap shrink-0"
              >
                {ex.label}
              </button>
            ))}
          </div>
        </form>
      </section>

      {loading && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="h-5 w-64 bg-slate-100 rounded animate-pulse" />
          <div className="h-4 w-96 bg-slate-100 rounded animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div className="h-44 bg-slate-100 rounded-lg animate-pulse" />
            <div className="h-44 bg-slate-100 rounded-lg animate-pulse" />
          </div>
        </section>
      )}

      {error && !loading && (
        <section className="bg-white border border-red-200 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0">
              <p className="text-sm font-semibold text-red-900">{error}</p>
              {errorDetails && (
                <p className="text-xs font-mono text-red-700 break-all">
                  {errorDetails}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {!loading && !error && !result && (
        <section className="bg-white border border-slate-200 rounded-xl p-8 text-center">
          <p className="text-sm font-medium text-slate-900">
            Ready to resolve media streams
          </p>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            Enter a supported social media URL above. Video, carousel images, GIFs, and TikTok MP3 audio tracks will appear here ready for live playback or direct memory-to-HTTP download.
          </p>
        </section>
      )}

      {result && !loading && (
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-slate-200">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mb-1">
                <span className="font-semibold text-sky-700">
                  {PLATFORM_LABELS[result.platform]}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {result.extractionMs} ms
                </span>
                <span aria-hidden="true">·</span>
                <span>Extractor: {result.extractorUsed}</span>
                {result.isCarousel && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Media Group ({result.assets.filter((a) => a.kind !== 'audio').length} items)</span>
                  </>
                )}
                {result.hasSeparateAudio && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>MP3 Audio Extracted</span>
                  </>
                )}
              </div>
              <h3 className="text-base font-semibold text-slate-900 truncate">
                {result.title}
              </h3>
              {result.author && (
                <p className="text-xs text-slate-500 mt-0.5">{result.author}</p>
              )}
            </div>

            <div className="text-xs text-slate-500 font-mono tabular-nums shrink-0">
              {result.assets.length} stream{result.assets.length === 1 ? '' : 's'} ready
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {result.assets.map((asset) => (
              <AssetStreamCard
                key={asset.id}
                asset={asset}
                isPreviewing={Boolean(previewingIds[asset.id])}
                onTogglePreview={() => togglePreview(asset.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function AssetStreamCard({
  asset,
  isPreviewing,
  onTogglePreview,
}: {
  asset: MediaAsset;
  isPreviewing: boolean;
  onTogglePreview: () => void;
}) {
  const streamPath = `/api/stream/${asset.id}`;
  const downloadPath = `/api/stream/${asset.id}?download=1`;
  const compressDownloadPath = `/api/stream/${asset.id}?download=1&compress=1`;

  const KindIcon =
    asset.kind === 'audio'
      ? AudioLines
      : asset.kind === 'photo'
        ? ImageIcon
        : Film;

  return (
    <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 flex flex-col justify-between gap-4">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-white border border-slate-200 flex items-center justify-center shrink-0 text-slate-700">
              <KindIcon className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 truncate">
                {asset.filename}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 mt-0.5">
                <span className="uppercase font-mono">{asset.ext}</span>
                <span aria-hidden="true">·</span>
                <span>{STRATEGY_LABELS[asset.strategy]}</span>
                {asset.resolutionLabel && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {asset.resolutionLabel}
                    </span>
                  </>
                )}
                {asset.durationSeconds ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {Math.round(asset.durationSeconds)}s
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="text-right shrink-0">
            <span
              className={`text-xs font-mono tabular-nums font-medium ${
                asset.exceedsLimit ? 'text-amber-700' : 'text-slate-700'
              }`}
            >
              {formatBytes(asset.estimatedBytes)}
            </span>
            {asset.exceedsLimit && (
              <p className="text-[11px] text-amber-700 font-medium">
                Over {Math.round(asset.limitBytes / 1048576)} MB limit
              </p>
            )}
          </div>
        </div>

        {isPreviewing && (
          <div className="rounded-lg overflow-hidden border border-slate-200 bg-slate-950">
            {asset.kind === 'photo' || asset.kind === 'animation' ? (
              <img
                src={streamPath}
                alt={asset.title}
                referrerPolicy="no-referrer"
                className="w-full max-h-72 object-contain mx-auto"
              />
            ) : asset.kind === 'audio' ? (
              <div className="p-4 bg-white">
                <audio controls preload="none" src={streamPath} className="w-full" />
              </div>
            ) : (
              <video
                controls
                preload="metadata"
                poster={asset.thumbnailUrl}
                src={streamPath}
                className="w-full max-h-72 object-contain mx-auto"
              />
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200/80">
        <button
          type="button"
          onClick={onTogglePreview}
          className="px-3.5 py-2 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-100 text-slate-800 rounded-lg inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          <Play className="w-3.5 h-3.5" />
          <span>{isPreviewing ? 'Hide Stream' : 'Preview Stream'}</span>
        </button>

        <a
          href={downloadPath}
          download={asset.filename}
          className="px-3.5 py-2 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-lg inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          <ArrowDownToLine className="w-3.5 h-3.5" />
          <span>Download ({asset.ext.toUpperCase()})</span>
        </a>

        {asset.exceedsLimit && asset.kind === 'video' && (
          <a
            href={compressDownloadPath}
            download={asset.filename}
            className="px-3.5 py-2 text-xs font-medium bg-amber-50 border border-amber-300 hover:bg-amber-100 text-amber-900 rounded-lg inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            <ArrowDownToLine className="w-3.5 h-3.5" />
            <span>Transcode &lt;50 MB</span>
          </a>
        )}
      </div>
    </div>
  );
}
