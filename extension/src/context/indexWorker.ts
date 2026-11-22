import { parentPort, workerData } from 'node:worker_threads';
import { loadParser, parsePython } from './indexer';
import type { ParseRequest, ParserMessage, PythonParseResult } from './workerParser';

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('The Python index worker requires a parent port');
  const parser = await loadParser(workerData.wasmDir);
  const post = (message: ParserMessage) => port.postMessage(message);
  port.on('message', ({ id, path, text }: ParseRequest) => {
    try {
      let imports: PythonParseResult['imports'] = [];
      const symbols = parsePython(parser, path, text, bindings => { imports = [...bindings]; });
      post({ id, symbols, imports });
    } catch (error) {
      post({ id, error: String(error) });
    }
  });
  post({ ready: true });
}

void main().catch(error => { setImmediate(() => { throw error; }); });
