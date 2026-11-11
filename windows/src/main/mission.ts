// 운영: 오퍼레이터 루프(미션)
// 사용자 지시 → 오퍼레이터 계획(Claude, 구조화 출력) → 사이클 흐름 자동 구성·실행
//   (담당 Agent 수행 → Codex 리뷰 → Claude 재검토 → [검사] → 취합)
// → 오퍼레이터 판단(계속 / 사용자 확인 / 완료) → 사용자가 멈출 때까지 반복
// 오퍼레이터는 작업 완료·검토 필요·추가 정보 필요·사이클 상한 도달 때만 사용자에게 묻는다.
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { Agent, GraphEdge, GraphNode, LiveEvent, Mission, MissionDetail, MissionEvent, MissionFile, MissionGap, ProjectDoc, WorkingItem, MissionSnapshot, MissionStage, MissionStatus, PlanFields, RunDetail, WorkGraph } from '../shared/types';
import { buildClaudeArgs, claudeLimit, cleanEnv, interpretLine, type LimitInfo, type StreamSink, isOurProcess, killGroupAndWait, processStart, redact, redactDeep, startProcess, type ProcessHandle, type ResultInfo } from './cli/claudeCli';
import { now, uid, type Store } from './db';
import type { Engine } from './engine/engine';
import { allowedRoots, escapes, normRel, validateGraph } from './engine/validate';
import { autoLayout } from '../shared/layout';
import { BUILTIN_CHECK } from './checks';
import { missionCommitsSince, revertCommits, tagSnapshot, workspaceHeads, workspaceRepos } from './git';

const PLAN_SCHEMA = {
  type: 'object', required: ['summary', 'question', 'gaps', 'tasks'],
  properties: {
    summary: { type: 'string' }, question: { type: 'string' },
    gaps: { type: 'array', items: { type: 'object', required: ['doc', 'issue', 'need'], properties: { doc: { type: 'string' }, issue: { type: 'string' }, need: { type: 'string' } } } },
    tasks: { type: 'array', items: { type: 'object', required: ['title', 'agentCode', 'instructions', 'writeScope', 'outputs', 'doneCriteria', 'checkCommand'],
      properties: { title: { type: 'string' }, agentCode: { type: 'string' }, instructions: { type: 'string' }, writeScope: { type: 'array', items: { type: 'string' } },
        outputs: { type: 'array', items: { type: 'object', required: ['path', 'format'], properties: { path: { type: 'string' }, format: { type: 'string', enum: ['markdown', 'json', 'html', 'text', 'code', 'image', 'any'] } } } },
        doneCriteria: { type: 'string' }, checkCommand: { type: 'array', items: { type: 'string' } } } } },
  },
};
const JUDGE_SCHEMA = {
  type: 'object', required: ['decision', 'summary', 'question', 'nextFocus'],
  properties: { decision: { type: 'string', enum: ['continue', 'ask_user', 'done'] }, summary: { type: 'string' }, question: { type: 'string' }, nextFocus: { type: 'string' } },
};
interface PlanTask { title: string; agentCode: string; instructions: string; writeScope: string[]; outputs: { path: string; format: GraphNode['outputs'][number]['format'] }[]; doneCriteria: string; checkCommand: string[] }
interface Plan { summary: string; question: string; gaps?: MissionGap[]; tasks: PlanTask[] }
interface Judge { decision: 'continue' | 'ask_user' | 'done'; summary: string; question: string; nextFocus: string }

type Row = Record<string, unknown>;

export interface MissionDeps {
  store: Store;
  engine: Engine;
  emit: (e: LiveEvent) => void;
  executor: () => { executor: 'claude' | 'mock'; cliPath: string | null };
  mockScript: string;
  maxCycles: () => number;
  gitCommits?: () => boolean;
  ensureAgents: (projectId: string) => Agent[];
  /** 프로젝트 완성 문서(근거 문서) — 오퍼레이터가 계획 전에 근거가 충분한지 판단한다 */
  projectDocs?: (projectId: string) => ProjectDoc[];
}

/** 오퍼레이터 호출이 사용 한도에 걸림 */
class OperatorLimit extends Error { constructor(public lim: LimitInfo) { super('오퍼레이터 호출이 사용 한도에 걸렸습니다.'); this.name = 'OperatorLimit'; } }

export class MissionRunner {
  private loops = new Set<string>();
  private procs = new Map<string, ProcessHandle>();
  private closed = false;
  private replan = new Set<string>(); // '지금 반영' 추가 지시를 받은 미션
  private wakeLimit = new Set<string>(); // 사용 한도 대기 중 '지금 다시 시도'

  constructor(private d: MissionDeps) {
    d.store.db.exec(`CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, project_id TEXT, data TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS mission_events (mission_id TEXT, seq INTEGER, data TEXT, PRIMARY KEY(mission_id, seq));
      CREATE TABLE IF NOT EXISTS mission_cycles (mission_id TEXT, cycle INTEGER, run_id TEXT, PRIMARY KEY(mission_id, cycle));
      CREATE TABLE IF NOT EXISTS mission_procs (mission_id TEXT PRIMARY KEY, pid INTEGER, proc_start TEXT, marker TEXT);
      CREATE TABLE IF NOT EXISTS mission_snapshots (mission_id TEXT, tag TEXT, name TEXT, sha TEXT, cycle INTEGER, created_at TEXT, PRIMARY KEY(mission_id, tag));
      CREATE TABLE IF NOT EXISTS mission_snapshot_repos (mission_id TEXT, tag TEXT, repo TEXT, sha TEXT, PRIMARY KEY(mission_id, tag, repo));`);
  }

