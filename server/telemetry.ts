import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { PlatformId, StreamEventLog, TelemetrySnapshot } from './types.ts';

class TelemetryStore extends EventEmitter {
  private streamsCompleted = 0;
  private streamsFailed = 0;
  private bytesStreamed = 0;
  private activeWorkers = 0;
  private peakThroughputMbps = 0;
  private recentEvents: StreamEventLog[] = [];
  private readonly maxLogs = 80;

  getSnapshot(): TelemetrySnapshot {
    return {
      streamsCompleted: this.streamsCompleted,
      streamsFailed: this.streamsFailed,
      bytesStreamed: this.bytesStreamed,
      diskBytesWritten: 0,
      activeWorkers: this.activeWorkers,
      peakThroughputMbps: Number(this.peakThroughputMbps.toFixed(2)),
      recentEvents: [...this.recentEvents],
    };
  }

  incrementActiveWorkers(): void {
    this.activeWorkers += 1;
    this.emitUpdate();
  }

  decrementActiveWorkers(): void {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    this.emitUpdate();
  }

  recordStreamCompleted(bytes: number, durationMs: number): void {
    this.streamsCompleted += 1;
    this.bytesStreamed += bytes;
    if (durationMs > 0 && bytes > 0) {
      const mbps = (bytes * 8) / (durationMs / 1000) / 1_000_000;
      if (mbps > this.peakThroughputMbps && Number.isFinite(mbps)) {
        this.peakThroughputMbps = mbps;
      }
    }
    this.emitUpdate();
  }

  recordStreamBytes(chunkBytes: number): void {
    this.bytesStreamed += chunkBytes;
  }

  recordStreamFailed(): void {
    this.streamsFailed += 1;
    this.emitUpdate();
  }

  logEvent(entry: {
    source: 'telegram' | 'sandbox' | 'system';
    level: 'info' | 'success' | 'warning' | 'error';
    platform?: PlatformId;
    chatLabel?: string;
    message: string;
    bytesStreamed?: number;
    durationMs?: number;
  }): StreamEventLog {
    const event: StreamEventLog = {
      id: randomUUID(),
      timestamp: Date.now(),
      ...entry,
    };
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.maxLogs) {
      this.recentEvents.length = this.maxLogs;
    }
    this.emit('log', event);
    this.emitUpdate();
    return event;
  }

  private emitUpdate(): void {
    this.emit('snapshot', this.getSnapshot());
  }
}

export const telemetry = new TelemetryStore();
