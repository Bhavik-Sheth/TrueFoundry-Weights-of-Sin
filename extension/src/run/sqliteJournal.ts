import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RunRecord } from './journal';

type Intent = Omit<RunRecord, 'sequence'>;
type Loader = { DatabaseSync: typeof DatabaseSync };

function observation(event: RunRecord['evidence']): string | null {
  return event.kind === 'check' && event.externalId ? JSON.stringify([event.source, event.externalId]) : null;
}

export class SqliteJournal {
  private database?: Promise<DatabaseSync>;

  static supported(directory: string, report: (error: unknown) => void): SqliteJournal | undefined {
    let driver: Loader;
    try {
      driver = require('node:sqlite') as Loader;
    } catch (error) {
      if (['ERR_UNKNOWN_BUILTIN_MODULE', 'MODULE_NOT_FOUND'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    return new SqliteJournal(directory, driver.DatabaseSync, report);
  }

  private constructor(
    private directory: string,
    private Database: typeof DatabaseSync,
    private report: (error: unknown) => void,
  ) {}

  private connect(): Promise<DatabaseSync> {
    this.database ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const location = join(this.directory, 'journal.sqlite');
      const file = await open(location, 'a', 0o600);
      await file.close();
      const db = new this.Database(location);
      try {
        db.exec(`
          PRAGMA busy_timeout = 5000;
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = FULL;
          CREATE TABLE IF NOT EXISTS journal_runs (
            run_id TEXT PRIMARY KEY,
            legacy_sha256 TEXT,
            legacy_count INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS journal_events (
            run_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            record TEXT NOT NULL,
            observation_key TEXT,
            PRIMARY KEY (run_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS journal_observation ON journal_events (run_id, observation_key, sequence);
          CREATE INDEX IF NOT EXISTS journal_evidence_kind
            ON journal_events (run_id, json_extract(record, '$.evidence.kind'), sequence);
          CREATE TABLE IF NOT EXISTS journal_review (
            run_id TEXT NOT NULL,
            proposal_key TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            record TEXT NOT NULL,
            PRIMARY KEY (run_id, proposal_key)
          );
        `);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    })();
    return this.database;
  }

  async append(intent: Intent, legacyFile: string): Promise<void> {
    const db = await this.connect();
    const known = db.prepare('SELECT 1 FROM journal_runs WHERE run_id = ?');
    const legacy = known.get(intent.runId) ? undefined : await readFile(legacyFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });

    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare('INSERT INTO journal_events VALUES (?, ?, ?, ?)');
      const save = (record: RunRecord) => {
        const encoded = JSON.stringify(record);
        insert.run(record.runId, record.sequence, encoded, observation(record.evidence));
        if (record.evidence.kind === 'proposal' || record.evidence.kind === 'review-checkpoint') {
          const key = record.evidence.kind === 'proposal' ? record.evidence.proposal.key : record.evidence.proposalKey;
          db.prepare(`INSERT INTO journal_review VALUES (?, ?, ?, ?)
            ON CONFLICT(run_id, proposal_key) DO UPDATE SET sequence = excluded.sequence, record = excluded.record`)
            .run(record.runId, key, record.sequence, encoded);
        }
      };
      if (!known.get(intent.runId)) {
        const records = new Map<number, RunRecord>();
        let invalid = 0;
        for (const line of legacy?.toString('utf8').split('\n') ?? []) {
          if (!line.trim()) continue;
          let record: RunRecord;
          try {
            record = JSON.parse(line) as RunRecord;
            if (record.runId !== intent.runId || record.version !== 1 ||
                !Number.isSafeInteger(record.sequence) || record.sequence < 1 || typeof record.evidence?.kind !== 'string') {
              throw new Error('Invalid event header');
            }
          } catch {
            invalid++;
            continue;
          }
          const sameSequence = records.get(record.sequence);
          if (sameSequence && JSON.stringify(sameSequence) !== JSON.stringify(record)) {
            throw new Error('Conflicting legacy records for run ' + intent.runId + ', sequence ' + record.sequence);
          }
          records.set(record.sequence, record);
        }
        for (const record of [...records.values()].sort((a, b) => a.sequence - b.sequence)) save(record);
        const observed = db.prepare('SELECT count(*) AS count FROM journal_events WHERE run_id = ?').get(intent.runId);
        if (observed?.count !== records.size) throw new Error('The legacy event count changed during migration.');
        db.prepare('INSERT INTO journal_runs VALUES (?, ?, ?)')
          .run(intent.runId, legacy ? createHash('sha256').update(legacy).digest('hex') : null, records.size);
        if (invalid) this.report(new Error(`${invalid} unreadable event(s) in the preserved legacy journal for ${intent.runId}`));
      }
      const key = observation(intent.evidence);
      const prior = key ? db.prepare(`SELECT record FROM journal_events
        WHERE run_id = ? AND observation_key = ? ORDER BY sequence DESC LIMIT 1`).get(intent.runId, key) : undefined;
      const same = prior && JSON.stringify((JSON.parse(String(prior.record)) as RunRecord).evidence) === JSON.stringify(intent.evidence);
      if (!same) {
        const last = db.prepare('SELECT max(sequence) AS last FROM journal_events WHERE run_id = ?').get(intent.runId);
        save({ ...intent, sequence: Number(last?.last ?? 0) + 1 });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async read(runId: string): Promise<string | undefined> {
    const db = await this.connect();
    if (!db.prepare('SELECT 1 FROM journal_runs WHERE run_id = ?').get(runId)) return;
    const rows = db.prepare('SELECT record FROM journal_events WHERE run_id = ? ORDER BY sequence').all(runId);
    return rows.map(row => row.record).join('\n') + (rows.length ? '\n' : '');
  }

  async continuationRecords(runId: string): Promise<RunRecord[] | undefined> {
    const db = await this.connect();
    if (!db.prepare('SELECT 1 FROM journal_runs WHERE run_id = ?').get(runId)) return;
    const recent = db.prepare(`SELECT record FROM journal_events WHERE run_id = ?
      AND json_extract(record, '$.evidence.kind') = ? ORDER BY sequence DESC LIMIT ?`);
    return (['context', 'proposal', 'check', 'batch-plan'] as const).flatMap(kind =>
      recent.all(runId, kind, kind === 'check' ? 6 : 1).map(row => JSON.parse(String(row.record)) as RunRecord));
  }

  async list(): Promise<string[]> {
    const db = await this.connect();
    return db.prepare('SELECT run_id FROM journal_runs').all().map(row => String(row.run_id));
  }

  async close(): Promise<void> {
    const db = await this.database;
    db?.close();
  }
}
