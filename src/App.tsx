import { useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  Code2,
  Download,
  HardDrive,
  Layers,
  Loader2,
  Menu,
  Radio,
  X,
} from 'lucide-react';
import { PlatformMatrixView } from './components/PlatformMatrixView.tsx';
import { SourceExportView } from './components/SourceExportView.tsx';
import { StreamTesterView } from './components/StreamTesterView.tsx';
import { TelegramBotView } from './components/TelegramBotView.tsx';
import { AdminLoginView } from './components/AdminLoginView.tsx';
import {
  formatBytes,
  type BotStatusSnapshot,
  type StreamEventLog,
  type TelemetrySnapshot,
} from './types.ts';

type NavTab = 'tester' | 'bot' | 'platforms' | 'export';

const NAV_ITEMS: Array<{
  id: NavTab;
  label: string;
  breadcrumb: string;
  icon: typeof Activity;
}> = [
  {
    id: 'tester',
    label: 'Stream Tester',
    breadcrumb: 'Zero-Disk Stream Tester',
    icon: Radio,
  },
  {
    id: 'bot',
    label: 'Telegram Bot',
    breadcrumb: 'Live Telegram Bot',
    icon: Bot,
  },
  {
    id: 'platforms',
    label: 'Platform Matrix',
    breadcrumb: 'Supported Platforms',
    icon: Layers,
  },
  {
    id: 'export',
    label: 'Python Export',
    breadcrumb: 'aiogram v3 Source & Export',
    icon: Code2,
  },
];

const INITIAL_BOT_STATUS: BotStatusSnapshot = {
  running: false,
  botUsername: null,
  botId: null,
  apiRoot: 'https://api.telegram.org',
  limitMb: 50,
  concurrency: 8,
  youtubeQuality: '720',
  autoCompressOverLimit: false,
  hasToken: false,
  hasProxy: false,
  hasCookies: false,
  startedAt: null,
  lastError: null,
};

