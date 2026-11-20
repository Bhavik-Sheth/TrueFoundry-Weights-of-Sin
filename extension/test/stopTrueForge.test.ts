import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { findListeningPids, parseNetstatPids, stopTrueForgeOnPort } from '../src/run/trueforgeProcess';

describe('parseNetstatPids', () => {
  const out = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:8791         0.0.0.0:0              LISTENING       21768',
    '  TCP    [::1]:8790             [::]:0                 LISTENING       10196',
    '  TCP    0.0.0.0:18790          0.0.0.0:0              LISTENING       555',
    '  TCP    127.0.0.1:50000        127.0.0.1:8790         ESTABLISHED     777',
  ].join('\r\n');

  it('returns only the listener on exactly that port', () => {
    expect(parseNetstatPids(out, 8790)).toEqual([10196]);
    expect(parseNetstatPids(out, 8791)).toEqual([21768]);
  });

  it('ignores established connections and other ports', () => {
    expect(parseNetstatPids(out, 50000)).toEqual([]);
    expect(parseNetstatPids(out, 9999)).toEqual([]);
  });
});

describe('stopTrueForgeOnPort (live)', () => {
  it('stops a process listening on a local port', async () => {
    const port = await new Promise<number>((res) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
    });
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1')`], { stdio: 'ignore' });
    const exited = new Promise<void>((r) => child.on('exit', () => r()));
    for (let i = 0; i < 50 && (await findListeningPids(port)).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const stopped = await stopTrueForgeOnPort(port, () => undefined);
    expect(stopped).toContain(child.pid);
    await exited;
    expect(await findListeningPids(port)).toEqual([]);
  }, 20000);
});
