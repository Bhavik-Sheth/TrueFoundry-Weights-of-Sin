import { Worker } from 'node:worker_threads';
import type { SymbolEntry } from '../types';
import type { ImportBinding } from './indexer';

export interface ParseRequest {
  id: number;
  path: string;
  text: string;
}

export interface PythonParseResult {
  symbols: SymbolEntry[];
  imports: Array<[string, ImportBinding]>;
}

export type ParserMessage =
  | { ready: true }
  | ({ id: number } & (PythonParseResult | { error: string }));

const TIMEOUT_MS = 10_000;

export class WorkerParser {
  private nextId = 0;
  private failure?: Error;
  private termination?: Promise<void>;
  private readonly pending = new Map<number, {
    resolve: (result: PythonParseResult) => void;
    reject: (error: Error) => void;
  }>();

  private constructor(private readonly worker: Worker) {}

  static async start(workerFile: string, wasmDir: string): Promise<WorkerParser> {
    const worker = new Worker(workerFile, { workerData: { wasmDir } });
    const parser = new WorkerParser(worker);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('PARSER_START_TIMEOUT')), TIMEOUT_MS);
        const fail = (error: Error) => {
          parser.fail(error);
          reject(error);
        };
        worker.on('error', fail);
        worker.on('exit', code => fail(new Error(`Python parser worker exited with code ${code}`)));
        worker.on('message', (message: ParserMessage) => {
          if ('ready' in message) {
            resolve();
            return;
          }
          const request = parser.pending.get(message.id);
          if (!request) return;
          if ('error' in message) request.reject(new Error(message.error));
          else request.resolve({ symbols: message.symbols, imports: message.imports });
        });
      });
      return parser;
    } catch (error) {
      await parser.dispose();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async parse(path: string, text: string): Promise<SymbolEntry[]> {
    return (await this.parseFull(path, text)).symbols;
  }

  async parseFull(path: string, text: string): Promise<PythonParseResult> {
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.pending.get(id)?.reject(new Error('PARSE_TIMEOUT')), TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        resolve: result => { cleanup(); resolve(result); },
        reject: error => { cleanup(); reject(error); },
      });
      try {
        this.worker.postMessage({ id, path, text } satisfies ParseRequest);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(this.failure);
  }

  dispose(): Promise<void> {
    this.fail(new Error('Python parser worker disposed'));
    return this.termination ??= this.worker.terminate().then(() => undefined);
  }
}
