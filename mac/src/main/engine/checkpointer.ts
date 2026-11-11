// LangGraph 체크포인트 저장소 — node:sqlite 구현.
// @langchain/langgraph-checkpoint-sqlite 1.1.0(MIT, LangChain)의 SqliteSaver를 better-sqlite3 대신
// 내장 node:sqlite(DatabaseSync)로 옮겼다. Electron 45의 V8에서 better-sqlite3가 빌드되지 않기 때문이다.
import type { DatabaseSync } from 'node:sqlite';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver, TASKS, WRITES_IDX_MAP, compareWritesSortKeys, copyCheckpoint, writesSortKey,
  type Checkpoint, type CheckpointListOptions, type CheckpointMetadata, type CheckpointTuple, type PendingWrite,
} from '@langchain/langgraph-checkpoint';

type WriteCol = { task_id: string; channel: string; type: string | null; value: string | null; task_path?: string; idx?: number };

function sortWrites(cols: WriteCol[]): WriteCol[] {
  return cols
    .map((c) => ({ key: writesSortKey(c.task_path ?? '', c.task_id, c.idx ?? 0), c }))
    .sort((a, b) => compareWritesSortKeys(a.key, b.key))
    .map(({ c }) => c);
}

const SELECT = `
  SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata,
  (SELECT json_group_array(json_object('task_id', pw.task_id, 'channel', pw.channel, 'type', pw.type,
      'value', CAST(pw.value AS TEXT), 'task_path', pw.task_path, 'idx', pw.idx))
   FROM lg_writes AS pw WHERE pw.thread_id = c.thread_id AND pw.checkpoint_ns = c.checkpoint_ns AND pw.checkpoint_id = c.checkpoint_id) AS pending_writes
  FROM lg_checkpoints AS c`;

type CkRow = { thread_id: string; checkpoint_ns: string; checkpoint_id: string; parent_checkpoint_id: string | null; type: string | null; checkpoint: Uint8Array; metadata: Uint8Array; pending_writes: string };

export class NodeSqliteSaver extends BaseCheckpointSaver {
  constructor(private db: DatabaseSync) {
    super();
    db.exec(`
CREATE TABLE IF NOT EXISTS lg_checkpoints (thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB, PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));
CREATE TABLE IF NOT EXISTS lg_writes (thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL, task_path TEXT NOT NULL DEFAULT '', idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));`);
  }

  private async toTuple(row: CkRow, checkpoint_ns: string): Promise<CheckpointTuple> {
    const pendingWrites = await Promise.all(sortWrites(JSON.parse(row.pending_writes) as WriteCol[]).map(async (w) =>
      [w.task_id, w.channel, await this.serde.loadsTyped(w.type ?? 'json', w.value ?? '')] as [string, string, unknown]));
    return {
      config: { configurable: { thread_id: row.thread_id, checkpoint_ns, checkpoint_id: row.checkpoint_id } },
      checkpoint: (await this.serde.loadsTyped(row.type ?? 'json', row.checkpoint)) as Checkpoint,
      metadata: (await this.serde.loadsTyped(row.type ?? 'json', row.metadata)) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id ? { configurable: { thread_id: row.thread_id, checkpoint_ns, checkpoint_id: row.parent_checkpoint_id } } : undefined,
      pendingWrites,
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns = '', checkpoint_id } = (config.configurable ?? {}) as Record<string, string>;
    const row = (checkpoint_id
      ? this.db.prepare(`${SELECT} WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`).get(thread_id, checkpoint_ns, checkpoint_id)
      : this.db.prepare(`${SELECT} WHERE thread_id=? AND checkpoint_ns=? ORDER BY checkpoint_id DESC LIMIT 1`).get(thread_id, checkpoint_ns)) as CkRow | undefined;
    if (!row) return undefined;
    return this.toTuple(row, checkpoint_ns);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    const thread_id = config.configurable?.thread_id as string | undefined;
    const checkpoint_ns = config.configurable?.checkpoint_ns as string | undefined;
    const where: string[] = []; const args: (string | number)[] = [];
    if (thread_id) { where.push('thread_id = ?'); args.push(thread_id); }
    if (checkpoint_ns !== undefined && checkpoint_ns !== null) { where.push('checkpoint_ns = ?'); args.push(checkpoint_ns); }
    const beforeId = before?.configurable?.checkpoint_id as string | undefined;
    if (beforeId !== undefined) { where.push('checkpoint_id < ?'); args.push(beforeId); }
    for (const [k, v] of Object.entries(filter ?? {})) {
      if (v === undefined) continue;
      where.push(`json_extract(CAST(metadata AS TEXT), ?) = json(?)`); args.push(`$.${k}`, JSON.stringify(v));
    }
    let sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY checkpoint_id DESC';
    if (limit) sql += ` LIMIT ${Math.floor(Number(limit))}`;
    for (const row of this.db.prepare(sql).all(...args) as CkRow[]) yield await this.toTuple(row, row.checkpoint_ns);
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const thread_id = config.configurable?.thread_id as string;
    const checkpoint_ns = (config.configurable?.checkpoint_ns as string) ?? '';
    const parent = (config.configurable?.checkpoint_id as string) ?? null;
    if (!thread_id) throw new Error('Missing thread_id');
    const [[t1, ck], [t2, md]] = await Promise.all([this.serde.dumpsTyped(copyCheckpoint(checkpoint)), this.serde.dumpsTyped(metadata)]);
    if (t1 !== t2) throw new Error('serializer type mismatch');
    this.db.prepare('INSERT OR REPLACE INTO lg_checkpoints VALUES(?,?,?,?,?,?,?)').run(thread_id, checkpoint_ns, checkpoint.id, parent, t1, ck as Uint8Array, md as Uint8Array);
    return { configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
    const c = config.configurable ?? {};
    if (!c.thread_id || !c.checkpoint_id) throw new Error('Missing thread_id/checkpoint_id');
    const allSpecial = writes.every(([ch]) => ch in WRITES_IDX_MAP);
    const rows = await Promise.all(writes.map(async (w, idx) => {
      const [type, val] = await this.serde.dumpsTyped(w[1]);
      return [c.thread_id, c.checkpoint_ns ?? '', c.checkpoint_id, taskId, taskPath ?? '', WRITES_IDX_MAP[w[0]] ?? idx, w[0], type, val] as const;
    }));
    const stmt = this.db.prepare(`INSERT ${allSpecial ? 'OR REPLACE' : 'OR IGNORE'} INTO lg_writes VALUES(?,?,?,?,?,?,?,?,?)`);
    this.db.exec('BEGIN');
    try { for (const r of rows) stmt.run(...(r as unknown as (string | number | Uint8Array)[])); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.prepare('DELETE FROM lg_checkpoints WHERE thread_id=?').run(threadId);
    this.db.prepare('DELETE FROM lg_writes WHERE thread_id=?').run(threadId);
  }
}
export { TASKS };
