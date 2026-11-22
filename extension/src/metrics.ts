import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const tenths = (ms: number): number => Math.round(ms * 10) / 10;

export function startLoopMonitor(resolutionMs = 20) {
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  const toMs = (ns: number) => tenths(ns / 1e6);
  return {
    snapshot() {
      if (!histogram.count) return { p50Ms: 0, p95Ms: 0, maxMs: 0 };
      return {
        p50Ms: toMs(histogram.percentile(50)),
        p95Ms: toMs(histogram.percentile(95)),
        maxMs: toMs(histogram.max),
      };
    },
    dispose() { histogram.disable(); },
  };
}

export class Timer {
  private constructor(private readonly started: number) {}

  static start(): Timer {
    return new Timer(performance.now());
  }

  elapsedMs(): number {
    return tenths(performance.now() - this.started);
  }
}