const INITIAL_TELEMETRY: TelemetrySnapshot = {
  streamsCompleted: 0,
  streamsFailed: 0,
  bytesStreamed: 0,
  diskBytesWritten: 0,
  activeWorkers: 0,
  peakThroughputMbps: 0,
  recentEvents: [],
};

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('tester');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(INITIAL_TELEMETRY);
  const [botStatus, setBotStatus] = useState<BotStatusSnapshot>(INITIAL_BOT_STATUS);
  const [adminAuthenticated, setAdminAuthenticated] = useState<boolean | null>(null);
  const [adminConfigured, setAdminConfigured] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    fetch('/api/auth/status')
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to check admin sign-in status.');
        return response.json();
      })
      .then((data) => {
        if (active) {
          setAdminConfigured(Boolean(data.configured));
          setAdminAuthenticated(Boolean(data.authenticated));
        }
      })
      .catch((err) => {
        if (active) {
          setAuthError(err instanceof Error ? err.message : 'Unable to reach the server.');
          setAdminAuthenticated(false);
        }
      });

    const sse = new EventSource('/api/events');
    sse.addEventListener('snapshot', (ev) => {
      try {
        const snap = JSON.parse((ev as MessageEvent).data) as TelemetrySnapshot;
        if (active) setTelemetry(snap);
      } catch {
        // Ignore malformed SSE payload
      }
    });
    sse.addEventListener('log', (ev) => {
      try {
        const entry = JSON.parse((ev as MessageEvent).data) as StreamEventLog;
        if (active) {
          setTelemetry((prev) => ({
            ...prev,
            recentEvents: [entry, ...prev.recentEvents].slice(0, 80),
          }));
        }
      } catch {
        // Ignore malformed SSE payload
      }
    });

    return () => {
      active = false;
      sse.close();
    };
  }, []);

  useEffect(() => {
    if (!adminAuthenticated) return;
    let active = true;

    fetch('/api/bot/status')
      .then(async (response) => {
        if (response.status === 401) {
          setAdminAuthenticated(false);
          throw new Error('Your admin session expired. Please sign in again.');
        }
        if (!response.ok) throw new Error('Unable to load Telegram bot status.');
        return response.json();
      })
      .then((data) => {
        if (active && data) setBotStatus(data as BotStatusSnapshot);
      })
      .catch((err) => {
        if (active) setAuthError(err instanceof Error ? err.message : 'Unable to load bot status.');
      });

    return () => {
      active = false;
    };
  }, [adminAuthenticated]);

  const currentNav = NAV_ITEMS.find((item) => item.id === activeTab) ?? NAV_ITEMS[0];

  function selectTab(tab: NavTab) {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  }

  async function handleAdminLogout() {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Unable to sign out.');
    setAdminAuthenticated(false);
    setBotStatus(INITIAL_BOT_STATUS);
    setAuthError(null);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar (256px) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-white border-r border-slate-200">
        <div className="h-14 px-5 border-b border-slate-200 flex items-center">
          <a
            href="/"
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            StreamBot
          </a>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => selectTab(item.id)}
                className={`w-full px-3 py-2.5 text-sm font-medium rounded-lg flex items-center gap-3 transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-sky-50 text-sky-700 font-semibold'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-2 text-xs">
          {adminAuthenticated ? (
            <>
              <div className="flex items-center justify-between text-slate-600">
                <span>Bot Runner</span>
                <span
                  className={`font-semibold ${
                    botStatus.running ? 'text-emerald-700' : 'text-slate-500'
                  }`}
                >
                  {botStatus.running ? 'Connected' : 'Standby'}
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Bot API Cap</span>
                <span className="font-mono tabular-nums text-slate-900">
                  {botStatus.limitMb} MB
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Temp Disk I/O</span>
                <span className="font-mono tabular-nums text-slate-900">0 B</span>
              </div>
            </>
          ) : (
            <p className="text-slate-500">
              Admin panel locked. Sign in to manage bot settings.
            </p>
          )}
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 max-w-full bg-white h-full border-r border-slate-200 flex flex-col z-50">
            <div className="h-14 px-5 border-b border-slate-200 flex items-center justify-between">
              <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
                StreamBot
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 text-slate-500 hover:text-slate-900"
                aria-label="Close navigation menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectTab(item.id)}
                    className={`w-full px-3 py-2.5 text-sm font-medium rounded-lg flex items-center gap-3 transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? 'bg-sky-50 text-sky-700 font-semibold'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline whitespace-nowrap">
                StreamBot
              </span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <h1 className="font-semibold text-slate-900 truncate">
                {currentNav.breadcrumb}
              </h1>
            </div>
          </div>

          <a
            href="/api/export/python-bot.zip"
            download="streambot-aiogram-zero-disk.zip"
            className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download Bot ZIP</span>
          </a>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto space-y-6">
          {/* 4-Column Tabular Telemetry Strip */}
          <section
            className="grid grid-cols-2 lg:grid-cols-4 gap-4"
            aria-label="Runtime stream metrics"
          >
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs font-medium text-slate-500">
                Streams Completed
              </p>
              <p className="text-2xl font-bold text-slate-900 font-mono tabular-nums mt-1">
                {telemetry.streamsCompleted}
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs font-medium text-slate-500">
                RAM Streamed
              </p>
              <p className="text-2xl font-bold text-slate-900 font-mono tabular-nums mt-1">
                {formatBytes(telemetry.bytesStreamed)}
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-slate-500">
                  Local Disk Written
                </p>
                <HardDrive className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <p className="text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">
                0 B
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs font-medium text-slate-500">
                Active Async Workers
              </p>
              <p className="text-2xl font-bold text-slate-900 font-mono tabular-nums mt-1">
                {telemetry.activeWorkers} / {botStatus.concurrency}
              </p>
            </div>
          </section>

          {activeTab === 'tester' && <StreamTesterView />}
          {activeTab === 'bot' && adminAuthenticated === null && (
            <section className="max-w-md mx-auto bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-600 flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Checking admin session…</span>
            </section>
          )}
          {activeTab === 'bot' && adminAuthenticated === false && (
            <AdminLoginView
              configured={adminConfigured === true}
              configurationLoaded={adminConfigured !== null}
              statusError={authError}
              onAuthenticated={() => {
                setAuthError(null);
                setAdminAuthenticated(true);
              }}
            />
          )}
          {activeTab === 'bot' && adminAuthenticated === true && (
            <TelegramBotView
              botStatus={botStatus}
              events={telemetry.recentEvents}
              onBotStatusChange={setBotStatus}
              onLogout={handleAdminLogout}
            />
          )}
          {activeTab === 'platforms' && <PlatformMatrixView />}
          {activeTab === 'export' && <SourceExportView />}
        </main>
      </div>
    </div>
  );
}
