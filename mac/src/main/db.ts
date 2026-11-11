// 로컬 영속 저장 — node:sqlite(내장 SQLite). 네이티브 모듈 빌드가 필요 없다.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type {
  Agent, AgentFields, Artifact, Attempt, AttemptEvent, CheckResult, Deliverable, GraphVersion, PlanFields,
  PlanVersion, Project, ReviewRecord, Run, RunNodeState, WorkGraph,
} from '../shared/types';

export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, plan TEXT NOT NULL, plan_version INTEGER NOT NULL, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS plan_versions (project_id TEXT, version INTEGER, plan TEXT, changed TEXT, created_at TEXT, PRIMARY KEY(project_id, version));
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, project_id TEXT, version INTEGER, fields TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS agent_versions (agent_id TEXT, version INTEGER, fields TEXT, created_at TEXT, PRIMARY KEY(agent_id, version));
CREATE TABLE IF NOT EXISTS graph_versions (id TEXT PRIMARY KEY, project_id TEXT, version INTEGER, graph TEXT, hash TEXT, note TEXT, created_at TEXT, UNIQUE(project_id, version));
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT, graph_version_id TEXT, graph_version INTEGER, plan_version INTEGER, status TEXT, executor TEXT, parent_run_id TEXT, start_node_id TEXT, reason TEXT, plan_snapshot TEXT, agents_snapshot TEXT, seed TEXT, created_at TEXT, updated_at TEXT, finished_at TEXT);
CREATE TABLE IF NOT EXISTS run_nodes (run_id TEXT, node_id TEXT, status TEXT, visits INTEGER, last_attempt_id TEXT, summary TEXT, failure_reason TEXT, next_action TEXT, resolution TEXT, updated_at TEXT, PRIMARY KEY(run_id, node_id));
CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, visit INTEGER, attempt_no INTEGER, role TEXT, data TEXT, status TEXT, UNIQUE(run_id, node_id, visit, attempt_no, role));
CREATE TABLE IF NOT EXISTS attempt_events (attempt_id TEXT, seq INTEGER, at TEXT, kind TEXT, summary TEXT, raw TEXT, PRIMARY KEY(attempt_id, seq));
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, attempt_id TEXT, path TEXT, rel_path TEXT, kind TEXT, sha256 TEXT, size INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, attempt_id TEXT, name TEXT, argv TEXT, exit_code INTEGER, ok INTEGER, output TEXT, duration_ms INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, kind TEXT, reviewer_agent_id TEXT, verdict TEXT, comments TEXT, target_node_id TEXT, subject_hash TEXT, graph_version_id TEXT, stale INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS deliverables (run_id TEXT, hash TEXT, report_path TEXT, goal TEXT, done_criteria TEXT, markdown TEXT, created_at TEXT, PRIMARY KEY(run_id, hash));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_attempts_run ON attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
`;

type Row = Record<string, unknown>;
const j = <T>(v: unknown): T => JSON.parse(String(v)) as T;

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
    this.db.prepare(`INSERT OR IGNORE INTO meta(key,value) VALUES('schema','1')`).run();
  }
  close() { this.db.close(); }

  private txDepth = 0;
  /** 동기 트랜잭션. 안쪽에서 다시 호출하면 바깥 트랜잭션에 합쳐진다. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.txDepth++;
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } finally { this.txDepth--; }
  }

  // ───── settings ─────
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as Row | undefined;
    return r ? j<T>(r.value) : fallback;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }

  // ───── projects ─────
  private toProject(r: Row): Project {
    return { id: String(r.id), plan: j(r.plan), planVersion: Number(r.plan_version), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }
  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Row[]).map((r) => this.toProject(r));
  }
  getProject(id: string): Project {
    const r = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new Error('프로젝트를 찾을 수 없습니다.');
    return this.toProject(r);
  }
  createProject(plan: PlanFields): Project {
    const id = uid(); const t = now();
    this.tx(() => {
      this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(id, JSON.stringify(plan), 1, t, t);
      this.db.prepare('INSERT INTO plan_versions VALUES(?,?,?,?,?)').run(id, 1, JSON.stringify(plan), JSON.stringify(Object.keys(plan)), t);
    });
    return this.getProject(id);
  }
  updatePlan(id: string, plan: PlanFields): Project {
    const cur = this.getProject(id);
    const changed = (Object.keys(plan) as (keyof PlanFields)[]).filter((k) => JSON.stringify(plan[k]) !== JSON.stringify(cur.plan[k]));
    if (changed.length === 0) return cur;
    const v = cur.planVersion + 1; const t = now();
    this.tx(() => {
      this.db.prepare('UPDATE projects SET plan=?, plan_version=?, updated_at=? WHERE id=?').run(JSON.stringify(plan), v, t, id);
      this.db.prepare('INSERT INTO plan_versions VALUES(?,?,?,?,?)').run(id, v, JSON.stringify(plan), JSON.stringify(changed), t);
    });
    return this.getProject(id);
  }
  planHistory(id: string): PlanVersion[] {
    return (this.db.prepare('SELECT * FROM plan_versions WHERE project_id=? ORDER BY version DESC').all(id) as Row[]).map((r) => ({
      projectId: String(r.project_id), version: Number(r.version), plan: j(r.plan), changedFields: j(r.changed), createdAt: String(r.created_at),
    }));
  }

  // ───── agents ─────
  private toAgent(r: Row): Agent {
    return { ...(j<AgentFields>(r.fields)), id: String(r.id), projectId: String(r.project_id), version: Number(r.version), updatedAt: String(r.updated_at) };
  }
  listAgents(projectId: string): Agent[] {
    return (this.db.prepare('SELECT * FROM agents WHERE project_id=?').all(projectId) as Row[]).map((r) => this.toAgent(r))
      .sort((a, b) => a.code.localeCompare(b.code, 'ko') || a.name.localeCompare(b.name, 'ko'));
  }
  getAgent(id: string): Agent {
    const r = this.db.prepare('SELECT * FROM agents WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new Error('직원을 찾을 수 없습니다.');
    return this.toAgent(r);
  }
  saveAgent(projectId: string, agentId: string | null, fields: AgentFields): Agent {
    const t = now();
    if (!agentId) {
      const id = uid();
      this.tx(() => {
        this.db.prepare('INSERT INTO agents VALUES(?,?,?,?,?)').run(id, projectId, 1, JSON.stringify(fields), t);
        this.db.prepare('INSERT INTO agent_versions VALUES(?,?,?,?)').run(id, 1, JSON.stringify(fields), t);
      });
      return this.getAgent(id);
    }
    const cur = this.getAgent(agentId);
    const { id: _i, projectId: _p, version: _v, updatedAt: _u, ...curFields } = cur;
    if (JSON.stringify(curFields) === JSON.stringify({ ...curFields, ...fields })) return cur;
    const v = cur.version + 1;
    this.tx(() => {
      this.db.prepare('UPDATE agents SET fields=?, version=?, updated_at=? WHERE id=?').run(JSON.stringify(fields), v, t, agentId);
      this.db.prepare('INSERT INTO agent_versions VALUES(?,?,?,?)').run(agentId, v, JSON.stringify(fields), t);
    });
    return this.getAgent(agentId);
  }

  // ───── graphs ─────
  private toGraph(r: Row): GraphVersion {
    return { id: String(r.id), projectId: String(r.project_id), version: Number(r.version), graph: j(r.graph), hash: String(r.hash), note: String(r.note ?? ''), createdAt: String(r.created_at) };
  }
  /** 사용자가 편집하는 흐름의 최신 버전. 운영 루프가 사이클마다 만드는 흐름(메모 '미션 …')은 제외한다. */
  latestGraph(projectId: string): GraphVersion | null {
    const r = this.db.prepare("SELECT * FROM graph_versions WHERE project_id=? AND COALESCE(note,'') NOT LIKE '미션 %' ORDER BY version DESC LIMIT 1").get(projectId) as Row | undefined;
    return r ? this.toGraph(r) : null;
  }
  listGraphVersions(projectId: string): GraphVersion[] {
    return (this.db.prepare('SELECT * FROM graph_versions WHERE project_id=? ORDER BY version DESC').all(projectId) as Row[]).map((r) => this.toGraph(r));
  }
  getGraphVersion(id: string): GraphVersion {
    const r = this.db.prepare('SELECT * FROM graph_versions WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new Error('흐름 버전을 찾을 수 없습니다.');
    return this.toGraph(r);
  }
  saveGraph(projectId: string, graph: WorkGraph, note: string): GraphVersion {
    const body = JSON.stringify(graph); const hash = sha256(body);
    const isMission = note.startsWith('미션 ');
    const latest = isMission ? null : this.latestGraph(projectId);
    if (latest && latest.hash === hash) return latest;
    const max = this.db.prepare('SELECT COALESCE(MAX(version),0) v FROM graph_versions WHERE project_id=?').get(projectId) as Row;
    const id = uid(); const v = Number(max.v) + 1;
    this.db.prepare('INSERT INTO graph_versions VALUES(?,?,?,?,?,?,?)').run(id, projectId, v, body, hash, note, now());
    return this.getGraphVersion(id);
  }

  // ───── runs ─────
  private toRun(r: Row): Run {
    return {
      id: String(r.id), projectId: String(r.project_id), graphVersionId: String(r.graph_version_id), graphVersion: Number(r.graph_version),
      planVersion: Number(r.plan_version), status: r.status as Run['status'], executor: r.executor as Run['executor'],
      parentRunId: (r.parent_run_id as string) ?? null, startNodeId: (r.start_node_id as string) ?? null, reason: String(r.reason ?? ''),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at), finishedAt: (r.finished_at as string) ?? null,
    };
  }
  createRun(p: { projectId: string; graph: GraphVersion; plan: Project; agents: Agent[]; executor: Run['executor']; parentRunId?: string | null; startNodeId?: string | null; seed?: unknown }): Run {
    const id = uid(); const t = now();
    this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, p.projectId, p.graph.id, p.graph.version, p.plan.planVersion, 'queued', p.executor, p.parentRunId ?? null, p.startNodeId ?? null, '',
      JSON.stringify(p.plan.plan), JSON.stringify(p.agents), JSON.stringify(p.seed ?? null), t, t, null);
    for (const n of p.graph.graph.nodes) {
      this.db.prepare('INSERT INTO run_nodes VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, n.id, 'waiting', 0, null, '', '', '', null, t);
    }
    return this.getRun(id);
  }
  getRun(id: string): Run {
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new Error('실행을 찾을 수 없습니다.');
    return this.toRun(r);
  }
  runSnapshot(id: string): { plan: PlanFields; agents: Agent[]; seed: unknown } {
    const r = this.db.prepare('SELECT plan_snapshot, agents_snapshot, seed FROM runs WHERE id=?').get(id) as Row;
    return { plan: j(r.plan_snapshot), agents: j(r.agents_snapshot), seed: j(r.seed) };
  }
  listRuns(projectId: string): Run[] {
    return (this.db.prepare('SELECT * FROM runs WHERE project_id=? ORDER BY created_at DESC').all(projectId) as Row[]).map((r) => this.toRun(r));
  }
  runsWithStatus(statuses: string[]): Run[] {
    const q = `SELECT * FROM runs WHERE status IN (${statuses.map(() => '?').join(',')})`;
    return (this.db.prepare(q).all(...statuses) as Row[]).map((r) => this.toRun(r));
  }
  setRunStatus(id: string, status: Run['status'], reason?: string): Run {
    const fin = ['succeeded', 'failed', 'cancelled'].includes(status) ? now() : null;
    this.db.prepare('UPDATE runs SET status=?, reason=COALESCE(?, reason), updated_at=?, finished_at=COALESCE(?, finished_at) WHERE id=?').run(status, reason ?? null, now(), fin, id);
    return this.getRun(id);
  }

  // ───── run nodes ─────
  private toNode(r: Row): RunNodeState {
    return {
      runId: String(r.run_id), nodeId: String(r.node_id), status: r.status as RunNodeState['status'], visits: Number(r.visits),
      lastAttemptId: (r.last_attempt_id as string) ?? null, summary: String(r.summary ?? ''), failureReason: String(r.failure_reason ?? ''),
      nextAction: String(r.next_action ?? ''), updatedAt: String(r.updated_at),
    };
  }
  runNodes(runId: string): RunNodeState[] {
    return (this.db.prepare('SELECT * FROM run_nodes WHERE run_id=?').all(runId) as Row[]).map((r) => this.toNode(r));
  }
  getRunNode(runId: string, nodeId: string): RunNodeState {
    return this.toNode(this.db.prepare('SELECT * FROM run_nodes WHERE run_id=? AND node_id=?').get(runId, nodeId) as Row);
  }
  updateRunNode(runId: string, nodeId: string, patch: Partial<Omit<RunNodeState, 'runId' | 'nodeId' | 'updatedAt'>>): RunNodeState {
    const cur = this.getRunNode(runId, nodeId);
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE run_nodes SET status=?, visits=?, last_attempt_id=?, summary=?, failure_reason=?, next_action=?, updated_at=? WHERE run_id=? AND node_id=?')
      .run(n.status, n.visits, n.lastAttemptId, n.summary, n.failureReason, n.nextAction, now(), runId, nodeId);
    return this.getRunNode(runId, nodeId);
  }
  getResolution(runId: string, nodeId: string): string | null {
    const r = this.db.prepare('SELECT resolution FROM run_nodes WHERE run_id=? AND node_id=?').get(runId, nodeId) as Row | undefined;
    return (r?.resolution as string) ?? null;
  }
  setResolution(runId: string, nodeId: string, v: string | null) {
    this.db.prepare('UPDATE run_nodes SET resolution=? WHERE run_id=? AND node_id=?').run(v, runId, nodeId);
  }

  // ───── attempts ─────
  insertAttempt(a: Attempt) {
    this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?)').run(a.id, a.runId, a.nodeId, a.visit, a.attemptNo, a.role, JSON.stringify(a), a.status);
  }
  saveAttempt(a: Attempt) {
    this.db.prepare('UPDATE attempts SET data=?, status=? WHERE id=?').run(JSON.stringify(a), a.status, a.id);
  }
  findAttempts(runId: string, nodeId: string, visit: number, role?: string): Attempt[] {
    const rows = (role
      ? this.db.prepare('SELECT data FROM attempts WHERE run_id=? AND node_id=? AND visit=? AND role=? ORDER BY attempt_no').all(runId, nodeId, visit, role)
      : this.db.prepare('SELECT data FROM attempts WHERE run_id=? AND node_id=? AND visit=? ORDER BY attempt_no').all(runId, nodeId, visit)) as Row[];
    return rows.map((r) => j<Attempt>(r.data));
  }
  runAttempts(runId: string): Attempt[] {
    return (this.db.prepare('SELECT data FROM attempts WHERE run_id=?').all(runId) as Row[]).map((r) => j<Attempt>(r.data))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  getAttempt(id: string): Attempt | null {
    const r = this.db.prepare('SELECT data FROM attempts WHERE id=?').get(id) as Row | undefined;
    return r ? j<Attempt>(r.data) : null;
  }
  attemptsWithStatus(status: string): Attempt[] {
    return (this.db.prepare('SELECT data FROM attempts WHERE status=?').all(status) as Row[]).map((r) => j<Attempt>(r.data));
  }
  addEvent(e: AttemptEvent) {
    this.db.prepare('INSERT OR REPLACE INTO attempt_events VALUES(?,?,?,?,?,?)').run(e.attemptId, e.seq, e.at, e.kind, e.summary, e.raw);
  }
  events(attemptId: string): AttemptEvent[] {
    return (this.db.prepare('SELECT * FROM attempt_events WHERE attempt_id=? ORDER BY seq').all(attemptId) as Row[]).map((r) => ({
      attemptId: String(r.attempt_id), seq: Number(r.seq), at: String(r.at), kind: r.kind as AttemptEvent['kind'], summary: String(r.summary), raw: String(r.raw),
    }));
  }

  // ───── artifacts / checks / reviews / deliverables ─────
  addArtifact(a: Artifact) {
    this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?)').run(a.id, a.runId, a.nodeId, a.attemptId, a.path, a.relPath, a.kind, a.sha256, a.size, a.createdAt);
  }
  artifacts(runId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at').all(runId) as Row[]).map((r) => ({
      id: String(r.id), runId: String(r.run_id), nodeId: String(r.node_id), attemptId: (r.attempt_id as string) ?? null, path: String(r.path),
      relPath: String(r.rel_path), kind: r.kind as Artifact['kind'], sha256: String(r.sha256), size: Number(r.size), createdAt: String(r.created_at),
    }));
  }
  addCheck(c: CheckResult) {
    this.db.prepare('INSERT INTO checks VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(c.id, c.runId, c.nodeId, c.attemptId, c.name, JSON.stringify(c.argv), c.exitCode, c.ok ? 1 : 0, c.output, c.durationMs, c.createdAt);
  }
  checks(runId: string): CheckResult[] {
    return (this.db.prepare('SELECT * FROM checks WHERE run_id=? ORDER BY created_at').all(runId) as Row[]).map((r) => ({
      id: String(r.id), runId: String(r.run_id), nodeId: String(r.node_id), attemptId: String(r.attempt_id), name: String(r.name), argv: j(r.argv),
      exitCode: r.exit_code === null ? null : Number(r.exit_code), ok: Number(r.ok) === 1, output: String(r.output), durationMs: Number(r.duration_ms), createdAt: String(r.created_at),
    }));
  }
  addReview(rv: ReviewRecord) {
    this.db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(rv.id, rv.runId, rv.nodeId, rv.kind, rv.reviewerAgentId, rv.verdict, rv.comments, rv.targetNodeId, rv.subjectHash, rv.graphVersionId, rv.stale ? 1 : 0, rv.createdAt);
  }
  reviews(runId: string): ReviewRecord[] {
    return (this.db.prepare('SELECT * FROM reviews WHERE run_id=? ORDER BY created_at').all(runId) as Row[]).map((r) => ({
      id: String(r.id), runId: String(r.run_id), nodeId: String(r.node_id), kind: r.kind as ReviewRecord['kind'], reviewerAgentId: (r.reviewer_agent_id as string) ?? null,
      verdict: r.verdict as ReviewRecord['verdict'], comments: String(r.comments ?? ''), targetNodeId: (r.target_node_id as string) ?? null,
      subjectHash: String(r.subject_hash), graphVersionId: String(r.graph_version_id), stale: Number(r.stale) === 1, createdAt: String(r.created_at),
    }));
  }
  markReviewsStale(runId: string, nodeId: string, exceptHash: string) {
    this.db.prepare("UPDATE reviews SET stale=1 WHERE run_id=? AND node_id=? AND kind='user' AND subject_hash<>?").run(runId, nodeId, exceptHash);
  }
  saveDeliverable(d: Deliverable) {
    this.db.prepare('INSERT OR REPLACE INTO deliverables VALUES(?,?,?,?,?,?,?)').run(d.runId, d.hash, d.reportPath, d.goal, d.doneCriteria, d.markdown, d.createdAt);
  }
  latestDeliverable(runId: string): Deliverable | null {
    const r = this.db.prepare('SELECT * FROM deliverables WHERE run_id=? ORDER BY created_at DESC LIMIT 1').get(runId) as Row | undefined;
    return r ? { runId: String(r.run_id), hash: String(r.hash), reportPath: String(r.report_path), goal: String(r.goal), doneCriteria: String(r.done_criteria), markdown: String(r.markdown), createdAt: String(r.created_at) } : null;
  }
}
