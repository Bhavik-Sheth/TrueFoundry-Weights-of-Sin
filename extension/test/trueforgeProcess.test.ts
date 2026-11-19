import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { checkNode, ensureTrueForge, isLocalUrl, portOf } from '../src/run/trueforgeProcess';

describe('trueforgeProcess', () => {
  it('url helpers', () => {
    expect(isLocalUrl('http://localhost:8790')).toBe(true);
    expect(isLocalUrl('http://example.com:8790')).toBe(false);
    expect(portOf('http://localhost:8790')).toBe(8790);
  });
  it('checkNode', async () => {
    expect((await checkNode(async () => 'v22.17.1\n')).ok).toBe(true);
    expect((await checkNode(async () => 'v20.0.0')).ok).toBe(false);
    expect((await checkNode(async () => { throw new Error('x'); })).ok).toBe(false);
  });
  it('does not start (or stop) an already running TrueForge', async () => {
    const spawnFn = vi.fn();
    const h = await ensureTrueForge({ url: 'http://localhost:8790', autoStart: true, ping: async () => true, log: () => undefined, spawnFn: spawnFn as never });
    expect(h.startedByUs).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it('reports node-missing without spawning', async () => {
    const spawnFn = vi.fn();
    const h = await ensureTrueForge({ url: 'http://localhost:8790', autoStart: true, ping: async () => false, log: () => undefined, nodeVersion: async () => 'v18.0.0', spawnFn: spawnFn as never });
    expect(h.state).toBe('node-missing');
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it('spawns locally and polls until healthy', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined });
    let n = 0;
    const h = await ensureTrueForge({
      url: 'http://localhost:9999', autoStart: true, ping: async () => ++n > 3, log: () => undefined, pollMs: 1,
      nodeVersion: async () => 'v22.17.1', spawnFn: () => child as never,
    });
    expect(h.startedByUs).toBe(true);
    expect(h.state).toBe('running');
  });
  it('never auto-starts for a remote URL', async () => {
    const h = await ensureTrueForge({ url: 'https://tf.example.com', autoStart: true, ping: async () => false, log: () => undefined });
    expect(h.state).toBe('down');
  });
});
