import { describe, expect, it } from 'vitest';
import { startLoopMonitor, Timer } from '../src/metrics';

describe('performance metrics', () => {
  it('reports sampled delay in milliseconds', async () => {
    const monitor = startLoopMonitor(10);
    try {
      expect(monitor.snapshot()).toEqual({ p50Ms: 0, p95Ms: 0, maxMs: 0 });
      await new Promise(resolve => setTimeout(resolve, 60));
      const { p50Ms, p95Ms, maxMs } = monitor.snapshot();
      expect(p50Ms).toBeGreaterThan(0);
      expect(p95Ms).toBeGreaterThanOrEqual(p50Ms);
      expect(maxMs).toBeGreaterThanOrEqual(p95Ms);
    } finally {
      monitor.dispose();
    }
  });

  it('times elapsed work with a monotonic clock', async () => {
    const timer = Timer.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(timer.elapsedMs()).toBeGreaterThan(0);
  });
});