  // ───── 저장 ─────
  get(id: string): Mission {
    const r = this.d.store.db.prepare('SELECT data FROM missions WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new Error('미션을 찾을 수 없습니다.');
    return JSON.parse(String(r.data)) as Mission;
  }
  list(projectId: string): Mission[] {
    return (this.d.store.db.prepare('SELECT data FROM missions WHERE project_id=? ORDER BY updated_at DESC').all(projectId) as Row[]).map((r) => redactDeep(JSON.parse(String(r.data)) as Mission));
  }
  private save(m: Mission): Mission {
    m.updatedAt = now();
    this.d.store.db.prepare('INSERT INTO missions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at').run(m.id, m.projectId, JSON.stringify(m), m.updatedAt);
    this.d.emit({ type: 'mission', mission: redactDeep(m) });
    return m;
  }
  private set(id: string, patch: Partial<Mission>): Mission { return this.save({ ...this.get(id), ...patch }); }
  private event(m: Mission, kind: MissionEvent['kind'], text: string, data: unknown = null): void {
    const r = this.d.store.db.prepare('SELECT COALESCE(MAX(seq),0) s FROM mission_events WHERE mission_id=?').get(m.id) as Row;
    const ev: MissionEvent = { missionId: m.id, seq: Number(r.s) + 1, at: now(), kind, cycle: m.cycle, text: redact(text), data: data === null ? '' : JSON.stringify(redactDeep(data), null, 2) };
    this.d.store.db.prepare('INSERT INTO mission_events VALUES(?,?,?)').run(m.id, ev.seq, JSON.stringify(ev));
    this.d.emit({ type: 'missionEvent', event: ev });
  }
  events(id: string): MissionEvent[] {
    return (this.d.store.db.prepare('SELECT data FROM mission_events WHERE mission_id=? ORDER BY seq').all(id) as Row[]).map((r) => JSON.parse(String(r.data)) as MissionEvent);
  }
  detail(id: string): MissionDetail {
    const mission = this.get(id);
    const cycles = (this.d.store.db.prepare('SELECT cycle, run_id FROM mission_cycles WHERE mission_id=? ORDER BY cycle').all(id) as Row[]).map((r) => {
      const run = this.d.store.getRun(String(r.run_id));
      return { cycle: Number(r.cycle), runId: run.id, status: run.status, graphVersion: run.graphVersion };
    });
    const runId = mission.currentRunId ?? cycles.at(-1)?.runId ?? null;
    let currentRun: RunDetail | null = null;
    if (runId) { try { currentRun = this.d.engine.detail(runId); } catch { currentRun = null; } }
    const events = this.events(id);
    return { mission: redactDeep(mission), events, cycles, currentRun, files: this.files(mission, cycles, events), working: this.working(mission.projectId) };
  }

  /** 프로젝트에서 지금 일하는 직원: 실행 중인 시도(작성·검토·Codex·검사)와 진행 중인 오퍼레이터 호출 */
  working(projectId: string): WorkingItem[] {
    const out: WorkingItem[] = [];
    const agents = new Map(this.d.store.listAgents(projectId).map((a) => [a.id, a]));
    const op = [...agents.values()].find((a) => a.code === '00');
    for (const m of this.list(projectId)) {
      if (!this.procs.has(m.id) || !['planning', 'evaluating'].includes(m.status)) continue;
      out.push({ agentId: op?.id ?? null, who: `${op ? `${op.code} ${op.name}` : '00 총괄'}(오퍼레이터)`, kind: 'operator', task: m.status === 'planning' ? `사이클 ${m.cycle} 계획` : `사이클 ${m.cycle} 판단`, runId: null, missionId: m.id, since: m.updatedAt });
    }
    for (const r of this.d.store.listRuns(projectId)) {
      if (!this.d.engine.isActive(r.id)) continue;
      let labels = new Map<string, string>();
      let graph: WorkGraph | null = null;
      try { graph = this.d.store.getGraphVersion(r.graphVersionId).graph; labels = new Map(graph.nodes.map((n) => [n.id, n.label])); } catch { /* 그대로 */ }
      const nodeOf = (id: string) => graph?.nodes.find((n) => n.id === id);
      // 검토·리뷰·검사 단계에서 앞쪽으로 거슬러 올라가 대상 작성 단계의 담당을 찾는다
      const authorOf = (id: string): string | null => {
        const seen = new Set<string>(); let cur = [id];
        while (cur.length && graph) {
          const next: string[] = [];
          for (const c of cur) for (const e of graph.edges.filter((x) => x.target === c && x.kind !== 'fail')) {
            if (seen.has(e.source)) continue; seen.add(e.source);
            const n = nodeOf(e.source);
            if (n?.kind === 'agent') return n.agentId;
            if (n && n.kind !== 'input') next.push(n.id);
          }
          cur = next;
        }
        return null;
      };
      const DOC = /\.(md|markdown|txt|html?|pdf|docx?|rtf|csv)$/i;
      const missionId = (this.d.store.db.prepare("SELECT value FROM run_meta WHERE run_id=? AND key='mission'").get(r.id) as Row | undefined)?.value;
      for (const a of this.d.store.runAttempts(r.id).filter((x) => x.status === 'running')) {
        const ag = a.agentId ? agents.get(a.agentId) : undefined;
        const kind = (a.role === 'author' || a.role === 'reviewer' || a.role === 'codex' || a.role === 'check') ? a.role : 'author';
        const who = kind === 'codex' ? 'Codex 리뷰' : kind === 'check' ? '자동 검사' : ag ? `${ag.code} ${ag.name}` : '(직원 정보 없음)';
        const node = nodeOf(a.nodeId);
        const outs = node?.outputs.map((o) => o.path) ?? [];
        const mode = kind === 'author' ? (outs.length && outs.every((p) => DOC.test(p)) ? 'doc' as const : 'code' as const) : undefined;
        const reviewOf = kind === 'author' ? null : authorOf(a.nodeId);
        out.push({ agentId: ag?.id ?? null, who, kind, task: labels.get(a.nodeId) ?? a.nodeId, runId: r.id, missionId: missionId ? String(missionId) : null, since: a.startedAt, reviewOf, ...(mode ? { mode } : {}) });
      }
    }
    return out;
  }

  /** 결과물 파일 목록: 사이클 실행의 등록 산출물 + 진행 기록 문장에 나온 프로젝트 안 실제 파일. 프로젝트 폴더 밖은 넣지 않는다. */
  private files(m: Mission, cycles: { cycle: number; runId: string }[], events: MissionEvent[]): MissionFile[] {
    let folder = '';
    try { folder = this.d.store.getProject(m.projectId).plan.folder; } catch { return []; }
    if (!folder || !existsSync(folder)) return [];
    let root = folder; try { root = realpathSync(folder); } catch { /* 그대로 */ }
    const inside = (abs: string) => { try { const r = relative(root, realpathSync(abs)); return !!r && !r.startsWith('..') && !isAbsolute(r); } catch { return false; } };
    const out = new Map<string, MissionFile>();
    for (const c of [...cycles].reverse()) {
      for (const a of this.d.store.artifacts(c.runId).reverse()) {
        if (out.has(a.relPath)) continue;
        const ok = existsSync(a.path);
        if (ok && !inside(a.path)) continue;
        out.set(a.relPath, { relPath: a.relPath, path: a.path, cycle: c.cycle, kind: a.kind, exists: ok, createdAt: a.createdAt });
      }
    }
    // 기록 문장 속 상대 경로(예: docs/mission/cycle-1.md) — 실제로 있는 파일만
    const re = /(?:^|[\s`'"(（「])((?:[\w가-힣.@-]+\/)*[\w가-힣@-][\w가-힣.@-]*\.[A-Za-z0-9]{1,8})(?=$|[\s`'"),.:;)）」])/g;
    for (const e of events) {
      for (const mm of e.text.matchAll(re)) {
        const rel = mm[1].replace(/^\.\//, '');
        if (out.has(rel) || rel.includes('..') || rel.length > 300) continue;
        const abs = join(folder, ...rel.split('/'));
        try { if (!statSync(abs).isFile() || !inside(abs)) continue; } catch { continue; }
        out.set(rel, { relPath: rel, path: abs, cycle: e.cycle, kind: null, exists: true, createdAt: null });
        if (out.size > 200) break;
      }
    }
    return [...out.values()];
  }

  // ───── 사용자 조작 ─────
  /** 미션은 한 번에 하나만: 앱 전체에서 작동 중인 미션, 또는 이 프로젝트에서 열려 있는(확인 대기·완료 보고) 미션 */
  blocking(projectId: string): Mission | null {
    const all = (this.d.store.db.prepare('SELECT data FROM missions').all() as Row[]).map((r) => JSON.parse(String(r.data)) as Mission);
    return all.find((m) => ['planning', 'running', 'evaluating'].includes(m.status))
      ?? all.find((m) => m.projectId === projectId && ['waiting_user', 'done'].includes(m.status)) ?? null;
  }

  start(projectId: string, prompt: string): Mission {
    if (!prompt.trim()) throw new Error('지시 내용을 입력하세요.');
    const b = this.blocking(projectId);
    if (b) throw new Error(b.projectId === projectId
      ? `이 프로젝트에 열려 있는 미션이 있습니다(${b.status === 'done' ? '완료 보고' : b.status === 'waiting_user' ? '확인 대기' : '작동 중'}). 그 미션에 추가 지시하거나 종료한 뒤 새로 지시하세요.`
      : '다른 프로젝트에서 미션이 작동 중입니다. 미션은 한 번에 하나만 작동합니다. 그 미션을 마치거나 중단한 뒤 지시하세요.');
    const t = now();
    const m = this.save({ id: uid(), projectId, prompt: prompt.trim(), status: 'planning', stage: 'instruction', cycle: 1, maxCycles: Math.max(1, this.d.maxCycles()), currentRunId: null, question: null, summary: '', createdAt: t, updatedAt: t });
    this.event(m, 'user', prompt.trim());
    void this.loop(m.id);
    return m;
  }

  answer(id: string, text: string, action: 'continue' | 'stop'): Mission {
    const m = this.get(id);
    // 중단한 미션도 '이어서 다시 시작'할 수 있다(같은 미션 기록·스냅샷을 이어받아 다음 사이클부터 다시 계획)
    if (!['waiting_user', 'done', 'failed', 'stopped'].includes(m.status)) throw new Error('지금은 답변을 기다리는 상태가 아닙니다.');
    if (m.status === 'stopped' && action === 'stop') return m;
    if (action === 'continue') {
      // 미션은 한 번에 하나만: 다른 미션이 작동 중이거나, 같은 프로젝트에 다른 열린 미션이 있으면 이어서 진행하지 않는다
      const all = (this.d.store.db.prepare('SELECT data FROM missions').all() as Row[]).map((r) => JSON.parse(String(r.data)) as Mission);
      if (all.find((x) => x.id !== id && ['planning', 'running', 'evaluating'].includes(x.status))) throw new Error('다른 미션이 작동 중입니다. 미션은 한 번에 하나만 작동합니다. 그 미션을 마치거나 중단한 뒤 계속하세요.');
      if (all.find((x) => x.id !== id && x.projectId === m.projectId && ['waiting_user', 'done'].includes(x.status))) throw new Error('이 프로젝트에 열려 있는 다른 미션이 있습니다. 그 미션을 종료한 뒤 다시 시작하세요.');
    }
    if (text.trim()) this.event(m, m.status === 'stopped' ? 'directive' : 'answer', text.trim());
    if (m.status === 'stopped') this.event(m, 'system', `중단했던 미션을 이어서 다시 시작합니다(이전 판단·답변·추가 지시와 스냅샷을 이어받음).`);
    if (action === 'stop') { this.event(m, 'system', '사용자가 미션을 종료했습니다.'); return this.set(id, { status: 'stopped', stage: 'stopped', question: null }); }
    // 이번 사이클에 실행이 있었으면 다음 사이클로, 계획 단계 질문이었으면 같은 사이클을 다시 계획한다. 상한은 사용자 승인만큼 늘린다.
    const ran = !!this.d.store.db.prepare('SELECT 1 FROM mission_cycles WHERE mission_id=? AND cycle=?').get(id, m.cycle);
    const cycle = ran ? m.cycle + 1 : m.cycle;
    const next = this.set(id, { status: 'planning', stage: 'plan', question: null, gaps: null, cycle, maxCycles: Math.max(m.maxCycles, cycle + this.d.maxCycles() - 1) });
    void this.loop(id);
    return next;
  }

  // ───── 스냅샷·되돌리기 ─────
  private hasSnapshot(id: string) { return !!this.d.store.db.prepare('SELECT 1 FROM mission_snapshots WHERE mission_id=?').get(id); }
  private async snapshot(m: Mission, folder: string, key: string, name: string) {
    if (!(this.d.gitCommits?.() ?? true) || this.closed) return;
    const tag = `crewgenai/m-${m.id.slice(0, 8)}/${key}`;
    const ws = await workspaceRepos(folder);
    if (this.closed) return;
    if (ws.mode === 'multi') {
      // 여러 저장소: 저장소마다 현재 커밋을 앱 기록에 남긴다(태그는 만들지 않음)
      const heads = await workspaceHeads(folder);
      if (this.closed) return;
      if (!heads.length) { this.event(m, 'system', '스냅샷을 남기지 못했습니다: 커밋이 있는 하위 저장소가 없습니다.'); return; }
      this.d.store.tx(() => {
        this.d.store.db.prepare('INSERT OR REPLACE INTO mission_snapshots VALUES(?,?,?,?,?,?)').run(m.id, tag, name, heads[0].sha, m.cycle, now());
        this.d.store.db.prepare('DELETE FROM mission_snapshot_repos WHERE mission_id=? AND tag=?').run(m.id, tag);
        for (const h of heads) this.d.store.db.prepare('INSERT INTO mission_snapshot_repos VALUES(?,?,?,?)').run(m.id, tag, h.repo, h.sha);
      });
      this.event(m, 'system', `스냅샷 저장: ${name} (하위 저장소 ${heads.length}개의 현재 커밋 기록)`);
      return;
    }
    const r = await tagSnapshot(folder, tag);
    if (this.closed) return;
    if (r.sha) {
      this.d.store.db.prepare('INSERT OR REPLACE INTO mission_snapshots VALUES(?,?,?,?,?,?)').run(m.id, tag, name, r.sha, m.cycle, now());
      this.event(m, 'system', `스냅샷 저장: ${name} (git 태그 ${tag}, ${r.sha.slice(0, 8)})`);
    } else this.event(m, 'system', `스냅샷을 남기지 못했습니다: ${r.error}`);
  }

  /** 스냅샷의 저장소별 기준점. 한 저장소 모드는 연결 폴더 하나. */
  private snapshotRepos(id: string, tag: string, folder: string, sha: string): { repo: string; abs: string; sha: string }[] {
    const rows = this.d.store.db.prepare('SELECT repo, sha FROM mission_snapshot_repos WHERE mission_id=? AND tag=? ORDER BY repo').all(id, tag) as Row[];
    if (!rows.length) return [{ repo: '', abs: folder, sha }];
    return rows.map((r) => ({ repo: String(r.repo), abs: join(folder, String(r.repo)), sha: String(r.sha) }));
  }

  private async commitsAfter(id: string, repos: { repo: string; abs: string; sha: string }[]) {
    const out: { sha: string; subject: string; author: string; repo?: string; abs: string }[] = [];
    for (const r of repos) if (existsSync(r.abs)) for (const c of await missionCommitsSince(r.abs, r.sha, id)) out.push({ ...c, ...(r.repo ? { repo: r.repo } : {}), abs: r.abs });
    return out;
  }

  async snapshots(id: string): Promise<MissionSnapshot[]> {
    const m = this.get(id);
    const folder = this.d.store.getProject(m.projectId).plan.folder;
    const rows = this.d.store.db.prepare('SELECT * FROM mission_snapshots WHERE mission_id=? ORDER BY created_at').all(id) as Row[];
    const out: MissionSnapshot[] = [];
    for (const r of rows) {
      const repos = this.snapshotRepos(id, String(r.tag), folder, String(r.sha));
      const after = await this.commitsAfter(id, repos);
      out.push({ name: String(r.name), tag: String(r.tag), sha: String(r.sha), cycle: Number(r.cycle), createdAt: String(r.created_at),
        repos: repos.some((x) => x.repo) ? repos.map((x) => x.repo) : undefined,
        commitsAfter: after.map(({ abs: _a, ...c }) => c) });
    }
    return out;
  }

  /** 스냅샷 시점으로 되돌리기: 그 이후 이 미션의 CREWGENAI 커밋만 최신부터 revert(기록 보존). 여러 저장소면 저장소마다 따로 한다. 작동 중에는 먼저 중단해야 한다. */
  async rollback(id: string, tag: string) {
    const m = this.get(id);
    if (['planning', 'running', 'evaluating'].includes(m.status)) throw new Error('미션이 작동 중입니다. 먼저 중단한 뒤 되돌리세요.');
    const row = this.d.store.db.prepare('SELECT * FROM mission_snapshots WHERE mission_id=? AND tag=?').get(id, tag) as Row | undefined;
    if (!row) throw new Error('스냅샷을 찾을 수 없습니다.');
    const folder = this.d.store.getProject(m.projectId).plan.folder;
    const repos = this.snapshotRepos(id, tag, folder, String(row.sha));
    const multi = repos.some((x) => x.repo);
    const plan: { repo: string; abs: string; shas: string[] }[] = [];
    const missing = repos.filter((r) => !existsSync(r.abs)).map((r) => r.repo);
    if (missing.length) throw new Error(`스냅샷에 기록된 저장소를 찾을 수 없어 되돌리지 않았습니다: ${missing.join(', ')}. 폴더 이름·위치를 원래대로 돌린 뒤 다시 시도하세요.`);
    for (const r of repos) { const cs = await missionCommitsSince(r.abs, r.sha, id); if (cs.length) plan.push({ repo: r.repo, abs: r.abs, shas: cs.map((c) => c.sha) }); }
    const total = plan.reduce((n, p) => n + p.shas.length, 0);
    this.event(m, 'system', `되돌리기 시작: '${row.name}' 이후 커밋 ${total}개${multi ? ` (저장소 ${plan.length}개: ${plan.map((p) => p.repo).join(', ')})` : ''}`);
    const reverted: string[] = []; const errors: string[] = []; const done: string[] = [];
    for (const p of plan) {
      const r = await revertCommits(p.abs, p.shas);
      reverted.push(...r.reverted.map((s) => (multi ? `${p.repo}@${s}` : s)));
      if (r.ok) done.push(p.repo); else errors.push(multi ? `${p.repo}: ${r.error}` : String(r.error));
    }
    const ok = errors.length === 0;
    const error = ok ? null : `${errors.join(' / ')}${multi && done.length ? ` (되돌리기를 마친 저장소: ${done.join(', ')})` : ''}`;
    this.event(m, 'system', ok ? `되돌리기 완료: '${row.name}' 시점으로 ${reverted.length}개 커밋을 revert했습니다(기록은 남아 있어 다시 되돌릴 수 있음).` : `되돌리기 실패: ${error}`, { tag, reverted });
    return { ok, reverted, error };
  }

  /** 작동 중인 미션에 추가 지시. now면 진행 중인 오퍼레이터 호출·실행을 실제로 멈추고 바로 다시 계획한다. */
  async addDirective(id: string, text: string, mode: 'next' | 'now'): Promise<Mission> {
    const m = this.get(id);
    if (!text.trim()) throw new Error('추가 지시 내용을 입력하세요.');
    if (!['planning', 'running', 'evaluating'].includes(m.status)) throw new Error('작동 중인 미션에만 추가 지시할 수 있습니다. 확인 대기·완료 상태에서는 답변 칸을 쓰세요.');
    this.event(m, 'directive', `${mode === 'now' ? '[지금 반영] ' : '[다음 사이클 반영] '}${text.trim()}`);
    if (mode === 'now') {
      this.replan.add(id);
      this.procs.get(id)?.cancel();
      if (m.currentRunId && (this.d.engine.isActive(m.currentRunId) || this.d.engine.limitOf(m.currentRunId))) await this.d.engine.cancel(m.currentRunId);
    }
    return this.get(id);
  }

  /** 오퍼레이터 호출이 사용 한도에 걸리면 해제 시각까지 기다렸다가 같은 호출을 다시 한다(중단·종료·'지금 반영'이면 멈춤). */
  private async patient<T>(id: string, call: () => Promise<T>): Promise<T> {
    for (;;) {
      this.guardLoop(id);
      try { return await call(); } catch (e) {
        if (!(e instanceof OperatorLimit)) throw e;
        const until = this.d.engine.limitWaitUntil(e.lim);
        const m = this.get(id);
        this.event(m, 'system', `오퍼레이터 호출이 사용 한도에 걸렸습니다 — ${new Date(until).toLocaleString('ko-KR')} 이후 자동으로 이어서 진행합니다. (${redact(e.lim.text).slice(0, 200)})`, { until });
        this.set(id, { limitUntil: new Date(until).toISOString() });
        this.wakeLimit.delete(id);
        while (Date.now() < until && !this.wakeLimit.has(id)) {
          if (this.closed) throw new Error('앱 종료');
          if (this.get(id).status === 'stopped') throw new Error('사용자가 중단했습니다.');
          if (this.replan.has(id)) { this.set(id, { limitUntil: null }); throw new Error('추가 지시 반영'); }
          await new Promise((res) => setTimeout(res, 300));
        }
        this.wakeLimit.delete(id);
        this.set(id, { limitUntil: null });
        this.guardLoop(id);
        this.event(this.get(id), 'system', '사용 한도 대기를 마치고 오퍼레이터 호출을 다시 합니다.');
      }
    }
  }

  /** 오퍼레이터 호출 직전 확인: 앱 종료·중단·'지금 반영'이면 호출하지 않는다. */
  private guardLoop(id: string) {
    if (this.closed) throw new Error('앱 종료');
    if (this.get(id).status === 'stopped') throw new Error('사용자가 중단했습니다.');
    if (this.replan.has(id)) throw new Error('추가 지시 반영');
  }

  /** 사용 한도 대기 중인 미션: 기다리지 않고 지금 다시 시도한다. */
  retryLimitNow(id: string): Mission {
    const m = this.get(id);
    if (!m.limitUntil) throw new Error('사용 한도를 기다리는 미션이 아닙니다.');
    this.event(m, 'system', '사용자가 사용 한도 대기를 건너뛰고 지금 다시 시도합니다.');
    if (m.currentRunId && this.d.engine.limitOf(m.currentRunId)) this.d.engine.resumeAfterLimit(m.currentRunId);
    else this.wakeLimit.add(id);
    return this.get(id);
  }

  async stop(id: string): Promise<Mission> {
    const m = this.get(id);
    this.procs.get(id)?.cancel();
    if (m.currentRunId && (this.d.engine.isActive(m.currentRunId) || this.d.engine.limitOf(m.currentRunId))) await this.d.engine.cancel(m.currentRunId);
    this.event(m, 'system', '사용자가 미션을 중단했습니다. 진행 중이던 작업을 취소했습니다.');
    return this.set(id, { status: 'stopped', stage: 'stopped', question: null, limitUntil: null });
  }

  /** 앱 종료: 오퍼레이터 호출을 취소하고 루프가 새 작업을 시작하지 않게 한다. */
  async shutdown(timeoutMs = 6000) {
    this.closed = true;
    const hs = [...this.procs.values()];
    for (const h of hs) h.cancel();
    await Promise.race([Promise.all(hs.map((h) => h.done)), new Promise((r) => setTimeout(r, timeoutMs))]);
    const t0 = Date.now();
    while (this.loops.size && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 50));
  }

  /** 앱 재시작: 앱이 시작한 오퍼레이터 고아 프로세스를 정리하고, 진행 중이던 미션은 사용자 확인 대기로 둔다(조용히 다시 돌지 않는다). */
  async recoverProcesses() {
    for (const r of this.d.store.db.prepare('SELECT * FROM mission_procs').all() as Row[]) {
      const pid = Number(r.pid);
      if (pid && r.proc_start && await isOurProcess(pid, String(r.marker), String(r.proc_start))) await killGroupAndWait(pid);
    }
    this.d.store.db.exec('DELETE FROM mission_procs');
  }
  recoverOnStartup() {
    for (const r of this.d.store.db.prepare('SELECT data FROM missions').all() as Row[]) {
      const m = JSON.parse(String(r.data)) as Mission;
      if (['planning', 'running', 'evaluating'].includes(m.status)) {
        this.save({ ...m, limitUntil: null, status: 'waiting_user', stage: 'ask_user', question: '앱이 다시 시작되어 미션이 멈췄습니다. 이어서 진행할까요? (진행 중이던 실행은 실행 화면에서 재개 방법을 고를 수 있습니다)' });
        this.event(m, 'question', '앱 재시작으로 멈춤 — 계속 여부 확인');
      }
    }
  }

  /** 실행 노드 상태 변화로 루프 다이어그램의 현재 단계를 갱신한다. */
  onLive(e: LiveEvent) {
    if (e.type !== 'node' || !['running', 'checking', 'rework'].includes(e.state.status)) return;
    const r = this.d.store.db.prepare("SELECT data FROM missions WHERE json_extract(data,'$.currentRunId')=?").get(e.state.runId) as Row | undefined;
    if (!r) return;
    const m = JSON.parse(String(r.data)) as Mission;
    const run = this.d.store.getRun(e.state.runId);
    const node = this.d.store.getGraphVersion(run.graphVersionId).graph.nodes.find((n) => n.id === e.state.nodeId);
    const stage: MissionStage | null = node?.kind === 'agent' ? 'execute' : node?.kind === 'codexReview' ? 'codex' : node?.kind === 'review' ? 'claude_review' : null;
    if (stage && stage !== m.stage) this.save({ ...m, stage });
  }

  // ───── 루프 ─────
  private async loop(id: string) {
    if (this.loops.has(id)) return;
    this.loops.add(id);
    let restart = false;
    try {
      for (;;) {
        let m = this.get(id);
        if (this.closed || !['planning', 'running', 'evaluating'].includes(m.status)) return;
        const project = this.d.store.getProject(m.projectId);
        const agents = this.d.ensureAgents(m.projectId).filter((a) => a.active);

        // 1) 오퍼레이터 계획
        m = this.set(id, { status: 'planning', stage: 'plan', currentRunId: null });
        const plan = await this.patient(id, () => this.callOperator<Plan>(this.get(id), project.plan, this.planPrompt(this.get(id), project.plan, agents), PLAN_SCHEMA));
        if (this.get(id).status === 'stopped') return;
        this.event(m, 'operator_plan', `사이클 ${m.cycle} 계획: ${plan.summary} (작업 ${plan.tasks.length}개)`, plan);
        const gaps = (Array.isArray(plan.gaps) ? plan.gaps : []).filter((g) => g && (String(g.issue ?? '').trim() || String(g.need ?? '').trim()))
          .slice(0, 12).map((g) => ({ doc: String(g.doc ?? '').slice(0, 200), issue: String(g.issue ?? '').slice(0, 600), need: String(g.need ?? '').slice(0, 600) }));
        if (gaps.length) {
          // 근거 문서가 빈약·애매: 채워야 할 부분을 알려 주고 멈춘다(문서를 보완한 뒤 이어서 진행)
          const q = `근거 문서를 보완해 주세요.${plan.question.trim() ? ` ${plan.question.trim()}` : ''}\n${gaps.map((g) => `- [${g.doc || '문서 미지정'}] ${g.issue}${g.need ? ` → 채울 내용: ${g.need}` : ''}`).join('\n')}`;
          this.event(m, 'question', q, { gaps });
          this.set(id, { status: 'waiting_user', stage: 'ask_user', question: q, gaps });
          return;
        }
        if (plan.question.trim() || plan.tasks.length === 0) {
          this.event(m, 'question', plan.question.trim() || '진행할 작업을 정하지 못했습니다. 추가 지시가 필요합니다.');
          this.set(id, { status: 'waiting_user', stage: 'ask_user', question: plan.question.trim() || '진행할 작업을 정하지 못했습니다. 무엇을 할지 알려 주세요.' });
          return;
        }

        // 2) 사이클 흐름 구성·실행
        const built = this.buildCycleGraph(m, project.plan, agents, plan);
        if ('error' in built) {
          this.event(m, 'question', `계획을 실행 가능한 흐름으로 만들지 못했습니다: ${built.error}`);
          this.set(id, { status: 'waiting_user', stage: 'ask_user', question: `오퍼레이터 계획에 문제가 있습니다(${built.error}). 지시를 보완해 주세요.` });
          return;
        }
        const saved = this.d.store.saveGraph(m.projectId, built.graph, `미션 ${m.id.slice(0, 8)} 사이클 ${m.cycle}`);
        if (!this.hasSnapshot(id)) await this.snapshot(m, project.plan.folder, 'start', '미션 시작 전');
        // 스냅샷을 기다리는 동안 중단·종료·'지금 반영' 추가 지시가 들어왔으면 이 계획으로 실행하지 않는다
        if (this.closed || this.get(id).status === 'stopped') return;
        if (this.replan.delete(id)) { this.event(m, 'system', '추가 지시가 들어와 이 계획으로 실행하지 않고 다시 계획합니다.'); this.set(id, { status: 'planning', stage: 'plan' }); continue; }
        const run = this.d.engine.startRun(m.projectId, saved.id, { missionId: id, cycle: m.cycle });
        this.d.store.db.prepare('INSERT OR REPLACE INTO mission_cycles VALUES(?,?,?)').run(id, m.cycle, run.id);
        m = this.set(id, { status: 'running', stage: 'execute', currentRunId: run.id });
        this.event(m, 'cycle_start', `사이클 ${m.cycle} 실행 시작(흐름 v${saved.version}, 작업 ${plan.tasks.length}개)`, { runId: run.id });
        const fin = await this.waitRun(run.id, id);
        if (this.closed || this.get(id).status === 'stopped') return;
        this.event(m, 'cycle_end', `사이클 ${m.cycle} 실행 종료: ${fin.status}${fin.reason ? ` — ${fin.reason}` : ''}`);
        await this.snapshot(m, project.plan.folder, `cycle-${m.cycle}`, `사이클 ${m.cycle} 종료(${fin.status})`);
        if (this.replan.has(id)) {
          // '지금 반영' 추가 지시: 이번 사이클 판단을 건너뛰고 지시를 반영해 다음 사이클을 바로 계획한다
          this.replan.delete(id);
          this.event(m, 'system', `추가 지시를 반영하려고 사이클 ${m.cycle} 작업을 멈췄습니다. 사이클 ${m.cycle + 1}을 다시 계획합니다.`);
          this.set(id, { cycle: m.cycle + 1, maxCycles: Math.max(m.maxCycles, m.cycle + 1), status: 'planning', stage: 'plan' });
          continue;
        }

        // 3) 오퍼레이터 판단
        m = this.set(id, { status: 'evaluating', stage: 'judge' });
        const judge = await this.patient(id, () => this.callOperator<Judge>(this.get(id), project.plan, this.judgePrompt(this.get(id), project.plan, run.id), JUDGE_SCHEMA));
        if (this.get(id).status === 'stopped') return;
        this.event(m, 'operator_judge', `판단: ${judge.decision === 'continue' ? '계속' : judge.decision === 'done' ? '완료' : '사용자 확인'} — ${judge.summary}`, judge);
        if (judge.decision === 'done') {
          this.set(id, { status: 'done', stage: 'done', summary: judge.summary, question: `완료 보고: ${judge.summary}` });
          this.event(m, 'question', '완료 보고 — 결과물을 검토하고 추가 지시하거나 종료하세요.');
          return;
        }
        if (judge.decision === 'ask_user') {
          this.set(id, { status: 'waiting_user', stage: 'ask_user', summary: judge.summary, question: judge.question || judge.summary });
          this.event(m, 'question', judge.question || judge.summary);
          return;
        }
        if (m.cycle >= m.maxCycles) {
          const q = `사이클 ${m.cycle}회를 진행했습니다(설정 상한). 오퍼레이터 판단: ${judge.summary}. 다음 초점: ${judge.nextFocus}. 계속 진행할까요?`;
          this.set(id, { status: 'waiting_user', stage: 'ask_user', summary: judge.summary, question: q });
          this.event(m, 'question', q, { cap: true });
          return;
        }
        this.set(id, { cycle: m.cycle + 1, summary: judge.summary, status: 'planning', stage: 'plan' });
      }
    } catch (e) {
      if (this.closed) return; // 앱 종료 중: 재시작 때 사용자 확인 대기로 복원된다
      if (this.replan.has(id) && this.get(id).status !== 'stopped') {
        // 오퍼레이터 계획·판단 중에 '지금 반영' 추가 지시가 들어와 호출을 멈춘 경우: 같은 사이클을 다시 계획한다
        this.replan.delete(id);
        this.event(this.get(id), 'system', '추가 지시를 반영하려고 진행 중이던 오퍼레이터 호출을 멈췄습니다. 다시 계획합니다.');
        this.set(id, { status: 'planning', stage: 'plan' });
        restart = true;
        return;
      }
      const m = this.get(id);
      if (m.status !== 'stopped') {
        this.event(m, 'system', `오류로 멈춤: ${redact((e as Error).message)}`);
        this.set(id, { status: 'waiting_user', stage: 'ask_user', question: `오류로 멈췄습니다: ${redact((e as Error).message).slice(0, 300)}. 원인을 해결한 뒤 계속하거나 종료하세요.` });
      }
    } finally { this.loops.delete(id); if (restart) void this.loop(id); }
  }

  private async waitRun(runId: string, missionId: string) {
    let noted = 0;
    for (;;) {
      const r = this.d.store.getRun(runId);
      if (this.closed || this.get(missionId).status === 'stopped') return r;
      const active = this.d.engine.isActive(runId);
      const lim = !active && r.status === 'needs_resume' ? this.d.engine.limitOf(runId) : null;
      if (lim && this.replan.has(missionId)) { await this.d.engine.cancel(runId); this.set(missionId, { limitUntil: null }); return this.d.store.getRun(runId); }
      if (lim) {
        // 사용 한도: 실행은 해제 시각에 엔진이 스스로 이어서 진행한다. 미션은 실패로 판단하지 않고 기다린다.
        if (noted !== lim.until) {
          noted = lim.until;
          const m = this.get(missionId);
          this.event(m, 'system', `사용 한도 도달 — ${new Date(lim.until).toLocaleString('ko-KR')} 이후 자동으로 이어서 진행합니다. 기다리지 않으려면 '지금 다시 시도'를 누르세요.`, { runId, until: lim.until });
          this.set(missionId, { limitUntil: new Date(lim.until).toISOString() });
        }
        await new Promise((res) => setTimeout(res, 300));
        continue;
      }
      if (noted && this.get(missionId).limitUntil) { noted = 0; this.set(missionId, { limitUntil: null }); }
      if (!active && ['succeeded', 'failed', 'cancelled', 'needs_resume', 'review_wait', 'on_hold'].includes(r.status)) return r;
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  // ───── 흐름 구성 ─────
  private buildCycleGraph(m: Mission, plan: PlanFields, agents: Agent[], p: Plan): { graph: WorkGraph } | { error: string } {
    const by = (code: string) => agents.find((a) => a.code === code);
    const reviewerFor = (author: Agent) => {
      const readOnly = agents.filter((a) => !a.tools.includes('Edit') && !a.tools.includes('Write'));
      // 지정된 검토 담당 → 읽기 전용 검토자 → 총괄 → 다른 직원
      const pref = [author.reviewerAgentId ? agents.find((a) => a.id === author.reviewerAgentId) : undefined, ...readOnly, by('00'), ...agents];
      return pref.find((a) => a && a.id !== author.id) ?? null;
    };
    const mk = (kind: GraphNode['kind'], label: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode => ({
      id: randomUUID(), kind, label, position: { x, y }, agentId: null, reviewerAgentId: null, instructions: '', inputs: [], useUpstreamOutputs: true, outputs: [], doneCriteria: '',
      command: [], writeScope: [], maxRetries: 0, maxVisits: 3, timeoutSec: 1800, condition: null, entryCondition: 'all', ...extra });
    const nodes: GraphNode[] = []; const edges: GraphEdge[] = [];
    const e = (s: GraphNode, t: GraphNode, kind: GraphEdge['kind'] = 'next') => edges.push({ id: randomUUID(), source: s.id, target: t.id, kind });
    const inp = mk('input', `사이클 ${m.cycle} 지시`, 300, 0, { instructions: m.prompt, timeoutSec: 60 });
    nodes.push(inp);
    const merge = mk('merge', `사이클 ${m.cycle} 결과물 취합`, 300, 700, { timeoutSec: 120 });
    const roots = allowedRoots(plan);
    const chains: { first: GraphNode; last: GraphNode }[] = [];
    const refused: string[] = [];
    p.tasks.forEach((t, i) => {
      const author = by(t.agentCode) ?? by('00');
      if (!author) throw new Error(`담당 직원 ${t.agentCode}를 찾을 수 없습니다.`);
      const reviewer = reviewerFor(author);
      if (!reviewer) throw new Error('독립 재검토를 맡을 다른 직원이 없습니다.');
      const scope = (t.writeScope.length ? t.writeScope : [`${plan.outputDir}/mission`]).map(normRel).filter((x) => x && !escapes(x));
      const outs = t.outputs.map((o) => ({ path: normRel(o.path), format: o.format, required: true })).filter((o) => o.path && !escapes(o.path));
      const x = 120 + i * 360;
      const a = mk('agent', `${t.title} (${author.code} ${author.name})`, x, 130, { agentId: author.id, instructions: t.instructions, writeScope: scope, outputs: outs, doneCriteria: t.doneCriteria, skipInlineReview: true });
      const cx = mk('codexReview', `Codex 리뷰: ${t.title}`, x, 260, { inputs: outs.map((o) => o.path), doneCriteria: t.doneCriteria, timeoutSec: 1800 });
      const rv = mk('review', `Claude 재검토: ${t.title} (${reviewer.code} ${reviewer.name})`, x, 390, { agentId: reviewer.id, doneCriteria: t.doneCriteria,
        instructions: 'Codex 리뷰 보고서의 지적을 원문 산출물과 직접 대조한다. 타당한 지적이 남아 있으면 changes_requested로 재작업을 요청하고, 근거 없는 지적은 이유를 들어 기각한다. 완료 조건 충족 여부를 최종 판단한다.' });
      nodes.push(a, cx, rv);
      e(a, cx); e(cx, rv); e(rv, a, 'fail');
      let last = rv;
      const ck0 = this.safeCheck(t.checkCommand, author);
      if (t.checkCommand.length && !ck0) refused.push(`${t.title}: ${t.checkCommand.join(' ')}`);
      if (ck0) {
        const ck = mk('check', `검사: ${t.title}`, x, 520, { command: ck0, timeoutSec: 600 });
        nodes.push(ck); e(rv, ck); e(ck, a, 'fail'); last = ck;
      }
      chains.push({ first: a, last });
    });
    nodes.push(merge);
    const wire = (sequential: boolean) => {
      const es = [...edges]; // 작업 내부 연결(작성 → Codex → Claude 재검토 → 검사, 실패 시 작성으로)
      chains.forEach((c, i) => {
        if (sequential && i > 0) es.push({ id: randomUUID(), source: chains[i - 1].last.id, target: c.first.id, kind: 'next' });
        else es.push({ id: randomUUID(), source: inp.id, target: c.first.id, kind: 'next' });
        if (!sequential || i === chains.length - 1) es.push({ id: randomUUID(), source: c.last.id, target: merge.id, kind: 'next' });
      });
      return autoLayout({ nodes, edges: es });
    };
    for (const sequential of [false, true]) {
      const g = wire(sequential);
      const issues = validateGraph(g, agents, plan).filter((i) => i.level === 'error');
      if (!issues.length) { if (refused.length) this.event(m, 'system', `허용되지 않은 검사 명령을 제외했습니다(셸·인터프리터 실행 금지, 담당 허용 명령만): ${refused.join(' / ')}`); return { graph: g }; }
      if (sequential || !issues.some((i) => i.code === 'write_conflict')) return { error: issues.slice(0, 3).map((i) => i.message).join(' / ') + ` (수정 허용: ${roots.join(', ') || '없음'})` };
    }
    return { error: '흐름 구성 실패' };
  }

  /**
   * 오퍼레이터가 계획한 검사 명령은 실행 전에 제한한다: 셸·인터프리터 코드 실행(sh/bash/zsh -c, node/python -e/-c)은 금지,
   * 담당 직원의 Bash 허용 명령 접두어 또는 grep/test만 허용한다. 허용되지 않으면 null.
   */
  private safeCheck(argv: string[], author: Agent): string[] | null {
    const a = argv.map((x) => x.trim()).filter(Boolean);
    if (!a.length) return null;
    const bin = (a[0].split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase(); // Windows: 경로 구분자 \\, 확장자 .exe/.cmd
    if (['sh', 'bash', 'zsh', 'fish', 'env', 'osascript', 'eval', 'xargs', 'sudo', 'cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'start'].includes(bin)) return null;
    if (/^(node|python\d*|ruby|perl|php|deno|bun)$/.test(bin) && a.some((x) => ['-e', '-c', '--eval', '-p', '--print'].includes(x))) return null;
    if (BUILTIN_CHECK.has(a[0])) return a; // 내장 검사는 정확한 이름만(test.cmd·grep.bat 같은 프로젝트 파일은 해당하지 않음)
    const line = a.join(' ');
    return author.allowedCommands.some((c) => c.trim() && (line === c.trim() || line.startsWith(`${c.trim()} `))) ? a : null;
  }

  // ───── 오퍼레이터 프롬프트 ─────
  private history(m: Mission): string {
    return this.events(m.id).filter((e) => ['operator_judge', 'answer', 'question', 'directive'].includes(e.kind)).slice(-16)
      .map((e) => `- [사이클 ${e.cycle}] ${e.kind === 'answer' ? '사용자 답변' : e.kind === 'directive' ? '사용자 추가 지시(최우선 반영)' : e.kind === 'question' ? '질문' : '판단'}: ${e.text}`).join('\n') || '- (없음)';
  }

  private planPrompt(m: Mission, plan: PlanFields, agents: Agent[]): string {
    return [
      '# 오퍼레이터 계획', '',
      '당신은 CREWGENAI 개발팀의 00 총괄 오퍼레이터다. 사용자 지시를 이번 사이클의 작업으로 나누고, 기능에 맞는 담당 직원을 배정한다. 파일은 수정하지 않는다(읽기만).', '',
      '## 사용자 지시', m.prompt, '',
      `## 사이클: ${m.cycle} / 상한 ${m.maxCycles}`, '',
      '## 프로젝트', `- 이름: ${plan.name}`, `- 목표: ${plan.goal}`, `- 원하는 결과물: ${plan.deliverable}`, `- 완료 조건: ${plan.doneCriteria}`, `- 작업 범위: ${plan.scope}`,
      `- 자동 수정 허용 경로: ${allowedRoots(plan).join(', ') || '(없음)'}`, '',
      '## 사용 가능한 직원', ...agents.map((a) => `- ${a.code} ${a.name}: ${a.role} · 도구 ${a.tools.join(',')}${a.tools.includes('Edit') || a.tools.includes('Write') ? ' · 쓰기 가능' : ' · 읽기 전용'}`), '',
      ...this.docsSection(plan, m.projectId),
      '## 지금까지의 판단·질문·사용자 답변', this.history(m), '',
      '## 규칙',
      '- 작업마다 writeScope(수정 경로)는 자동 수정 허용 경로 안이어야 하고, 작업끼리 겹치지 않게 나눈다. outputs는 writeScope 안에 둔다.',
      '- agentCode는 위 목록의 쓰기 가능한 직원 코드만 쓴다. 각 작업 결과는 Codex 리뷰와 다른 직원의 Claude 재검토를 거친다.',
      '- checkCommand는 셸 없이 실행할 argv 배열이다(필요 없으면 빈 배열). 셸·인터프리터 코드 실행은 거부되며, 담당의 허용 명령이나 grep/test만 쓸 수 있다.',
      '- 먼저 근거 문서를 읽고, 이번 지시를 수행하기에 근거가 빈약하거나 애매한 부분(내용 없음·서로 모순·결정 안 됨·범위 불명확)이 있으면 tasks를 비우고 gaps에 문서별로 issue(무엇이 부족한지, 문서의 어느 부분인지)와 need(사용자가 채워야 할 내용)를 구체적으로 쓴다. 모든 문서가 다 있어야 하는 것은 아니다. 이번 지시에 필요한 근거만 판단하고, 추측으로 빈 곳을 메우지 않는다. 근거가 충분하면 gaps는 빈 배열.',
      '- 진행에 꼭 필요한 정보가 없거나 사용자 결정이 필요하면 tasks를 비우고 question에 한 가지 질문만 쓴다. 그렇지 않으면 question은 빈 문자열.',
      '- 이전 사이클의 결과·판단을 이어받아 남은 일만 계획한다. 작업은 1~4개로 작게 나눈다.',
    ].join('\n');
  }

  /** 계획 프롬프트의 '근거 문서' 절: 등록된 프로젝트 완성 문서와 상태(파일 경로는 프로젝트 폴더 기준) */
  private docsSection(plan: PlanFields, projectId: string): string[] {
    let docs: ProjectDoc[] = [];
    try { docs = this.d.projectDocs?.(projectId) ?? []; } catch { docs = []; }
    const used = docs.filter((d) => d.status !== 'excluded');
    if (!used.length) return ['## 근거 문서', '- (등록된 프로젝트 완성 문서 없음 — 기획의 목표·완료 조건과 참고 문서만 근거로 쓴다)', ''];
    const label: Record<ProjectDoc['status'], string> = { missing: '없음', draft: '있음·사용자 검토 전', changed: '있음·검토 후 바뀜', reviewed: '있음·사용자 검토 완료', excluded: '제외' };
    return ['## 근거 문서(프로젝트 완성 문서, 프로젝트 폴더 기준 경로 — Read로 읽을 수 있음)', ...used.map((d) => `- ${d.order}. ${d.title}: ${d.path} (${label[d.status]})`),
      ...(plan.referenceDocs.length ? ['- 참고 문서(읽기 전용):', ...plan.referenceDocs.map((r) => `  - ${r}`)] : []), ''];
  }

  private judgePrompt(m: Mission, plan: PlanFields, runId: string): string {
    const d = this.d.engine.detail(runId);
    const md = d.deliverable?.markdown ?? '(결과물 없음)';
    const failed = d.nodes.filter((n) => n.status === 'failed').map((n) => `${d.graph.nodes.find((g) => g.id === n.nodeId)?.label}: ${n.failureReason}`);
    const reviews = d.reviews.map((r) => `- ${r.kind === 'codex' ? 'Codex' : r.kind === 'agent' ? 'Claude 재검토' : '사용자'}: ${r.verdict} — ${r.comments.slice(0, 300).replace(/\n/g, ' ')}`);
    return [
      '# 오퍼레이터 판단', '',
      '당신은 00 총괄 오퍼레이터다. 이번 사이클 결과를 사용자 지시와 산출물 기준으로 판단한다. 파일은 수정하지 않는다.', '',
      '## 사용자 지시', m.prompt, '', `## 사이클: ${m.cycle} / 상한 ${m.maxCycles}`, '',
      '## 프로젝트 완료 조건', plan.doneCriteria || '(미입력)', '',
      `## 실행 결과: ${d.run.status}${d.run.reason ? ` — ${d.run.reason}` : ''}`, ...(failed.length ? ['### 실패 단계', ...failed.map((f) => `- ${f}`)] : []), '',
      '## 리뷰 기록', ...(reviews.length ? reviews : ['- (없음)']), '',
      '## 지금까지의 판단·사용자 답변', this.history(m), '',
      '## 이번 사이클 결과물(요약 보고서)', md.slice(0, 15000), '',
      '## 판단 규칙',
      '- done: 사용자 지시와 완료 조건을 산출물로 충족했을 때만. 실행이 실패했거나 검증이 없으면 done이 아니다.',
      '- ask_user: 사용자 결정·검토가 꼭 필요하거나, 같은 실패가 반복되거나, 추가 정보가 없으면 진행할 수 없을 때. question에 한 가지 질문을 쓴다.',
      '- continue: 남은 일이 분명하고 사용자 확인 없이 진행할 수 있을 때. nextFocus에 다음 사이클의 초점을 쓴다.',
      '- 측정하지 않은 성과나 실행하지 않은 검사를 근거로 쓰지 않는다.',
    ].join('\n');
  }

  /** 오퍼레이터 호출: Claude CLI(읽기 전용 도구, 구조화 출력). 모의 실행이면 모의 CLI를 쓴다. */
  private async callOperator<T>(m: Mission, plan: PlanFields, prompt: string, schema: object): Promise<T> {
    const ex = this.d.executor();
    const op = this.d.store.listAgents(m.projectId).find((a) => a.code === '00');
    const args = buildClaudeArgs({
      prompt, appendSystemPrompt: `당신은 CREWGENAI 개발팀의 00 총괄 오퍼레이터다. ${op?.instructions ?? ''}`.slice(0, 4000), cwd: plan.folder,
      tools: ['Read', 'Grep', 'Glob'], editScopes: [], allowedCommands: [], readDirs: [], sessionId: randomUUID(), resumeSessionId: null,
      jsonSchema: schema, model: op?.model ?? '', maxBudgetUsd: op?.maxBudgetUsd ?? null,
    });
    const file = ex.executor === 'mock' ? process.execPath : ex.cliPath;
    if (!file) throw new Error('Claude CLI가 준비되지 않았습니다.');
    const argv = ex.executor === 'mock' ? [this.d.mockScript, ...args] : args;
    const sink: StreamSink = { sessionId: null, result: null, limit: null };
    const h = startProcess(file, argv, { cwd: plan.folder, env: cleanEnv(ex.executor === 'mock' ? { ELECTRON_RUN_AS_NODE: '1' } : {}), stdin: prompt, timeoutSec: 900,
      onStdoutLine: (l) => { interpretLine(l, sink); }, onStderrLine: () => {} });
    this.procs.set(m.id, h);
    const sid = args[args.indexOf('--session-id') + 1] ?? '';
    const ps = await processStart(h.pid);
    if (!this.closed) this.d.store.db.prepare('INSERT OR REPLACE INTO mission_procs VALUES(?,?,?,?)').run(m.id, h.pid, ps, sid);
    const done = await h.done;
    this.procs.delete(m.id);
    if (!this.closed) this.d.store.db.prepare('DELETE FROM mission_procs WHERE mission_id=?').run(m.id);
    if (this.closed) throw new Error('앱 종료');
    const r = sink.result;
    if (done.cancelled) throw new Error('오퍼레이터 호출이 취소됐습니다.');
    const lim = claudeLimit(sink, done.code);
    if (lim) throw new OperatorLimit(lim);
    if (done.code !== 0 || !r || r.isError) throw new Error(`오퍼레이터 호출 실패(종료 코드 ${done.code ?? '없음'}${r?.subtype ? `, ${r.subtype}` : ''})`);
    let v = r.structured as T | null;
    if (!v) { const mm = r.text.match(/\{[\s\S]*\}/); try { v = mm ? JSON.parse(mm[0]) as T : null; } catch { v = null; } }
    if (!v) throw new Error('오퍼레이터가 구조화된 결과를 돌려주지 않았습니다.');
    return v;
  }
}
