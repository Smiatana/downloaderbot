import { useEffect, useState } from 'react';
import { Check, Copy, Download, FileCode2, Loader2 } from 'lucide-react';
import type { ExportedFile } from '../types.ts';

export function SourceExportView() {
  const [files, setFiles] = useState<ExportedFile[]>([]);
  const [activePath, setActivePath] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/export/python-files')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const list = (data.files ?? []) as ExportedFile[];
        setFiles(list);
        if (list.length > 0) {
          setActivePath(list[0].path);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeFile = files.find((f) => f.path === activePath) ?? files[0];

  async function handleCopy() {
    if (!activeFile) return;
    await navigator.clipboard.writeText(activeFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Async Python (aiogram v3) Zero-Disk Bot Bundle
          </h2>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            Standalone production source code using <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">aiogram v3</code>,{' '}
            <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">aiohttp</code>,{' '}
            <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">yt-dlp</code>, and{' '}
            <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">asyncio.create_subprocess_exec</code> FFmpeg stdout pipes with zero local file writes.
          </p>
        </div>

        <a
          href="/api/export/python-bot.zip"
          download="streambot-aiogram-zero-disk.zip"
          className="px-4 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 rounded-lg inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 self-start md:self-auto"
        >
          <Download className="w-4 h-4" />
          <span>Download ZIP Bundle</span>
        </a>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-10 flex items-center justify-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Loading source files...</span>
          </div>
        ) : (
          <>
            <div className="border-b border-slate-200 bg-slate-50/80 px-4 py-2.5 flex items-center justify-between gap-4 overflow-x-auto">
              <div className="flex items-center gap-1.5">
                {files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setActivePath(f.path)}
                    className={`px-3 py-1.5 text-xs font-mono rounded-md inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                      activeFile?.path === f.path
                        ? 'bg-white text-slate-900 border border-slate-200 shadow-xs font-semibold'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                    }`}
                  >
                    <FileCode2 className="w-3.5 h-3.5 text-slate-400" />
                    <span>{f.path}</span>
                  </button>
                ))}
              </div>

              {activeFile && (
                <button
                  type="button"
                  onClick={handleCopy}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy File</span>
                    </>
                  )}
                </button>
              )}
            </div>

            {activeFile && (
              <div>
                <div className="px-5 py-2.5 border-b border-slate-100 text-xs text-slate-600 bg-white">
                  {activeFile.description}
                </div>
                <pre className="p-5 overflow-x-auto text-xs font-mono leading-relaxed text-slate-100 bg-slate-900 max-h-[540px]">
                  <code>{activeFile.content}</code>
                </pre>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
