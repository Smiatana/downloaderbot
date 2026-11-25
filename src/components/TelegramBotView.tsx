import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  LogOut,
  Power,
  Save,
  ShieldCheck,
  Square,
  Video,
  Music2,
  Layers2,
} from 'lucide-react';
import {
  formatBytes,
  PLATFORM_LABELS,
  type BotStatusSnapshot,
  type BotMediaMode,
  type StreamEventLog,
  type YouTubeQuality,
} from '../types.ts';

interface TelegramBotViewProps {
  botStatus: BotStatusSnapshot;
  events: StreamEventLog[];
  onBotStatusChange: (status: BotStatusSnapshot) => void;
  onLogout: () => Promise<void>;
}

export function TelegramBotView({
  botStatus,
  events,
  onBotStatusChange,
  onLogout,
}: TelegramBotViewProps) {
  const [token, setToken] = useState('');
  const [apiRoot, setApiRoot] = useState(botStatus.apiRoot);
  const [concurrency, setConcurrency] = useState(botStatus.concurrency);
  const [youtubeQuality, setYoutubeQuality] = useState<YouTubeQuality>(
    botStatus.youtubeQuality
  );
  const [mediaMode, setMediaMode] = useState<BotMediaMode>(botStatus.mediaMode);
  const [autoCompress, setAutoCompress] = useState(
    botStatus.autoCompressOverLimit
  );
  const [proxyUrl, setProxyUrl] = useState('');
  const [cookiesHeader, setCookiesHeader] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  async function handleStartBot(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.trim() || undefined,
          apiRoot: apiRoot.trim() || 'https://api.telegram.org',
          concurrency,
          youtubeQuality,
          mediaMode,
          autoCompressOverLimit: autoCompress,
          proxyUrl: proxyUrl.trim(),
          cookiesHeader: cookiesHeader.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({
          type: 'error',
          message: data.error || 'Failed to connect Telegram Bot.',
        });
        if (data.status) onBotStatusChange(data.status);
      } else {
        onBotStatusChange(data as BotStatusSnapshot);
        setFeedback({
          type: 'success',
          message: `Bot @${data.botUsername} is now polling asynchronously in zero-disk mode.`,
        });
      }
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Network error.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleStopBot() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/bot/stop', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({
          type: 'error',
          message: data.error || 'Failed to stop bot.',
        });
        return;
      }
      onBotStatusChange(data as BotStatusSnapshot);
      setFeedback({ type: 'success', message: 'Telegram bot runner stopped.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to stop bot.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveConfig() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/bot/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.trim() || undefined,
          apiRoot: apiRoot.trim() || 'https://api.telegram.org',
          concurrency,
          youtubeQuality,
          mediaMode,
          autoCompressOverLimit: autoCompress,
          proxyUrl: proxyUrl.trim(),
          cookiesHeader: cookiesHeader.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({
          type: 'error',
          message: data.error || 'Failed to save config.',
        });
        return;
      }
      onBotStatusChange(data as BotStatusSnapshot);
      setFeedback({
        type: 'success',
        message: 'Worker settings updated in memory.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save config.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    setFeedback(null);
    try {
      await onLogout();
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to sign out.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Live Telegram Bot Runner
            </h2>
            <p className="text-sm text-slate-600 mt-0.5">
              Connect a bot token from @BotFather to run the async grammY + undici + FFmpeg pipe worker directly from this server.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {botStatus.running ? (
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700">
                <CheckCircle2 className="w-4 h-4" />
                <span>
                  Running{botStatus.botUsername ? ` · @${botStatus.botUsername}` : ''}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                <Square className="w-3.5 h-3.5" />
                <span>Stopped</span>
              </div>
            )}
            <button
              type="button"
              onClick={handleLogout}
              disabled={busy}
              className="px-3 py-2 text-xs font-semibold text-slate-600 border border-slate-200 hover:bg-slate-50 disabled:opacity-60 rounded-lg inline-flex items-center gap-2"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign out</span>
            </button>
          </div>
        </div>

        <form onSubmit={handleStartBot} className="pt-5 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Telegram Bot Token (@BotFather)
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={
                  botStatus.hasToken
                    ? '•••••••••••••••••••••• (configured in memory)'
                    : '123456789:AAH...'
                }
                className="w-full h-10 px-3 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-600/20 focus:border-sky-600"
              />
              <p className="text-xs text-slate-500 mt-1.5 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span>Held in volatile server RAM only; never written to disk.</span>
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Telegram Bot API Endpoint
              </label>
              <input
                type="url"
                value={apiRoot}
                onChange={(e) => setApiRoot(e.target.value)}
                placeholder="https://api.telegram.org"
                className="w-full h-10 px-3 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-600/20 focus:border-sky-600"
              />
              <p className="text-xs text-slate-500 mt-1.5 tabular-nums">
                Active upload cap:{' '}
                {apiRoot.trim() !== 'https://api.telegram.org'
                  ? '2000 MB (Local Bot API Server)'
                  : '50 MB (Standard Cloud Bot API)'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Async Worker Concurrency ({concurrency} jobs)
              </label>
              <input
                type="range"
                min={1}
                max={32}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="w-full accent-sky-600 mt-2"
              />
              <div className="flex justify-between text-[11px] text-slate-400 font-mono tabular-nums mt-1">
                <span>1</span>
                <span>16</span>
                <span>32</span>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Media to Send from Every Source
              </label>
              <div className="flex items-center p-1 bg-slate-100 rounded-lg border border-slate-200 w-fit max-w-full">
                {([
                  ['video', 'Video', Video],
                  ['music', 'Music', Music2],
                  ['both', 'Both', Layers2],
                ] as const).map(([mode, label, Icon]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setMediaMode(mode)}
                    aria-pressed={mediaMode === mode}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                      mediaMode === mode
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Default YouTube Resolution
              </label>
              <div className="flex items-center p-1 bg-slate-100 rounded-lg border border-slate-200 w-fit">
                {(['360', '720', '1080'] as YouTubeQuality[]).map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setYoutubeQuality(q)}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                      youtubeQuality === q
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {q}p
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Over-Limit Fallback Behavior
              </label>
              <label className="flex items-center gap-2.5 h-10 px-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCompress}
                  onChange={(e) => setAutoCompress(e.target.checked)}
                  className="rounded border-slate-300 text-sky-600 focus:ring-sky-600"
                />
                <span className="text-xs font-medium text-slate-700">
                  FFmpeg pipe-compress videos over limit
                </span>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Proxy URL (Optional rotation for Instagram / TikTok)
              </label>
              <input
                type="text"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="http://user:pass@host:port"
                className="w-full h-10 px-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-sky-600"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Cookie Header (Optional for Instagram Stories / Age-restricted)
              </label>
              <input
                type="password"
                value={cookiesHeader}
                onChange={(e) => setCookiesHeader(e.target.value)}
                placeholder="sessionid=...; ds_user_id=..."
                className="w-full h-10 px-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-sky-600"
              />
            </div>
          </div>

          {feedback && (
            <div
              className={`p-3.5 rounded-lg border text-xs flex items-center gap-2 ${
                feedback.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-red-50 border-red-200 text-red-900'
              }`}
            >
              {feedback.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
              )}
              <span>{feedback.message}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-2">
            {!botStatus.running ? (
              <button
                type="submit"
                disabled={busy || (!token.trim() && !botStatus.hasToken)}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Power className="w-4 h-4" />
                )}
                <span>Start Async Bot</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStopBot}
                disabled={busy}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
                <span>Stop Bot</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleSaveConfig}
              disabled={busy}
              className="px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              <Save className="w-4 h-4" />
              <span>Apply Settings</span>
            </button>
          </div>
        </form>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Live Worker Activity Log
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Real-time events from Telegram chats and zero-disk stream extractions.
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-500">
            {events.length} events
          </span>
        </div>

        {events.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No stream events recorded in this session yet. Start the Telegram bot or resolve a URL in Stream Tester.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <th className="py-2.5 px-4">Time</th>
                  <th className="py-2.5 px-4">Source</th>
                  <th className="py-2.5 px-4">Platform</th>
                  <th className="py-2.5 px-4">Outcome</th>
                  <th className="py-2.5 px-4">Details</th>
                  <th className="py-2.5 px-4 text-right">Streamed</th>
                  <th className="py-2.5 px-4 text-right">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {events.map((ev) => (
                  <tr key={ev.id} className="hover:bg-slate-50/60">
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {new Date(ev.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2.5 px-4 text-slate-700 capitalize whitespace-nowrap">
                      {ev.source}
                      {ev.chatLabel ? ` · ${ev.chatLabel}` : ''}
                    </td>
                    <td className="py-2.5 px-4 text-slate-700 whitespace-nowrap">
                      {ev.platform ? PLATFORM_LABELS[ev.platform] : 'System'}
                    </td>
                    <td className="py-2.5 px-4 whitespace-nowrap font-medium">
                      <span
                        className={
                          ev.level === 'success'
                            ? 'text-emerald-700'
                            : ev.level === 'error'
                              ? 'text-red-700'
                              : ev.level === 'warning'
                                ? 'text-amber-700'
                                : 'text-slate-600'
                        }
                      >
                        {ev.level.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-700 max-w-md truncate">
                      {ev.message}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      {ev.bytesStreamed ? formatBytes(ev.bytesStreamed) : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {ev.durationMs ? `${ev.durationMs} ms` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
