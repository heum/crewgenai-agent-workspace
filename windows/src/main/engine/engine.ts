// 실행 엔진 — 저장된 흐름 버전을 LangGraph StateGraph로 컴파일해 실행한다.
// LangGraph: 순서·분기·병렬 합류·재작업 반복·체크포인트·사용자 검토 대기(interrupt)
// SQLite(Store): 실행·시도·이벤트·산출물·검사·검토 기록, 방문 결과(재개 시 중복 실행 방지)
import { Annotation, Command, END, START, StateGraph, interrupt, isGraphInterrupt } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type {
  AcceptanceResult, Agent, Attempt, AttemptEvent, Billing, GraphNode, LiveEvent, NodeStatus, PlanFields, ReviewRecord, Run, RunDetail, RunNodeState, ToolName, WorkGraph,
} from '../../shared/types';
import {
  buildClaudeArgs, claudeLimit, cleanEnv, codexLimit, interpretLine, type LimitInfo, type StreamSink, isOurProcess, killGroupAndWait, processStart, redact, redactArgs, redactDeep, startProcess, type ProcessHandle, type ResultInfo,
} from '../cli/claudeCli';
import { now, sha256, uid, type Store } from '../db';
import type { NodeSqliteSaver } from './checkpointer';
import { CODEX_REVIEW_SCHEMA, codexArgs, codexEnv } from '../cli/codexCli';
import { BUILTIN_CHECK, checkEnvFilter } from '../checks';
import { agentIdentity, commitWorkspace, ignoredPaths, workspaceDirtyPaths, workspaceRepos } from '../git';
import { commandNote, levelNote, materializeLink, referencedRepos, repoDirs, repoTestCommands, scrubSecretEnv, workBranchName, type CommandLevel } from '../autopilot';
import { applyIsolated, checkOutput, classify, cleanupIsolated, diffSnapshots, fileSha, isAppTempPath, isolatedDir, prepareIsolated, snapshot, SNAPSHOT_LIMIT, snapshotTruncated, type IsoState } from './fsutil';
import { copyFileSync as _copy } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildReport } from './report';
import { docsOnly, effectiveScope, entryNodes, forwardAdj, normRel, reach, within } from './validate';
import { laneBlocks } from './lanes';
import { prepareSkillBundle, unpinSkillBundle } from '../skills';

export interface Tracer {
  runStarted(run: Run, meta: Record<string, unknown>): void;
  attemptFinished(run: Run, a: Attempt, nodeLabel: string): void;
  runEnded(run: Run): void;
}

export interface EngineOptions {
  store: Store;
  checkpointer: NodeSqliteSaver;
  emit: (e: LiveEvent) => void;
  executor: () => { executor: 'claude' | 'mock'; cliPath: string | null; authMethod?: string | null };
  mockScript: string;
  mockCodexScript?: string;
  codex?: () => { path: string | null; model: string; effort: string };
  maxConcurrent: () => number;
  gitCommits?: () => boolean;
  tracer?: Tracer;
  /** 사용 한도 해제 시각에 더하는 여유(기본 60초) */
  limitGraceMs?: number;
  /** 해제 시각을 알 수 없을 때 다시 시도하기까지 기다리는 시간(기본 30분) */
  limitFallbackMs?: number;
  /** 사용자에 대해 배운 것(직원 지시에 붙인다) */
  learningsFor?: (projectId: string) => string;
  /** 'Skill' 도구를 켠 직원이 쓸 스킬 폴더(설정)와 사본을 둘 이 사용자 전용 폴더 */
  skills?: (projectFolder: string) => { dirs: string[]; cacheDir: string };
  /** 앱이 저장한 참고 사이트 스냅샷 폴더: 단계 입력에 이 안의 경로가 있으면 직원에게 읽기 전용으로 연다 */
  referenceRoot?: string;
  /** 자동 처리(사람 손 줄이기): 쓰기 직원 스킬 기본 사용, 저장소 시험 명령 자동 허용, 보호 브랜치 대신 작업 브랜치에 커밋 */
  autoAssist?: () => boolean;
  /** 시험 명령에 로컬 소켓 허용(설정, 기본 끔): 켜면 격리 실행에서도 이 PC의 로컬 서비스에 접속할 수 있다 */
  testLocalSockets?: () => boolean;
  /** 명령 허용 범위(설정, 기본 중간) */
  commandLevel?: () => CommandLevel;
}

/** 실행 메타에 남기는 사용 한도 대기 정보 */
export interface RunLimit { until: number; text: string; nodeId: string; at: string; known?: boolean }
const fmtTime = (ms: number) => new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type RecStatus = 'ok' | 'fail' | 'true' | 'false' | 'stale' | 'waiting';
interface Rec { status: RecStatus; outputs: string[]; summary: string; at: string }
const merge = <T>(a: Record<string, T>, b: Record<string, T>) => ({ ...a, ...b });

const RunState = Annotation.Root({
  records: Annotation<Record<string, Rec>>({ reducer: merge, default: () => ({}) }),
  visits: Annotation<Record<string, number>>({ reducer: merge, default: () => ({}) }),
  route: Annotation<Record<string, string[]>>({ reducer: merge, default: () => ({}) }),
  feedback: Annotation<Record<string, string>>({ reducer: merge, default: () => ({}) }),
  terminal: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
});
type S = typeof RunState.State;
type Update = Partial<S>;

class NeedsResume extends Error { constructor(msg: string) { super(msg); this.name = 'NeedsResume'; } }
class LimitHit extends Error { constructor(msg: string) { super(msg); this.name = 'LimitHit'; } }
class Cancelled extends Error { constructor() { super('취소됨'); this.name = 'Cancelled'; } }

interface Active { abort: AbortController; paused: boolean; procs: Map<string, ProcessHandle>; folder: string; inflight: number; userCancelled?: boolean }
interface Held { runId: string; nodeId: string; scopes: string[] } // scopes: 실제 절대 경로(프로젝트 간에도 비교)

const CODE_EXT = /\.(c?js|mjs|ts|cts|mts|py|sh|bash|zsh|rb|pl|php)$/i;
/** 검사 코드 판정: 스크립트 확장자이거나 실행 권한이 있는 일반 파일 */
function isCheckCode(p: string): boolean {
  try { const st = statSync(p); return st.isFile() && (CODE_EXT.test(p) || (st.mode & 0o111) !== 0); } catch { return false; }
}
function realFolder(folder: string): string { try { return realpathSync(folder); } catch { return resolve(folder); } }
function absScope(folder: string, rel: string): string {
  const n = normRel(rel);
  if (!n) return realFolder(folder);
  const p = join(realFolder(folder), n);
  // 아직 없는 경로는 존재하는 가장 가까운 상위 경로의 실제 경로(심볼릭 링크 해석)에 나머지를 붙인다
  let head = p; const tail: string[] = [];
  for (;;) { try { return join(realpathSync(head), ...tail.reverse()); } catch { const parent = dirname(head); if (parent === head) return p; tail.push(head.slice(parent.length + 1)); head = parent; } }
}
function absOverlap(a: string, b: string): boolean { return a === b || a.startsWith(b + sep) || b.startsWith(a + sep); } // Windows: 경로 구분자는 \\

/** 필수 산출물: 막힌 부분이 있어도 만들고, 기존 산출물로 채우고, 사용자 판단은 결정 필요로 넘긴다(산출물 없음으로 끝내지 않음) */
const MISSING_OUTPUT_RULE = [
  '- 일부 단계(명령 실행·도구 사용)가 막혀도 필수 산출물 파일은 반드시 만든다. "만들지 못했다"로 끝내지 않는다.',
  '- 직접 하지 못한 부분은 이전 사이클 결과물·관련 문서·코드 등 기존 산출물을 대조해 채울 수 있는 만큼 채우고, 각 내용의 근거(파일 경로)를 적는다.',
  '- 끝내 채우지 못한 칸은 "미실행(이유)" 또는 "확인 필요(이유)"로 표시한다. 실행하지 않은 시험을 통과로 쓰지 않는다.',
  '- 사용자가 정해야 하는 것만 마지막 응답에 "결정 필요: ..."로 쓴다. 사용자에게 명령 실행·결과 붙여넣기 같은 수작업을 요청하지 않는다.',
].join('\n');

/** 독립 검토의 재작업 기준: 막는 결함만 재작업, 경미한 지적은 후속으로 */
const REVIEW_BAR = [
  '- changes_requested는 막는 결함이 있을 때만 낸다: 정확성 오류, 보안 문제, 요구·완료 조건 위반, 시험 실패, 필수 산출물 누락. Codex 리뷰의 P0·P1 등급이 여기에 해당한다.',
  '- 기록 정리·표현·줄 번호·작은 불일치·추가로 있으면 좋은 검증(Codex P2·P3 등급)은 재작업 사유가 아니다. 승인하고 followUps에 적는다(다음 작업 목록으로 넘어간다).',
  '- issues에는 막는 결함만 쓴다.',
].join('\n');

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['approve', 'changes_requested'] }, summary: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } }, followUps: { type: 'array', items: { type: 'string' } } },
  required: ['verdict', 'summary', 'issues'],
};

export class Engine {
  private active = new Map<string, Active>();
  private running = 0;
  private held: Held[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;
  /** 최근에 끝난 쓰기 작업의 범위·종료 시각 — 실행 구간이 겹친 다른 작업의 변경을 범위 밖으로 오인하지 않기 위함 */
  private recentWriters: { runId: string; nodeId: string; scopes: string[]; endedAt: number }[] = []; // 종료 처리 후에는 DB에 쓰지 않는다
  /** 사용 한도 해제 후 자동 재개 타이머(실행별) */
  private limitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private o: EngineOptions) {
    o.store.db.exec(`CREATE TABLE IF NOT EXISTS visit_outcomes (run_id TEXT, node_id TEXT, visit INTEGER, update_json TEXT, created_at TEXT, PRIMARY KEY(run_id,node_id,visit));
      CREATE TABLE IF NOT EXISTS run_meta (run_id TEXT, key TEXT, value TEXT, PRIMARY KEY(run_id,key));`);
  }

  // ───────── 사용 한도 ─────────
  /** 한도 정보로 자동 재개 시각을 정한다(해제 시각 + 여유, 시각을 모르면 기본 대기). 미션 오퍼레이터 호출도 같은 기준을 쓴다. */
  limitWaitUntil(lim: LimitInfo): number {
    // 해제 시각을 알려 주면 그 시각, 모르면 1시간 뒤 한 번 다시 확인한다(무조건 5시간처럼 가정하지 않음)
    const base = lim.resetsAt && lim.resetsAt > 0 ? lim.resetsAt : Date.now() + (this.o.limitFallbackMs ?? 60 * 60_000);
    return Math.max(Date.now(), base) + (this.o.limitGraceMs ?? 60_000);
  }

  /** 이 실행이 사용 한도 해제를 기다리는 중이면 그 정보 */
  limitOf(runId: string): RunLimit | null {
    const v = this.meta(runId, 'limit');
    if (!v) return null;
    try { return JSON.parse(v) as RunLimit; } catch { return null; }
  }

  /** 작업이 사용 한도에 걸렸을 때: 재시도하지 않고 실행을 한도 대기로 돌린다(drive가 needs_resume으로 정리). */
  private hitLimit(runId: string, node: GraphNode, lim: LimitInfo): never {
    const prev = this.limitOf(runId);
    const until = Math.max(this.limitWaitUntil(lim), prev?.until ?? 0);
    this.setMeta(runId, 'limit', JSON.stringify({ until, text: redact(lim.text).slice(0, 300), nodeId: node.id, at: now(), known: !!(lim.resetsAt && lim.resetsAt > 0) } satisfies RunLimit));
    this.setNode(runId, node.id, { status: 'needs_resume', failureReason: `사용 한도 도달 — ${fmtTime(until)} 이후 자동으로 이어서 진행`, nextAction: '사용 한도 해제를 기다립니다' });
    throw new LimitHit(`"${node.label}" 사용 한도 도달`);
  }

  private scheduleLimitResume(runId: string, until: number) {
    const t0 = this.limitTimers.get(runId); if (t0) clearTimeout(t0);
    const wait = Math.min(Math.max(0, until - Date.now()), 2 ** 31 - 1);
    const t = setTimeout(() => {
      this.limitTimers.delete(runId);
      if (Date.now() + 500 < until) { this.scheduleLimitResume(runId, until); return; } // 아주 긴 대기는 나눠서 기다린다
      this.resumeAfterLimit(runId);
    }, wait);
    this.limitTimers.set(runId, t);
  }

  /**
   * 앱 재시작 등으로 끊긴 미션 실행을 자동으로 이어서 진행한다: 끊긴 작성 작업은 같은 Claude 세션을 이어 쓰고(없으면 새 시도),
   * 완료된 단계는 다시 실행하지 않는다. 사용자가 재개 방법을 고를 필요가 없다.
   */
  resumeInterrupted(runId: string): boolean {
    if (this.closed || this.active.has(runId)) return false;
    const run = this.s.getRun(runId);
    if (!['needs_resume', 'running', 'queued', 'paused'].includes(run.status)) return false;
    const atts = this.s.runAttempts(runId);
    for (const n of this.s.runNodes(runId)) {
      if (['running', 'checking', 'rework'].includes(n.status)) this.s.updateRunNode(runId, n.nodeId, { status: 'needs_resume' });
      if (!['running', 'checking', 'rework', 'needs_resume'].includes(n.status) || this.s.getResolution(runId, n.nodeId)) continue;
      const last = atts.filter((a) => a.nodeId === n.nodeId && a.role === 'author').pop();
      this.s.setResolution(runId, n.nodeId, last?.status === 'interrupted' && last.sessionId ? 'continue_session' : 'retry');
      this.setNode(runId, n.nodeId, { nextAction: '앱 재시작 후 자동으로 이어서 진행' });
    }
    void this.drive(runId, 'resume');
    return true;
  }

  /** 자동 재개 예약을 끈다(사용자가 중지했거나 미션이 더는 진행 중이 아님): 한도 대기를 풀고 실행을 취소 상태로 둔다 */
  dropLimitSchedule(runId: string, reason: string) {
    const t = this.limitTimers.get(runId); if (t) { clearTimeout(t); this.limitTimers.delete(runId); }
    if (!this.limitOf(runId) || this.active.has(runId)) return;
    this.setMeta(runId, 'limit', '');
    for (const n of this.s.runNodes(runId)) if (n.status === 'needs_resume') this.s.updateRunNode(runId, n.nodeId, { status: 'cancelled', nextAction: '' });
    if (this.s.getRun(runId).status === 'needs_resume') this.s.setRunStatus(runId, 'cancelled', reason);
  }

  /** 한도 해제 후(또는 사용자가 '지금 다시 시도'를 누르면) 같은 실행을 이어서 진행한다. 끊긴 작성 작업은 같은 Claude 세션을 이어 쓴다. */
  resumeAfterLimit(runId: string): boolean {
    const t = this.limitTimers.get(runId); if (t) { clearTimeout(t); this.limitTimers.delete(runId); }
    if (this.closed || this.active.has(runId)) return false;
    const run = this.s.getRun(runId);
    if (run.status !== 'needs_resume' || !this.limitOf(runId)) return false;
    const atts = this.s.runAttempts(runId);
    for (const n of this.s.runNodes(runId).filter((x) => x.status === 'needs_resume')) {
      const last = atts.filter((a) => a.nodeId === n.nodeId && a.role === 'author').pop();
      if (last?.status === 'interrupted') this.s.setResolution(runId, n.nodeId, last.sessionId ? 'continue_session' : 'retry');
      this.setNode(runId, n.nodeId, { nextAction: '사용 한도 해제 — 이어서 진행' });
    }
    this.setMeta(runId, 'limit', '');
    void this.drive(runId, 'resume');
    return true;
  }

  // ───────── 공용 ─────────
  private get s() { return this.o.store; }
  private setRun(runId: string, status: Run['status'], reason?: string) { if (this.closed) return null as unknown as Run; const r = this.s.setRunStatus(runId, status, reason); this.o.emit({ type: 'run', run: r }); return r; }
  private setNode(runId: string, nodeId: string, patch: Partial<Omit<RunNodeState, 'runId' | 'nodeId' | 'updatedAt'>>) {
    if (this.closed) return null as unknown as RunNodeState;
    const st = this.s.updateRunNode(runId, nodeId, patch); this.o.emit({ type: 'node', state: st }); return st;
  }
  private saveAttempt(a: Attempt) { if (this.closed) return; this.s.saveAttempt(a); this.o.emit({ type: 'attempt', attempt: a }); }
  private meta(runId: string, key: string): string | null {
    const r = this.s.db.prepare('SELECT value FROM run_meta WHERE run_id=? AND key=?').get(runId, key) as { value: string } | undefined; return r?.value ?? null;
  }
  private setMeta(runId: string, key: string, value: string) { if (this.closed) return; this.s.db.prepare('INSERT OR REPLACE INTO run_meta VALUES(?,?,?)').run(runId, key, value); }
  private queueEvent() {
    const waiting = this.waiters.length;
    this.o.emit({ type: 'queue', running: this.running, waiting, max: this.o.maxConcurrent(), paused: [...this.active].filter(([, a]) => a.paused).map(([id]) => id) });
  }
  private wake() { const w = this.waiters; this.waiters = []; for (const f of w) f(); this.queueEvent(); }

  /** 동시 실행 한도·일시정지·수정 범위 잠금을 지키며 실행 자리를 얻는다. */
  private async acquire(runId: string, nodeId: string, folder: string, scopes: string[] | null): Promise<() => void> {
    const ctl = this.active.get(runId);
    const abs = scopes ? scopes.map((s) => absScope(folder, s)) : null;
    for (;;) {
      if (!ctl || ctl.abort.signal.aborted || this.closed) throw new Cancelled();
      const conflict = abs && this.held.some((h) => h.scopes.some((x) => abs.some((y) => absOverlap(x, y))));
      if (!ctl.paused && this.running < Math.max(1, this.o.maxConcurrent()) && !conflict) break;
      await new Promise<void>((res) => { this.waiters.push(res); this.queueEvent(); });
    }
    this.running++;
    const h: Held | null = abs ? { runId, nodeId, scopes: abs } : null;
    if (h) this.held.push(h);
    this.queueEvent();
    let released = false;
    return () => {
      if (released) return; released = true; this.running--;
      if (h) {
        this.held = this.held.filter((x) => x !== h);
        this.recentWriters.push({ runId: h.runId, nodeId: h.nodeId, scopes: h.scopes, endedAt: Date.now() });
        const cutoff = Date.now() - 6 * 3600 * 1000; this.recentWriters = this.recentWriters.filter((w) => w.endedAt > cutoff).slice(-500);
      }
      this.wake();
    };
  }

  // ───────── 실행 시작 ─────────
  startRun(projectId: string, graphVersionId: string, opts: { parentRunId?: string; startNodeId?: string; seed?: Partial<S>; missionId?: string; cycle?: number } = {}): Run {
    const project = this.s.getProject(projectId);
    const gv = this.s.getGraphVersion(graphVersionId);
    if (gv.projectId !== projectId) throw new Error('다른 프로젝트의 흐름입니다.');
    const agents = this.s.listAgents(projectId);
    const ex = this.o.executor();
    if (ex.executor === 'claude' && !ex.cliPath) throw new Error('Claude CLI가 준비되지 않았습니다. 설정에서 CLI 상태를 확인하세요.');
    if (!project.plan.folder || !existsSync(project.plan.folder)) throw new Error('연결한 프로젝트 폴더가 없습니다.');
    // 같은 흐름 버전을 같은 프로젝트에서 동시에 두 번 실행하지 않는다(중복 시작 방지).
    const dup = this.s.listRuns(projectId).find((r) => ['queued', 'running', 'paused'].includes(r.status) && r.graphVersionId === graphVersionId && !opts.parentRunId);
    if (dup) throw new Error('같은 흐름 버전의 실행이 이미 진행 중입니다.');
    const run = this.s.createRun({ projectId, graph: gv, plan: project, agents, executor: ex.executor, parentRunId: opts.parentRunId ?? null, startNodeId: opts.startNodeId ?? null, seed: opts.seed ?? null });
    // 검사 명령이 참조하는 파일의 해시를 실행 시작 시점에 고정(검사 코드 약화 탐지)
    // 검사 코드(스크립트·실행 파일)는 위치와 관계없이 실행 시작 시점의 해시로 고정한다. 검사 입력(문서·데이터 산출물)은 고정하지 않는다.
    const pins: Record<string, string> = {};
    for (const n of gv.graph.nodes) if (n.kind === 'check') for (const a of n.command) {
      const p = isAbsolute(a) ? a : join(project.plan.folder, a);
      if (!isCheckCode(p)) continue;
      try { if (existsSync(p) && statSync(p).isFile()) pins[p] = fileSha(p); } catch { /* 무시 */ }
    }
    this.setMeta(run.id, 'check_pins', JSON.stringify(pins));
    if (opts.missionId) { this.setMeta(run.id, 'mission', opts.missionId); this.setMeta(run.id, 'cycle', String(opts.cycle ?? '')); }
    // 비용 값의 의미: claude.ai 구독 로그인이면 플랜 사용량(청구 아님), API 키면 추정 청구액
    const am = (ex.authMethod ?? '').toLowerCase();
    this.setMeta(run.id, 'billing', ex.executor === 'mock' ? 'mock' : am.includes('claude.ai') || am.includes('oauth') || am.includes('subscription') ? 'subscription' : am.includes('api') ? 'api' : 'unknown');
    this.o.tracer?.runStarted(run, { project: project.plan.name, graphVersion: gv.version, executor: ex.executor });
    void this.drive(run.id, 'start');
    return run;
  }

  rerunFrom(runId: string, nodeId: string): Run {
    const parent = this.s.getRun(runId);
    if (['running', 'queued', 'paused'].includes(parent.status)) throw new Error('진행 중인 실행에서는 먼저 취소하거나 끝난 뒤 재실행하세요.');
    const gv = this.s.getGraphVersion(parent.graphVersionId);
    if (!gv.graph.nodes.some((n) => n.id === nodeId)) throw new Error('선택한 단계가 흐름에 없습니다.');
    const states = this.s.runNodes(runId);
    const desc = reach(forwardAdj(gv.graph), nodeId); desc.add(nodeId);
    const seedRecords: Record<string, Rec> = {}; const seedRoute: Record<string, string[]> = {};
    for (const st of states) {
      if (desc.has(st.nodeId) || st.status !== 'succeeded') continue;
      const outs = JSON.parse(this.meta(runId, `outputs:${st.nodeId}`) ?? '[]') as string[];
      seedRecords[st.nodeId] = { status: 'ok', outputs: outs, summary: st.summary, at: now() };
      seedRoute[st.nodeId] = JSON.parse(this.meta(runId, `route:${st.nodeId}`) ?? '[]');
    }
    const run = this.startRun(parent.projectId, parent.graphVersionId, { parentRunId: runId, startNodeId: nodeId, seed: { records: seedRecords, route: seedRoute } });
    for (const id of Object.keys(seedRecords)) {
      this.setNode(run.id, id, { status: 'succeeded', summary: `이전 실행 ${runId.slice(0, 8)}의 완료 결과 재사용`, nextAction: '' });
      this.setMeta(run.id, `outputs:${id}`, JSON.stringify(seedRecords[id].outputs)); this.setMeta(run.id, `route:${id}`, JSON.stringify(seedRoute[id]));
      for (const a of this.s.artifacts(runId).filter((x) => x.nodeId === id)) this.s.addArtifact({ ...a, id: uid(), runId: run.id });
    }
    return run;
  }

  pause(runId: string) { const a = this.active.get(runId); if (!a) throw new Error('실행 중이 아닙니다.'); a.paused = true; this.setRun(runId, 'paused', '새 작업 배정을 일시정지했습니다. 진행 중인 작업은 계속됩니다.'); this.queueEvent(); }

  async resume(runId: string) {
    const a = this.active.get(runId);
    if (a) { a.paused = false; this.setRun(runId, 'running', ''); this.wake(); return; }
    const run = this.s.getRun(runId);
    if (run.status === 'needs_resume' || run.status === 'failed') {
      const pending = this.s.runNodes(runId).filter((n) => n.status === 'needs_resume' && !this.s.getResolution(runId, n.nodeId));
      if (pending.length) throw new Error(`재개 방법을 먼저 선택하세요: ${pending.length}개 단계`);
      void this.drive(runId, 'resume');
      return;
    }
    throw new Error(`현재 상태(${run.status})에서는 재개할 수 없습니다.`);
  }

  async cancel(runId: string) {
    const a = this.active.get(runId);
    if (a) {
      a.userCancelled = true;
      a.abort.abort();
      for (const p of a.procs.values()) p.cancel();
      this.wake();
      return;
    }
    const run = this.s.getRun(runId);
    const lt = this.limitTimers.get(runId); if (lt) { clearTimeout(lt); this.limitTimers.delete(runId); }
    if (this.limitOf(runId)) this.setMeta(runId, 'limit', '');
    if (['succeeded', 'cancelled'].includes(run.status)) return;
    for (const n of this.s.runNodes(runId)) if (['waiting', 'review_wait', 'needs_resume', 'running', 'checking', 'rework'].includes(n.status)) this.setNode(runId, n.nodeId, { status: 'cancelled', nextAction: '' });
    this.setRun(runId, 'cancelled', '사용자가 취소했습니다.');
  }

  resolveInterrupted(runId: string, nodeId: string, action: 'retry' | 'continue_session' | 'verify_only') {
    const st = this.s.getRunNode(runId, nodeId);
    if (st.status !== 'needs_resume') throw new Error('재개 확인이 필요한 단계가 아닙니다.');
    this.s.setResolution(runId, nodeId, action);
    this.setNode(runId, nodeId, { nextAction: { retry: '새 시도로 다시 실행', continue_session: '기존 Claude 세션 이어서 작업', verify_only: '산출물·검사만 확인' }[action] });
  }

  async submitReview(runId: string, nodeId: string, verdict: ReviewRecord['verdict'], comments: string, targetNodeId: string | null, subjectHash: string): Promise<ReviewRecord> {
    const run = this.s.getRun(runId);
    const gv = this.s.getGraphVersion(run.graphVersionId);
    const node = gv.graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== 'userReview') throw new Error('사용자 검토 단계가 아닙니다.');
    const st = this.s.getRunNode(runId, nodeId);
    if (st.status !== 'review_wait') throw new Error('검토 대기 상태가 아닙니다.');
    const current = this.subjectHash(runId);
    if (!current || current !== subjectHash) throw new Error('검토 화면을 연 뒤 결과물이 바뀌었습니다. 새 결과물을 확인한 뒤 다시 결정하세요.');
    if (verdict === 'changes_requested') {
      if (!comments.trim()) throw new Error('수정 요청 의견을 입력하세요.');
      const t = targetNodeId ? gv.graph.nodes.find((n) => n.id === targetNodeId) : null;
      if (targetNodeId && (!t || t.kind !== 'agent')) throw new Error('수정 요청 대상은 Agent 작업 단계여야 합니다.');
      if (!targetNodeId && !gv.graph.edges.some((e) => e.source === nodeId && e.kind === 'fail')) throw new Error('수정 요청을 받을 담당 단계를 선택하세요.');
    }
    const rec: ReviewRecord = { id: uid(), runId, nodeId, kind: 'user', reviewerAgentId: null, verdict, comments, targetNodeId, subjectHash, graphVersionId: run.graphVersionId, stale: false, createdAt: now() };
    this.s.addReview(rec);
    if (verdict === 'hold') {
      this.setRun(runId, 'on_hold', '팀장이 보류했습니다. 현재 결과와 상태를 보존합니다.');
      this.setNode(runId, nodeId, { nextAction: '보류 중 — 수정 요청 또는 검토 완료를 선택하면 진행합니다.' });
      return rec;
    }
    void this.drive(runId, 'review', rec.id);
    return rec;
  }

  /** 앱 시작 시: 이전에 진행 중이던 실행을 '재개 확인 필요'로 복원한다. 완료 단계는 다시 실행하지 않는다. */
  async recoverOnStartup() {
    for (const a of this.s.attemptsWithStatus('running')) {
      // 앱이 시작한 고아 프로세스만 종료: PID + 기록한 프로세스 시작 시각 + 명령줄 표식이 모두 일치해야 한다(PID 재사용 대비)
      const oIdx = a.argvRedacted.indexOf('-o');
      // Windows: .cmd·이름만 적은 명령은 node.exe 등으로 바뀌어 실행되므로 첫 인자 대신 나머지 인자로 확인한다
      // (공백이 있는 인자는 따옴표로 감싸져도 글자 그대로 들어 있다. 따옴표가 든 인자는 \\"로 바뀌므로 제외한다. 인자가 없으면 시작 시각만으로 확인한다)
      const marker = a.role === 'check' ? (a.argvRedacted.slice(1).find((x) => x && !x.includes('"')) ?? '') : a.role === 'codex' ? (a.argvRedacted[oIdx + 1] ?? '\u0000') : (a.sessionId ?? '\u0000');
      if (a.pid && a.procStart && await isOurProcess(a.pid, marker, a.procStart)) await killGroupAndWait(a.pid); // 실제로 끝난 뒤에 재개 가능(격리 복사본 오염 방지)
      this.s.saveAttempt({ ...a, status: 'interrupted', error: '앱 종료로 중단됨', finishedAt: now() });
      this.s.updateRunNode(a.runId, a.nodeId, { status: 'needs_resume', failureReason: '앱이 종료될 때 실행 중이었습니다.', nextAction: '재개 방법을 선택하세요: 새 시도 / 세션 이어서 / 산출물만 확인' });
    }
    for (const r of this.s.runsWithStatus(['running', 'queued', 'paused'])) {
      for (const n of this.s.runNodes(r.id)) if (['running', 'checking', 'rework'].includes(n.status)) this.s.updateRunNode(r.id, n.nodeId, { status: 'needs_resume', nextAction: '재개 방법을 선택하세요.' });
      this.s.setRunStatus(r.id, 'needs_resume', '앱이 종료될 때 실행 중이었습니다. 완료된 단계는 다시 실행하지 않습니다.');
    }
    for (const r of this.s.runsWithStatus(['needs_resume'])) {
      const lim = this.limitOf(r.id);
      if (!lim) continue;
      // 미션 실행도 저장한 해제 시각에 앱이 다시 확인한다(재시작해도 예약 유지). 지난 시각이면(절전·종료 중 지남) 한 번만 바로 확인한다.
      this.scheduleLimitResume(r.id, lim.until);
    }
  }

  /** 앱 종료 시: 실행 중 프로세스를 정리하고 재개 가능 상태로 남긴다. */
  shutdown() {
    for (const t of this.limitTimers.values()) clearTimeout(t);
    this.limitTimers.clear();
    for (const [runId, a] of this.active) {
      a.abort.abort();
      for (const [attemptId, p] of a.procs) {
        p.cancel();
        const at = this.s.getAttempt(attemptId);
        if (at) this.s.saveAttempt({ ...at, status: 'interrupted', error: '앱 종료로 중단됨', finishedAt: now() }); // JSON과 상태 열을 함께 갱신
      }
      this.s.setRunStatus(runId, 'needs_resume', '앱 종료로 중단됨');
      for (const n of this.s.runNodes(runId)) if (['running', 'checking', 'rework'].includes(n.status)) this.s.updateRunNode(runId, n.nodeId, { status: 'needs_resume', nextAction: '재개 방법을 선택하세요.' });
    }
    this.active.clear();
    this.closed = true;
  }

  /** 종료 처리 후 앱이 시작한 프로세스가 실제로 끝날 때까지(최대 timeoutMs) 기다린다. */
  async shutdownAndWait(timeoutMs = 6000) {
    const procs = [...this.active.values()].flatMap((a) => [...a.procs.values()]);
    this.shutdown();
    await Promise.race([Promise.all(procs.map((p) => p.done)), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  isActive(runId: string) { return this.active.has(runId); }

  // ───────── 그래프 컴파일과 구동 ─────────
  private compile(run: Run, graph: WorkGraph, lanes: boolean) {
    const sg = new StateGraph(RunState) as unknown as {
      addNode: (id: string, fn: (s: S) => Promise<Update>) => void;
      addEdge: (a: string, b: string) => void;
      addConditionalEdges: (a: string, fn: (s: S) => string[] | string) => void;
      compile: (o: { checkpointer: NodeSqliteSaver }) => {
        invoke: (input: unknown, cfg: unknown) => Promise<unknown>;
        getState: (cfg: unknown) => Promise<{ next: string[]; values: S }>;
      };
    };
    const ents = entryNodes(graph); const inputs = ents.filter((n) => n.kind === 'input');
    const starts = run.startNodeId ? [run.startNodeId] : (inputs.length ? inputs : ents).map((n) => n.id);
    // 작업 줄: 한 입구로만 들어오는 묶음(작성 → 리뷰 → 재검토 → 검사)은 한 실행 단위로 돌려, 먼저 끝난 작업이 다른 작업을 기다리지 않고 다음 단계로 간다.
    // 이전 방식으로 시작한 실행(체크포인트가 개별 단계 기준)은 그대로 이어서 진행한다.
    const blocks = lanes ? laneBlocks(graph, starts) : new Map<string, { head: string; members: string[] }>();
    const blockOf = new Map<string, string>();
    for (const [key, b] of blocks) for (const m of b.members) blockOf.set(m, key);
    const target = (id: string) => blockOf.get(id) ?? id;
    const uniq = (xs: string[]) => [...new Set(xs.map(target))];
    const counted = async (fn: () => Promise<Update>) => {
      // 진행 중인 노드 작업 수 — 사용 한도로 멈출 때 남은 작업이 모두 끝난 뒤에 재개 가능 상태로 둔다
      const c = this.active.get(run.id); if (c) c.inflight++;
      try { return await fn(); } finally { if (c) c.inflight--; }
    };
    for (const n of graph.nodes) {
      if (blockOf.has(n.id)) continue;
      sg.addNode(n.id, (state: S) => counted(() => this.execNode(run.id, graph, n, state)));
      sg.addConditionalEdges(n.id, (state: S) => { const r = uniq(state.route[n.id] ?? []); return r.length ? r : END; });
    }
    for (const [key, b] of blocks) {
      const members = new Set(b.members);
      sg.addNode(key, (state: S) => counted(() => this.execLane(run.id, graph, key, b.head, members, target, state)));
      sg.addConditionalEdges(key, (state: S) => { const r = state.route[key] ?? []; return r.length ? r : END; });
    }
    for (const s of uniq(starts)) sg.addEdge(START, s);
    return sg.compile({ checkpointer: this.o.checkpointer });
  }

  private async drive(runId: string, mode: 'start' | 'resume' | 'review', reviewId?: string) {
    if (this.active.has(runId)) return;
    const run = this.s.getRun(runId);
    const gv = this.s.getGraphVersion(run.graphVersionId); // 시작 당시 고정된 흐름 버전
    const plan = this.s.runSnapshot(runId).plan;
    const ctl: Active = { abort: new AbortController(), paused: false, procs: new Map(), folder: plan.folder, inflight: 0 };
    this.active.set(runId, ctl);
    // 다시 구동하면 이전 한도 대기 표시는 끝난 것이다(사용자가 실행 화면에서 직접 재개한 경우 포함)
    { const lt = this.limitTimers.get(runId); if (lt) { clearTimeout(lt); this.limitTimers.delete(runId); } if (this.limitOf(runId)) this.setMeta(runId, 'limit', ''); }
    this.setRun(runId, 'running', '');
    const config = { configurable: { thread_id: runId }, recursionLimit: 10000, signal: ctl.abort.signal };
    try {
      let input: unknown;
      const prior = await this.o.checkpointer.getTuple({ configurable: { thread_id: runId } });
      if (!prior && mode !== 'review') this.setMeta(runId, 'lanes', '1'); // 처음 시작하는 실행만 작업 줄 방식
      const app = this.compile(run, gv.graph, this.meta(runId, 'lanes') === '1');
      if (mode === 'review') input = new Command({ resume: reviewId });
      else if (prior) input = null; // 마지막 체크포인트부터 재개
      else input = (this.s.runSnapshot(runId).seed as Partial<S> | null) ?? {};
      await app.invoke(input, config);
      const snap = await app.getState(config);
      if (snap.next.length) {
        // 사용자 검토 대기(interrupt)
        const cur = this.s.getRun(runId).status;
        if (cur !== 'on_hold') this.setRun(runId, 'review_wait', '팀장 검토를 기다립니다.');
      } else {
        this.finalize(runId, gv.graph, snap.values);
      }
    } catch (e) {
      if (this.closed) return; // 앱 종료 중: 상태는 shutdown()이 이미 저장했다
      const err = e as Error;
      const lim = ctl.abort.signal.aborted ? null : this.limitOf(runId);
      if (lim) {
        // 사용 한도: 함께 돌던 작업도 같은 한도에 걸리므로 새 작업 배정·프로세스 시작을 막고(중단 신호), 남은 노드 작업이 모두 끝난 뒤에
        // 재개 가능 상태로 둔다. 해제 시각에 같은 실행을 이어서 진행한다.
        ctl.abort.abort(); this.wake();
        const t0 = Date.now();
        while ((ctl.inflight > 0 || ctl.procs.size > 0) && Date.now() - t0 < 30000) {
          for (const p of ctl.procs.values()) p.cancel();
          await Promise.race([Promise.all([...ctl.procs.values()].map((p) => p.done)), new Promise((r) => setTimeout(r, 100))]);
        }
        if (this.closed) return;
        if (ctl.userCancelled) {
          // 정리하는 동안 사용자가 취소함: 자동 재개하지 않는다
          this.setMeta(runId, 'limit', '');
          for (const n of this.s.runNodes(runId)) if (!['succeeded', 'failed', 'skipped'].includes(n.status)) this.setNode(runId, n.nodeId, { status: 'cancelled', nextAction: '' });
          this.setRun(runId, 'cancelled', '사용자가 취소했습니다(사용 한도 대기 전).');
        } else {
          for (const n of this.s.runNodes(runId)) if (['running', 'checking', 'rework', 'cancelled'].includes(n.status)) this.setNode(runId, n.nodeId, { status: 'needs_resume', nextAction: '사용 한도 해제 후 이어서 진행' });
          this.setRun(runId, 'needs_resume', `사용 한도 도달 — ${fmtTime(lim.until)} 이후 자동으로 이어서 진행합니다(${lim.text})`);
          this.scheduleLimitResume(runId, lim.until);
        }
      } else if (ctl.abort.signal.aborted || err instanceof Cancelled || err?.name === 'AbortError') {
        for (const n of this.s.runNodes(runId)) if (!['succeeded', 'failed', 'skipped'].includes(n.status)) this.setNode(runId, n.nodeId, { status: 'cancelled', nextAction: '' });
        if (this.s.getRun(runId).status !== 'needs_resume') this.setRun(runId, 'cancelled', '사용자가 취소했습니다. 실행 중 프로세스를 종료했습니다.');
      } else {
        // 진행 중이던 형제 작업 정리
        for (const p of ctl.procs.values()) p.cancel();
        await Promise.all([...ctl.procs.values()].map((p) => p.done));
        const nr = err instanceof NeedsResume || err?.name === 'NeedsResume';
        for (const n of this.s.runNodes(runId)) if (['running', 'checking', 'rework'].includes(n.status)) this.setNode(runId, n.nodeId, { status: 'needs_resume', nextAction: '재개 방법을 선택하세요.' });
        this.setRun(runId, nr ? 'needs_resume' : 'failed', redact(err?.message ?? String(e)));
      }
    } finally {
      if (!this.closed) {
        this.active.delete(runId);
        try { this.partialDeliverable(runId, gv.graph, plan); } catch { /* 중간 결과 정리 실패는 실행 결과에 영향 없음 */ }
        this.wake();
        this.o.tracer?.runEnded(this.s.getRun(runId));
      }
    }
  }

  /** 실패·중단·재개 대기로 끝난 실행: 결과물 취합까지 못 갔어도 그 시점까지의 결과(단계별 상태·산출물·검사·리뷰)를 결과물로 남긴다(앱 기록에만) */
  private partialDeliverable(runId: string, graph: WorkGraph, plan: PlanFields) {
    const run = this.s.getRun(runId);
    if (!['failed', 'cancelled', 'needs_resume'].includes(run.status) || this.s.latestDeliverable(runId)) return;
    const snap = this.s.runSnapshot(runId);
    const body = buildReport({ billing: (this.meta(runId, 'billing') ?? 'unknown') as Billing, run, plan, graph, agents: snap.agents, nodes: this.s.runNodes(runId), attempts: this.s.runAttempts(runId), artifacts: this.s.artifacts(runId), checks: this.s.checks(runId), reviews: this.s.reviews(runId) });
    const label = run.status === 'failed' ? '실패' : run.status === 'cancelled' ? '중단' : '재개 대기';
    const md = `> **${label}한 실행의 중간 결과** — 결과물 취합 단계까지 가지 못했습니다. 아래는 ${label} 시점까지 완료된 단계·산출물·검사·리뷰입니다.${run.reason ? `\n> 이유: ${run.reason}` : ''}\n\n${body}`;
    this.s.saveDeliverable({ runId, hash: sha256(`partial|${runId}|${md}`), reportPath: '', goal: plan.goal, doneCriteria: plan.doneCriteria, markdown: md, createdAt: now() });
    this.o.emit({ type: 'run', run });
  }

  private finalize(runId: string, graph: WorkGraph, values: S) {
    const states = this.s.runNodes(runId);
    for (const st of states) if (st.status === 'waiting') this.setNode(runId, st.nodeId, { status: 'skipped', summary: '이번 실행 경로에서 실행되지 않음' });
    const stuck = graph.nodes.filter((n) => values.records[n.id]?.status === 'waiting');
    if (values.terminal.length) this.setRun(runId, 'failed', values.terminal.join(' / '));
    else if (stuck.length) this.setRun(runId, 'failed', `선행 단계가 완료되지 않아 진행하지 못한 단계: ${stuck.map((n) => n.label).join(', ')}`);
    else this.setRun(runId, 'succeeded', '모든 단계가 완료 조건을 충족했습니다.');
  }

  /**
   * 작업 줄 실행: 입구(head)부터 묶음 안의 단계를 차례로(한 단계가 묶음 안 여러 단계로 갈 때는 함께) 실행한다.
   * 각 단계는 평소와 같은 execNode로 실행하고 방문 결과도 같은 방식으로 저장하므로, 중간에 멈춰도 재개 때 끝난 단계는 저장된 결과를 쓴다.
   * 묶음 밖으로 나가는 연결은 route[묶음 키]에 모아 LangGraph가 다음 단계로 넘긴다.
   */
  private async execLane(runId: string, graph: WorkGraph, key: string, head: string, members: Set<string>, target: (id: string) => string, state: S): Promise<Update> {
    const L: S = { records: { ...state.records }, visits: { ...state.visits }, route: { ...state.route }, feedback: { ...state.feedback }, terminal: [...state.terminal] };
    const acc = { records: {} as S['records'], visits: {} as S['visits'], route: {} as S['route'], feedback: {} as S['feedback'], terminal: [] as string[] };
    const apply = (t: S | typeof acc, u: Update) => {
      Object.assign(t.records, u.records ?? {}); Object.assign(t.visits, u.visits ?? {}); Object.assign(t.route, u.route ?? {}); Object.assign(t.feedback, u.feedback ?? {});
      if (u.terminal?.length) t.terminal.push(...u.terminal);
    };
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const exits = new Set<string>();
    let frontier = [head];
    while (frontier.length) {
      const snap: S = { records: { ...L.records }, visits: { ...L.visits }, route: { ...L.route }, feedback: { ...L.feedback }, terminal: [...L.terminal] };
      const ups = await Promise.all(frontier.map((id) => this.execNode(runId, graph, byId.get(id)!, snap)));
      for (const u of ups) { apply(L, u); apply(acc, u); }
      const next = new Set<string>();
      for (const id of frontier) for (const t of L.route[id] ?? []) (members.has(t) ? next : exits).add(t);
      frontier = [...next];
    }
    acc.route[key] = [...new Set([...exits].map(target))];
    return acc;
  }

  // ───────── 노드 실행 ─────────
  private async execNode(runId: string, graph: WorkGraph, node: GraphNode, state: S): Promise<Update> {
    const ctl = this.active.get(runId);
    if (!ctl || ctl.abort.signal.aborted) throw new Cancelled();
    const preds = graph.edges.filter((e) => e.target === node.id && ['next', 'true', 'false'].includes(e.kind)).map((e) => e.source);
    const sat = (p: string) => (state.route[p] ?? []).includes(node.id) && !['stale', 'waiting', undefined].includes(state.records[p]?.status as RecStatus);
    const enteredByFail = !!state.feedback[node.id] && state.records[node.id]?.status !== 'ok';
    if (preds.length > 1 && !enteredByFail) {
      const ready = node.entryCondition === 'any' ? preds.some(sat) : preds.every(sat);
      const already = node.entryCondition === 'any' && state.records[node.id] && !['stale', 'waiting'].includes(state.records[node.id].status);
      if (!ready || already) return { route: { [node.id]: [] }, records: already ? {} : { [node.id]: { status: 'waiting', outputs: [], summary: '', at: now() } } };
    }
    const visit = (state.visits[node.id] ?? 0) + 1;
    // 같은 방문의 결과가 이미 저장돼 있으면(체크포인트 기록 직전 종료 등) 다시 실행하지 않고 저장된 결과를 사용한다.
    const stored = this.s.db.prepare('SELECT update_json FROM visit_outcomes WHERE run_id=? AND node_id=? AND visit=?').get(runId, node.id, visit) as { update_json: string } | undefined;
    // 사용자 검토는 저장된 결과를 그대로 쓰지 않고 현재 결과물 해시로 다시 판정한다(변경된 결과에 이전 승인 재사용 방지).
    if (stored && node.kind !== 'userReview') return JSON.parse(stored.update_json) as Update;
    if (stored) this.s.db.prepare('DELETE FROM visit_outcomes WHERE run_id=? AND node_id=? AND visit=?').run(runId, node.id, visit);

    const plan = this.s.runSnapshot(runId).plan;
    if (visit > node.maxVisits) {
      const msg = `"${node.label}" 재작업 상한(${node.maxVisits}회)을 넘었습니다.`;
      this.setNode(runId, node.id, { status: 'failed', failureReason: msg, nextAction: '흐름·지시를 고친 뒤 이 단계부터 재실행하세요.' });
      return this.commit(runId, node, visit, { route: { [node.id]: [] }, terminal: [msg] });
    }
    const feedback = state.feedback[node.id] ?? '';
    this.setNode(runId, node.id, { status: feedback && visit > 1 ? 'rework' : 'running', visits: visit, failureReason: '', nextAction: '' });
    const upstream = preds.flatMap((p) => state.records[p]?.outputs ?? []);

    let out: { status: 'ok' | 'fail' | 'true' | 'false'; summary: string; outputs: string[]; reason?: string; feedbackText?: string; target?: string | null };
    switch (node.kind) {
      case 'input': out = { status: 'ok', summary: `기획 전달(목표·완료 조건·참고 자료 ${plan.referenceDocs.length + plan.priorOutputs.length}건)`, outputs: [...plan.referenceDocs, ...plan.priorOutputs] }; break;
      case 'agent': out = await this.runAgentNode(runId, graph, node, visit, plan, upstream, feedback); break;
      case 'check': out = await this.runCheckNode(runId, node, visit, plan); break;
      case 'codexReview': out = this.lightSkip(runId, graph, node, upstream) ?? await this.runCodexNode(runId, node, visit, plan, upstream); break;
      case 'review': out = this.lightSkip(runId, graph, node, upstream) ?? await this.runReviewNode(runId, node, visit, plan, upstream, preds.map((p) => graph.nodes.find((n) => n.id === p)!).filter(Boolean), graph); break;
      case 'branch': out = this.evalBranch(node, state, plan); break;
      case 'merge': out = this.runMerge(runId, graph, node, plan); await this.commitFor(runId, node, plan, out.outputs, { name: 'CREWGENAI 00 총괄(결과물 취합)', email: 'agent-00@crewgenai.local' }, '00 총괄(결과물 취합)'); break;
      case 'userReview': out = await this.runUserReview(runId, node, visit); break;
      default: out = { status: 'fail', summary: '', outputs: [], reason: '알 수 없는 단계 종류' };
    }

    // 다음 단계 결정 — 노드 상태·출력·경로·방문 결과를 한 트랜잭션으로 저장
    return this.atomic(() => {
    const fwd = (k: string) => graph.edges.filter((e) => e.source === node.id && e.kind === k).map((e) => e.target);
    const update: Update = { visits: { [node.id]: visit }, feedback: { [node.id]: '' }, terminal: [] };
    const stale: Record<string, Rec> = {};
    for (const d of reach(forwardAdj(graph), node.id)) if (d !== node.id) stale[d] = { status: 'stale', outputs: [], summary: '', at: now() };
    let route: string[] = [];
    if (out.status === 'ok') route = fwd('next');
    else if (out.status === 'true' || out.status === 'false') route = fwd(out.status);
    else {
      const target = out.target ?? fwd('fail')[0] ?? null;
      if (target) {
        const tNode = graph.nodes.find((n) => n.id === target)!;
        const tv = state.visits[target] ?? 0;
        if (tv >= tNode.maxVisits) {
          const msg = `"${tNode.label}" 재작업 상한(${tNode.maxVisits}회) 초과 — ${out.reason ?? ''}`;
          update.terminal = [msg];
          this.setNode(runId, node.id, { status: 'failed', failureReason: out.reason ?? '', nextAction: '재작업 상한을 넘어 실행을 멈췄습니다. 원인을 확인한 뒤 해당 담당 단계부터 재실행하세요.' });
        } else {
          route = [target];
          update.feedback = { [node.id]: '', [target]: `[${node.label}] ${out.feedbackText ?? out.reason ?? ''}` };
          this.setNode(runId, target, { status: 'rework', nextAction: `${node.label}의 지적을 반영해 다시 작업합니다.`, failureReason: out.reason ?? '' });
        }
      } else {
        update.terminal = [`"${node.label}" 실패: ${out.reason ?? ''}`];
      }
    }
    update.route = { [node.id]: route };
    update.records = { ...stale, [node.id]: { status: out.status, outputs: out.outputs, summary: out.summary, at: now() } };
    const finalStatus: NodeStatus = out.status === 'fail' ? 'failed' : 'succeeded';
    const cur = this.s.getRunNode(runId, node.id);
    const reworkTarget = route.length === 1 && out.status === 'fail';
    this.setNode(runId, node.id, {
      status: cur.status === 'failed' && out.status === 'fail' ? 'failed' : finalStatus,
      summary: out.summary, failureReason: out.status === 'fail' ? (out.reason ?? '') : '',
      nextAction: out.status === 'fail' ? (reworkTarget ? `재작업 배정: ${graph.nodes.find((n) => n.id === route[0])?.label}` : cur.nextAction) : '',
    });
    this.setMeta(runId, `outputs:${node.id}`, JSON.stringify(out.outputs));
    this.setMeta(runId, `route:${node.id}`, JSON.stringify(route));
    return this.commit(runId, node, visit, update);
    });
  }

  /**
   * 직원별 git 커밋: 이 시도가 바꾼 경로만, 작성자를 직원으로 커밋한다(push 없음).
   * 실패해도 작업 판정은 바꾸지 않고 이유를 기록한다.
   */
  private async commitFor(runId: string, node: GraphNode, plan: PlanFields, paths: string[], who: { name: string; email: string }, agentLabel: string, attempt?: Attempt, exclude: Set<string> = new Set()) {
    if (this.closed || !(this.o.gitCommits?.() ?? true) || !paths.length) return;
    const mission = this.meta(runId, 'mission') ?? '';
    const cycle = this.meta(runId, 'cycle') ?? '';
    const branch = this.o.autoAssist?.() ? workBranchName(mission || runId) : undefined;
    const res = await commitWorkspace(plan.folder, paths, who, `[CREWGENAI] ${agentLabel} · ${node.label}`.slice(0, 120), {
      'Crewgenai-Mission': mission, 'Crewgenai-Cycle': cycle, 'Crewgenai-Run': runId, 'Crewgenai-Node': node.label.slice(0, 80),
      'Crewgenai-Agent': agentLabel, 'Crewgenai-Visit': attempt ? String(attempt.visit) : '', 'Crewgenai-Session': attempt?.sessionId ?? '',
    }, exclude, branch);
    if (attempt) { attempt.commitSha = res.sha; attempt.commitNote = res.error ?? res.skipped ?? ''; }
    if (!this.closed && attempt) {
      const ev = { attemptId: attempt.id, seq: 9000 + (attempt.attemptNo ?? 0), at: now(), kind: 'system' as const, summary: res.sha ? `git 커밋 ${res.commits.length > 1 || res.commits[0]?.repo ? res.sha : res.sha.slice(0, 8)} · 작성자 ${who.name} · ${paths.length}개 파일${res.skipped || res.error ? ` (${res.error ?? res.skipped})` : ''}` : `git 커밋 안 함: ${res.error ?? res.skipped}`, raw: '' };
      this.s.addEvent(ev); this.o.emit({ type: 'event', event: ev });
    }
  }

  /** 앱이 직접 쓴 파일(Codex 보고서·결과물 보고서)을 기록해 동시에 실행 중인 작업의 범위 밖 변경으로 오인하지 않게 한다. */
  private noteSystemWrite(runId: string, nodeId: string, abs: string) {
    this.recentWriters.push({ runId, nodeId: `${nodeId}#system`, scopes: [join(realFolder(dirname(abs)), basename(abs))], endedAt: Date.now() });
  }

  /** 여러 기록을 하나의 SQLite 트랜잭션으로 저장한다(중간 종료 시 일부만 남지 않게). 동기 함수만 받는다. */
  private atomic<T>(fn: () => T): T { return this.closed ? (undefined as T) : this.s.tx(fn); }

  private commit(runId: string, node: GraphNode, visit: number, update: Update): Update {
    this.s.db.prepare('INSERT OR IGNORE INTO visit_outcomes VALUES(?,?,?,?,?)').run(runId, node.id, visit, JSON.stringify(update), now());
    return update;
  }

  // ───────── Agent 작업 ─────────
  private agentOf(runId: string, id: string | null): Agent | undefined {
    if (!id) return undefined;
    return this.s.runSnapshot(runId).agents.find((a) => a.id === id); // 실행 시작 당시의 직원 정의 버전
  }

  private async runAgentNode(runId: string, graph: WorkGraph, node: GraphNode, visit: number, plan: PlanFields, upstream: string[], feedback: string) {
    const agent = this.agentOf(runId, node.agentId);
    if (!agent) return { status: 'fail' as const, summary: '', outputs: [], reason: '담당 직원 정의를 찾을 수 없습니다.' };
    const scope = effectiveScope(node, agent, plan);
    const maxAttempts = Math.max(1, (node.maxRetries ?? agent.maxRetries) + 1);
    let extra = feedback;
    const existing = this.s.findAttempts(runId, node.id, visit, 'author');
    let attemptNo = existing.length;
    let lastReason = '';
    // 이미 성공한 작성 시도가 있으면 재사용(재개 시 중복 실행 방지)
    let author: Attempt | undefined = existing.find((a) => a.status === 'succeeded' && a.acceptance?.ok);
    const interrupted = existing.find((a) => a.status === 'interrupted');
    let carry: string | null = null; let timeoutResumed = false; // 시간 초과로 끊긴 세션은 한 번만 이어 간다(재시도 횟수와 별도로 한 번)
    for (let i = 0; !author && i < maxAttempts + (timeoutResumed ? 1 : 0); i++) {
      let resumeSession: string | null = carry; carry = null;
      if (interrupted && i === 0) {
        const res = this.s.getResolution(runId, node.id);
        if (!res) { this.setNode(runId, node.id, { status: 'needs_resume' }); throw new NeedsResume(`"${node.label}" 재개 방법 선택 필요`); }
        this.s.setResolution(runId, node.id, null);
        if (res === 'verify_only') {
          const leftover = this.applyLeftoverIsolation(runId, node, plan, scope, agent);
          const acc = this.acceptance(plan, node, interrupted, null, null, false, [], true);
          if (leftover) { acc.checks.push(leftover); acc.ok = acc.ok && leftover.ok; }
          interrupted.acceptance = acc; interrupted.summary = `[CLI 성공 미확인 — 사용자가 '산출물만 확인'을 선택]\n${interrupted.summary}`;
          // 상태는 'interrupted'로 둔다(CLI 성공 미확인). 단계 진행만 사용자의 확인 선택에 따른다.
          if (acc.ok) { this.atomic(() => { this.saveAttempt(interrupted); this.registerArtifacts(runId, node, interrupted, plan); }); author = interrupted; break; }
          this.saveAttempt(interrupted);
          lastReason = `산출물 확인 실패: ${acc.checks.filter((c) => !c.ok).map((c) => `${c.name}(${c.detail})`).join(', ')}`;
          extra = `${feedback}\n${lastReason}`.trim();
        } else if (res === 'continue_session') resumeSession = interrupted.sessionId;
      }
      attemptNo++;
      const prompt = this.authorPrompt(plan, agent, node, upstream, scope, extra, visit);
      const a = await this.runClaude(runId, node, visit, attemptNo, 'author', agent, plan, prompt, scope, null, resumeSession);
      if (a.status === 'succeeded') { author = a; break; }
      lastReason = a.error || 'Claude 작업이 완료 조건을 충족하지 못했습니다.';
      const missing = (a.acceptance?.checks ?? []).some((c) => !c.ok && /필수 산출물이 없습니다/.test(c.detail));
      const resumeTimeout = a.status === 'timeout' && !!a.sessionId && !timeoutResumed;
      if (resumeTimeout) { carry = a.sessionId; timeoutResumed = true; }
      extra = `${feedback}\n이전 시도 실패 원인: ${lastReason}${resumeTimeout ? '\n시간 제한에 걸려 끊겼습니다. 끊기기 전까지 바꾼 파일은 작업 폴더(같은 복사본)에 그대로 있으니 처음부터 다시 하지 말고, 남은 일만 이어서 끝내세요. 오래 걸리는 명령(서버 실행·전체 빌드)은 피하세요.' : ''}${missing ? `\n필수 산출물이 없어 실패했습니다. 막힌 부분이 있어도 산출물을 먼저 만드세요.\n${MISSING_OUTPUT_RULE}` : ''}`.trim();
    }
    if (!author) {
      if (timeoutResumed) cleanupIsolated(isolatedDir(`${runId}:${node.id}`)); // 이어 가기까지 실패했으면 남겨 둔 복사본을 정리(원본은 그대로)
      return { status: 'fail' as const, summary: '', outputs: [], reason: lastReason, feedbackText: lastReason };
    }
    // 다음 단계(Codex 리뷰·재검토·검사)가 볼 대상: 계획된 산출물 + 이번 단계에서 실제로 바뀐 파일(보고 파일만이 아니라 바뀐 코드까지)
    const changed = [...new Set(this.s.runAttempts(runId).filter((x) => x.nodeId === node.id && x.role === 'author').flatMap((x) => x.changedFiles))].slice(0, 80);
    const reviewTargets = [...new Set([...node.outputs.map((o) => o.path), ...changed])];

    // 노드 단위 독립 검토(작성자와 다른 담당, 읽기 전용)
    // 노드 지정이 없으면 직원의 기본 독립 검토 담당. 다음 단계에서 Codex 리뷰·Claude 재검토를 하는 흐름(운영 루프)은 노드 안 검토를 건너뛴다.
    const reviewerId = node.skipInlineReview ? null : (node.reviewerAgentId ?? agent.reviewerAgentId);
    if (reviewerId) {
      const reviewer = this.agentOf(runId, reviewerId);
      if (!reviewer) return { status: 'fail' as const, summary: author.summary, outputs: [], reason: '검토 담당을 찾을 수 없습니다.' };
      const v = await this.runReviewer(runId, node, visit, plan, reviewer, reviewTargets, node.doneCriteria || agent.doneCriteria);
      if (v.verdict !== 'approve') return { status: 'fail' as const, summary: author.summary, outputs: [], reason: `독립 검토 수정 요청: ${v.summary}`, feedbackText: `독립 검토(${reviewer.name}) 지적:\n- ${v.issues.join('\n- ')}`, target: node.id };
    }
    return { status: 'ok' as const, summary: author.summary, outputs: reviewTargets };
  }

  private authorPrompt(plan: PlanFields, agent: Agent, node: GraphNode, upstream: string[], scope: string[], feedback: string, visit: number): string {
    const L: string[] = [];
    L.push(`# CREWGENAI 업무 지시 — ${node.label}`, '');
    L.push('## 프로젝트', `- 이름: ${plan.name}`, `- 목표: ${plan.goal}`, `- 작업 범위: ${plan.scope}`, `- 프로젝트 완료 조건: ${plan.doneCriteria}`, '');
    L.push('## 담당', `- ${agent.code} ${agent.name} (${agent.role})`, '');
    L.push('## 작업 지시', node.instructions || agent.instructions, '');
    const inputs = [...node.inputs, ...(node.useUpstreamOutputs ? upstream : [])];
    L.push('## 입력 자료', ...(inputs.length ? inputs.map((i) => `- ${i}`) : ['- (없음)']), '');
    L.push('## 산출물', ...node.outputs.map((o) => `- ${o.path} (${o.format})${o.required ? ' — 필수' : ''}`), '');
    if (node.outputs.some((o) => o.required)) L.push('## 일부를 못 해도 산출물은 만든다', MISSING_OUTPUT_RULE, '');
    L.push('## 완료 조건', node.doneCriteria || agent.doneCriteria, '');
    L.push('## 수정 가능 경로', ...scope.map((s) => `- ${s || '(프로젝트 전체)'}`), '이 밖의 파일은 권한이 없어 수정이 거부된다. 검사 코드나 시험을 약화시켜 통과시키지 않는다.', '');
    if (feedback.trim()) L.push('## 재작업 요청', `(방문 ${visit}회차)`, feedback.trim(), '');
    L.push('## 마지막 응답 형식', '수행 요약 / 변경 파일 / 실행한 검증과 결과 / 남은 문제를 짧게 쓴다. 사용자 결정이 필요한 항목은 줄마다 "결정 필요: ..."로 쓴다. 실행하지 않은 검증을 통과로 쓰지 않는다.');
    return L.join('\n');
  }

  private async runReviewer(runId: string, node: GraphNode, visit: number, plan: PlanFields, reviewer: Agent, targets: string[], criteria: string) {
    const prior = this.s.findAttempts(runId, node.id, visit, 'reviewer');
    const done = prior.filter((a) => a.status === 'succeeded').pop();
    let a: Attempt;
    if (done) a = done;
    else {
      const prompt = [
        `# 독립 교차검토 — ${node.label}`, '', '작성자와 독립적으로, 읽기 전용으로 확인한다. 파일을 수정하지 않는다.', '',
        ...(node.kind === 'review' && node.instructions.trim() ? ['## 검토 지시', node.instructions.trim(), ''] : []),
        '## 검토 대상', ...targets.map((t) => `- ${t}`), '', '## 완료 조건', criteria || plan.doneCriteria, '',
        '## 프로젝트 목표', plan.goal, '', '## 판정 기준', REVIEW_BAR, '',
        '## 출력', 'verdict(approve|changes_requested), summary, issues(막는 결함), followUps(다음 작업으로 미룰 경미한 지적)를 구조화 출력으로 반환한다. 근거 없이 승인하지 않는다.',
      ].join('\n');
      a = await this.runClaude(runId, node, visit, prior.length + 1, 'reviewer', reviewer, plan, prompt, [], VERDICT_SCHEMA, null);
    }
    const v = this.verdictOf(a);
    const rec: ReviewRecord = { id: uid(), runId, nodeId: node.id, kind: 'agent', reviewerAgentId: reviewer.id, verdict: v.verdict, comments: [v.summary, ...v.issues.map((i) => `- ${i}`), ...v.followUps.map((i) => `- [후속] ${i}`)].join('\n'), targetNodeId: null, subjectHash: sha256(targets.map((t) => fileSha(join(plan.folder, t))).join('|')), graphVersionId: this.s.getRun(runId).graphVersionId, stale: false, createdAt: now() };
    if (!done) this.s.addReview(rec);
    return v;
  }

  private verdictOf(a: Attempt): { verdict: 'approve' | 'changes_requested'; summary: string; issues: string[]; followUps: string[] } {
    if (a.status !== 'succeeded') return { verdict: 'changes_requested', summary: `검토 실행 실패: ${a.error}`, issues: [a.error || '검토가 끝나지 않았습니다.'], followUps: [] };
    const raw = this.meta(a.runId, `structured:${a.id}`);
    let v: { verdict?: string; summary?: string; issues?: string[]; followUps?: string[] } | null = null;
    try { v = raw ? JSON.parse(raw) : null; } catch { v = null; }
    if (!v) { const m = a.summary.match(/\{[\s\S]*"verdict"[\s\S]*\}/); try { v = m ? JSON.parse(m[0]) : null; } catch { v = null; } }
    if (!v || (v.verdict !== 'approve' && v.verdict !== 'changes_requested')) return { verdict: 'changes_requested', summary: '검토 결과 형식을 확인할 수 없어 승인으로 처리하지 않았습니다.', issues: ['구조화된 검토 결과 없음'], followUps: [] };
    const issues = Array.isArray(v.issues) ? v.issues.map(String) : [];
    const followUps = Array.isArray(v.followUps) ? v.followUps.map(String) : [];
    // 막는 결함 없이 수정 요청만 낸 경우(경미한 지적뿐)는 재작업하지 않고 후속으로 넘긴다
    if (v.verdict === 'changes_requested' && !issues.length && followUps.length) return { verdict: 'approve', summary: String(v.summary ?? ''), issues: [], followUps };
    return { verdict: v.verdict, summary: String(v.summary ?? ''), issues, followUps };
  }

  /**
   * 미션이 만든 리뷰 단계(lightSkip)는 앞 작업이 문서·화면 사진만 바꿨으면 건너뛴다(코드·시험·설정을 하나라도 바꿨으면 리뷰한다).
   * 문서·증빙을 고칠 때마다 Codex 리뷰와 재검토가 붙어 지적이 다음 사이클의 일이 되는 것을 막는다.
   */
  private lightSkip(runId: string, graph: WorkGraph, node: GraphNode, upstream: string[]) {
    if (!node.lightSkip) return null;
    const rev = new Map<string, string[]>();
    for (const e of graph.edges) rev.set(e.target, [...(rev.get(e.target) ?? []), e.source]); // 실패 연결로 들어오는 길도 본다
    // 이 단계로 들어오는 모든 길을 거슬러 올라가 작성 단계를 모은다(검사·분기·취합은 지나가고, 작성 단계를 만나도 더 올라간다).
    // 이미 작성 단계를 만난 길에서 다른 리뷰 단계에 닿으면 멈춘다: 그 앞의 작성은 그 리뷰가 맡았다.
    const authors = new Set<string>(); const seen = new Set<string>(); const st: { id: string; found: boolean }[] = (rev.get(node.id) ?? []).map((id) => ({ id, found: false }));
    while (st.length) {
      const x = st.pop()!; const key = `${x.id}:${x.found ? 1 : 0}`;
      if (x.id === node.id || seen.has(key)) continue; seen.add(key);
      const n = graph.nodes.find((g) => g.id === x.id);
      const isReview = n?.kind === 'review' || n?.kind === 'codexReview';
      if (isReview && x.found) continue;
      if (n?.kind === 'agent') authors.add(x.id);
      for (const p of rev.get(x.id) ?? []) st.push({ id: p, found: x.found || n?.kind === 'agent' });
    }
    if (!authors.size) return null;
    const atts = this.s.runAttempts(runId).filter((a) => a.role === 'author');
    // 작성 단계마다 따로 본다: 하나라도 바뀐 파일을 알 수 없거나(기록 없음) 문서 밖을 바꿨으면 리뷰한다
    const per = [...authors].map((id) => atts.filter((a) => a.nodeId === id).flatMap((a) => a.changedFiles));
    if (!per.every((files) => docsOnly(files))) return null;
    const changed = per.flat();
    return { status: 'ok' as const, summary: `건너뜀: 문서·화면 사진만 바뀜(${new Set(changed).size}개) — 코드·시험 변경이 없어 리뷰하지 않음`, outputs: upstream };
  }

  /** Codex 리뷰: 읽기 전용 샌드박스·구조화 출력. 결과 보고서를 산출물 위치에 남겨 다음 Claude 재검토의 입력으로 넘긴다. */
  private async runCodexNode(runId: string, node: GraphNode, visit: number, plan: PlanFields, upstream: string[]) {
    const ctl = this.active.get(runId);
    if (!ctl) throw new Cancelled();
    const prev = this.s.findAttempts(runId, node.id, visit, 'codex');
    const finished = prev.find((a) => a.status === 'succeeded');
    const targets = [...new Set([...node.inputs, ...upstream.filter((u) => !isAbsolute(u))])];
    const safe = node.label.replace(/[^0-9A-Za-z가-힣_-]+/g, '-').slice(0, 40) || 'codex';
    const reportRel = normRel(join(plan.outputDir || 'crewgenai-output', 'reviews', `codex-${safe}-${runId.slice(0, 8)}-v${visit}.md`));
    if (finished && existsSync(join(plan.folder, reportRel))) return { status: 'ok' as const, summary: finished.summary, outputs: [reportRel, ...targets] };
    const run = this.s.getRun(runId);
    const cx = this.o.codex?.() ?? { path: null, model: 'gpt-6.1-sol', effort: 'high' };
    const mock = run.executor === 'mock';
    const exe = mock ? process.execPath : cx.path;
    if (!exe || (mock && !this.o.mockCodexScript)) return { status: 'fail' as const, summary: '', outputs: [], reason: 'Codex CLI를 찾지 못해 Codex 리뷰를 실행하지 못했습니다(설정 확인 필요).' };
    const tmp = join(tmpdir(), 'crewgenai-codex', sha256(`${runId}:${node.id}:${visit}:${prev.length}`).slice(0, 16));
    mkdirSync(tmp, { recursive: true });
    const schemaFile = join(tmp, 'schema.json'); const outFile = join(tmp, 'out.json');
    writeFileSync(schemaFile, JSON.stringify(CODEX_REVIEW_SCHEMA));
    const prompt = [
      `# Codex 코드·산출물 리뷰 — ${node.label}`, '', '읽기 전용으로 검토한다. 파일을 수정하지 않는다. 실제 결함(정확성·보안·요구 위반·근거 불일치)만 보고하고 문체 지적은 하지 않는다.', '',
      '## 검토 대상', ...targets.map((t) => `- ${t}`), '',
      '## 검토 기준', node.doneCriteria || node.instructions || plan.doneCriteria, '',
      '## 프로젝트 목표', plan.goal, '',
      '## 출력', 'verdict(approve|changes_requested), summary, findings[{severity,file,issue,fix}]를 한국어로 반환한다.',
    ].join('\n');
    const args = codexArgs(cx.model, cx.effort, schemaFile, outFile);
    const argv = mock ? [this.o.mockCodexScript!, ...args] : args;
    const attempt: Attempt = {
      id: uid(), runId, nodeId: node.id, visit, attemptNo: prev.length + 1, agentId: null, agentVersion: null, role: 'codex', status: 'running', pid: null, procStart: null,
      sessionId: null, resumedFrom: null, promptHash: sha256(prompt), argvRedacted: redactArgs(args), exitCode: null, resultSubtype: null, isError: null, costUsd: null, usage: null,
      permissionDenials: [], acceptance: null, changedFiles: [], outOfScopeChanges: [], summary: '', error: '', startedAt: now(), finishedAt: null,
    };
    try { this.s.insertAttempt(attempt); } catch { throw new Error(`중복 Codex 리뷰 차단: ${node.label}`); }
    const release = await this.acquire(runId, node.id, plan.folder, null);
    this.setNode(runId, node.id, { status: 'checking', nextAction: `Codex(${cx.model}) 리뷰 중` });
    let seq = 0;
    const ev = (kind: AttemptEvent['kind'], summary: string) => { if (this.closed) return; const e = { attemptId: attempt.id, seq: ++seq, at: now(), kind, summary: redact(summary).slice(0, 300), raw: redact(summary) }; this.s.addEvent(e); this.o.emit({ type: 'event', event: e }); };
    try {
      let errText = '';
      ev('init', `Codex 리뷰 시작 · 모델 ${cx.model} · 강도 ${cx.effort} · 읽기 전용`);
      if (ctl.abort.signal.aborted) throw new Cancelled(); // 한도·취소로 멈춘 실행에서 새 프로세스를 띄우지 않는다
      const h = startProcess(exe, argv, { cwd: plan.folder, env: mock ? cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }) : codexEnv(exe), stdin: prompt, timeoutSec: node.timeoutSec || 1800,
        onStdoutLine: (l) => { if (l.trim()) ev('system', l); }, onStderrLine: (l) => { errText = `${errText}${l}\n`.slice(-20000); if (l.trim() && !/^\s*$/.test(l)) ev('stderr', l); } });
      ctl.procs.set(attempt.id, h);
      attempt.pid = h.pid; attempt.procStart = await processStart(h.pid); this.saveAttempt(attempt);
      const done = await h.done; ctl.procs.delete(attempt.id);
      if (this.closed) throw new Cancelled();
      attempt.exitCode = done.code;
      let res: { verdict: string; summary: string; findings: { severity: string; file: string; issue: string; fix: string }[] } | null = null;
      try { res = JSON.parse(readFileSync(outFile, 'utf8')); } catch { res = null; }
      if (done.cancelled || ctl.abort.signal.aborted) { attempt.status = 'cancelled'; attempt.error = '취소'; }
      else if (done.timedOut) { attempt.status = 'timeout'; attempt.error = '시간 제한 초과'; }
      else if (done.code !== 0 || !res || !['approve', 'changes_requested'].includes(res.verdict)) { attempt.status = 'failed'; attempt.error = `Codex 실행 실패(종료 코드 ${done.code ?? '없음'}${res ? '' : ', 구조화 결과 없음'})`; }
      else attempt.status = 'succeeded';
      const lim = attempt.status === 'failed' ? codexLimit(errText, done.code) : null;
      if (lim) { attempt.status = 'interrupted'; attempt.error = `Codex 사용 한도 도달: ${redact(lim.text)}`; }
      attempt.finishedAt = now();
      if (attempt.status !== 'succeeded' || !res) {
        this.saveAttempt(attempt);
        if (attempt.status === 'cancelled') throw new Cancelled();
        if (lim) this.hitLimit(runId, node, lim);
        return { status: 'fail' as const, summary: '', outputs: [], reason: attempt.error };
      }
      const safeRes = redactDeep(res);
      const md = [`# Codex 리뷰 — ${node.label} (방문 ${visit})`, '', `- 모델: ${cx.model} · 강도: ${cx.effort} · 읽기 전용`, `- 판정: ${safeRes.verdict}`, `- 요약: ${safeRes.summary}`, '',
        '| 심각도 | 파일 | 지적 | 제안 |', '| --- | --- | --- | --- |',
        ...safeRes.findings.map((f) => `| ${f.severity} | ${f.file.replace(/\|/g, '/')} | ${f.issue.replace(/\|/g, '/').replace(/\n/g, ' ')} | ${f.fix.replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
        ...(safeRes.findings.length ? [] : ['| - | - | 지적 없음 | - |'])].join('\n');
      const abs = join(plan.folder, reportRel);
      mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, md);
      this.noteSystemWrite(runId, node.id, abs);
      attempt.summary = `${safeRes.verdict === 'approve' ? '승인' : '수정 요청'}: ${safeRes.summary} (지적 ${safeRes.findings.length}건)`;
      this.atomic(() => {
        this.saveAttempt(attempt);
        this.s.addArtifact({ id: uid(), runId, nodeId: node.id, attemptId: attempt.id, path: abs, relPath: reportRel, kind: 'report', sha256: fileSha(abs), size: statSync(abs).size, createdAt: now() });
        this.s.addReview({ id: uid(), runId, nodeId: node.id, kind: 'codex', reviewerAgentId: null, verdict: safeRes.verdict === 'approve' ? 'approve' : 'changes_requested', comments: [safeRes.summary, ...safeRes.findings.map((f) => `- [${f.severity}] ${f.file}: ${f.issue}`)].join('\n'), targetNodeId: null, subjectHash: sha256(targets.map((t) => fileSha(join(plan.folder, t))).join('|')), graphVersionId: run.graphVersionId, stale: false, createdAt: now() });
      });
      await this.commitFor(runId, node, plan, [reportRel], { name: 'CREWGENAI Codex 리뷰', email: 'codex@crewgenai.local' }, 'Codex 리뷰', attempt);
      this.saveAttempt(attempt);
      // Codex 결과는 판정이 아니라 다음 Claude 재검토의 입력이다(항상 다음 단계로 진행).
      return { status: 'ok' as const, summary: attempt.summary, outputs: [reportRel, ...targets] };
    } finally { release(); }
  }

  private async runReviewNode(runId: string, node: GraphNode, visit: number, plan: PlanFields, upstream: string[], predNodes: GraphNode[], graph: WorkGraph) {
    const reviewer = this.agentOf(runId, node.agentId);
    if (!reviewer) return { status: 'fail' as const, summary: '', outputs: [], reason: '검토 담당을 찾을 수 없습니다.' };
    const authors = predNodes.map((p) => p.agentId);
    if (authors.includes(reviewer.id)) return { status: 'fail' as const, summary: '', outputs: [], reason: '검토자가 작성자와 같아 독립 검토가 아닙니다.' };
    const targets = [...new Set([...node.inputs, ...upstream.filter((u) => !isAbsolute(u))])];
    const criteria = node.doneCriteria || predNodes.map((p) => p.doneCriteria).filter(Boolean).join(' / ');
    const v = await this.runReviewer(runId, node, visit, plan, reviewer, targets, criteria);
    if (v.verdict === 'approve') return { status: 'ok' as const, summary: `승인: ${v.summary}`, outputs: upstream };
    return { status: 'fail' as const, summary: v.summary, outputs: [], reason: `검토 수정 요청: ${v.summary}`, feedbackText: `독립 검토(${reviewer.name}) 지적:\n- ${v.issues.join('\n- ')}`, target: this.reworkTarget(graph, node, `${v.summary}\n${v.issues.join('\n')}`) };
  }

  /**
   * 수정 요청을 받을 담당: 지적 내용에 산출물 경로(또는 파일 이름)가 나온 선행 Agent 단계.
   * 찾지 못하면 null(기본 실패 연결을 따른다). 여러 담당의 결과를 함께 검토할 때 엉뚱한 담당이 재작업하는 것을 막는다.
   */
  private reworkTarget(graph: WorkGraph, node: GraphNode, text: string): string | null {
    const rev = new Map<string, string[]>();
    for (const e of graph.edges) if (['next', 'true', 'false'].includes(e.kind)) rev.set(e.target, [...(rev.get(e.target) ?? []), e.source]);
    const seen = new Set<string>(); const st = [...(rev.get(node.id) ?? [])];
    while (st.length) { const x = st.pop()!; if (seen.has(x)) continue; seen.add(x); st.push(...(rev.get(x) ?? [])); }
    const authors = graph.nodes.filter((n) => seen.has(n.id) && n.kind === 'agent');
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hits = (needle: string) => (text.match(new RegExp(`(^|[^\\w./-])${esc(needle)}(?![\\w.-])`, 'g')) ?? []).length; // 경계가 있는 일치만
    const full = authors.map((n) => ({ n, s: n.outputs.reduce((s, o) => s + hits(normRel(o.path)), 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (full.length && (full.length === 1 || full[0].s > full[1].s)) return full[0].n.id;
    if (full.length) return null; // 동점이면 단정하지 않는다(기본 실패 연결)
    const base = authors.filter((n) => n.outputs.some((o) => hits(o.path.split('/').pop() ?? '\u0000') > 0));
    return base.length === 1 ? base[0].id : null; // 파일 이름만 일치하면 담당이 하나일 때만
  }

  /** Claude CLI 한 번 실행 = 시도 하나 */
  private async runClaude(runId: string, node: GraphNode, visit: number, attemptNo: number, role: 'author' | 'reviewer', agent: Agent, plan: PlanFields, promptIn: string, scope: string[], schema: object | null, resumeSession: string | null): Promise<Attempt> {
    const ctl = this.active.get(runId);
    if (!ctl) throw new Cancelled();
    let prompt = promptIn;
    const ex = this.o.executor();
    const run = this.s.getRun(runId);
    const auto = this.o.autoAssist?.() ?? false;
    // 검토자는 읽기 도구만. 'Skill'을 켠 직원이면 검토 절차 스킬(코드 리뷰·보안 검토 등)은 쓸 수 있다(쓰기 권한은 생기지 않음)
    const tools: ToolName[] = role === 'reviewer' ? ['Read', 'Grep', 'Glob', ...(agent.tools.includes('Skill') ? ['Skill' as ToolName] : [])] : agent.tools.filter((t) => t !== 'WebFetch');
    // 자동 처리: 파일을 쓰는 작성자는 스킬을 기본으로 쓴다
    if (auto && role === 'author' && (tools.includes('Edit') || tools.includes('Write')) && !tools.includes('Skill')) tools.push('Skill');
    // 참고 자료: 프로젝트 밖 '폴더'만 --add-dir로(읽기) 연다. '파일'은 그 파일만 읽기 전용 사본으로 준다(부모 폴더 전체를 열지 않음).
    // 프로젝트를 포함하는 상위 폴더는 열지 않는다(상위 전체가 Bash 쓰기 영역이 되므로).
    const projReal = realFolder(plan.folder);
    const refRoot = this.o.referenceRoot;
    const snapRefs = refRoot ? node.inputs.filter((p) => isAbsolute(p) && within(p, refRoot) && existsSync(p)) : [];
    const refs = [...new Set([...agent.references, ...plan.referenceDocs, ...plan.priorOutputs, ...snapRefs])].filter((p) => isAbsolute(p) && !within(p, plan.folder) && existsSync(p) && !isAppTempPath(p));
    const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
    const ancestor = (p: string) => { const r = realFolder(p); return projReal === r || projReal.startsWith(r + sep); };
    const readDirs = refs.filter((p) => isDir(p) && !ancestor(p));
    const fileRefs = refs.filter((p) => !isDir(p));
    const blockedDirs = refs.filter((p) => isDir(p) && ancestor(p));
    const refNotes: string[] = [];
    if (fileRefs.length || blockedDirs.length) {
      const refDir = join(tmpdir(), 'crewgenai-refs', sha256(`${runId}:${node.id}:${visit}:${attemptNo}:${role}`).slice(0, 16));
      mkdirSync(refDir, { recursive: true });
      for (const p of fileRefs) { const dst = join(refDir, `${sha256(p).slice(0, 8)}-${basename(p)}`); _copy(p, dst); refNotes.push(`- ${p} → 사본 ${dst}`); }
      for (const p of blockedDirs) refNotes.push(`- ${p} → 프로젝트를 포함하는 상위 폴더라 열지 않음(필요한 파일을 직접 참고 자료로 지정)`);
      if (fileRefs.length) readDirs.push(refDir);
    }
    if (refNotes.length) prompt = `${prompt}\n\n## 참고 자료 사본(읽기 전용)\n${refNotes.join('\n')}`;
    // 스킬: 'Skill' 도구를 켠 직원(작성·검토). 고른 스킬 폴더에서 스킬 파일만 읽기 전용 사본으로 넘긴다.
    const pluginDirs: string[] = [];
    let unpinLater = () => {};
    if (tools.includes('Skill')) {
      try {
        const sk = this.o.skills?.(plan.folder);
        const bundle = sk ? prepareSkillBundle(sk.dirs, sk.cacheDir) : null;
        if (bundle) { pluginDirs.push(bundle.pluginRoot); readDirs.push(bundle.pluginRoot); prompt = `${prompt}\n\n${skillNote(bundle.skills, role)}`; }
        if (bundle) unpinLater = () => unpinSkillBundle(bundle.pluginRoot);
      } catch (e) { prompt = `${prompt}\n\n(스킬 사본을 만들지 못해 이번 실행은 기본 제공 스킬만 쓸 수 있습니다: ${redact(String((e as Error).message ?? e)).slice(0, 200)})`; }
    }
    const sessionId = resumeSession ? null : randomUUID();
    // Bash를 쓰는 작성자는 격리 복사본에서 실행한다(같은 실행·단계는 같은 경로 → 세션 이어서 작업 가능).
    const isolate = role === 'author' && tools.includes('Bash');
    const workDir = isolate ? isolatedDir(`${runId}:${node.id}`) : plan.folder;
    // 수정 범위의 저장소 + 입력 자료·지시에 이름이 나온 저장소(범위 검사에서 '맡은 저장소'로 본다)
    const tops = scope.length && scope.every((x) => x && x !== '.' && !isAbsolute(x)) ? new Set([...scope.map((x) => x.replace(/^\.[\\/]/, '').split(/[\\/]/)[0]), ...referencedRepos(plan.folder, [...node.inputs, node.instructions])]) : null;
    // 자동 처리의 시험 명령 허용은 macOS판만: Windows판은 Bash 도구를 주지 않는다(시험은 업무 흐름의 검사 단계로 앱이 실행)
    const cmds: ReturnType<typeof repoTestCommands> = [];
    const sockets = this.o.testLocalSockets?.() ?? false;
    if (cmds.length) prompt = `${prompt}\n\n${commandNote(cmds, sockets)}`;
    // Bash 하위 프로그램용 실행별 임시 폴더(macOS 기본 임시 폴더는 격리 환경에서 쓸 수 없다)
    const procTmp = isolate ? `${workDir}.tmp` : null;
    if (procTmp) { rmSync(procTmp, { recursive: true, force: true }); mkdirSync(procTmp, { recursive: true, mode: 0o700 }); }
    const procEnv: Record<string, string> = procTmp ? { TMPDIR: `${procTmp}/`, JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ? `${process.env.JAVA_TOOL_OPTIONS} ` : ''}-Djava.io.tmpdir=${procTmp}` } : {};
    const dropTmp = () => { if (procTmp) rmSync(procTmp, { recursive: true, force: true }); };
    const args = buildClaudeArgs({
      prompt, appendSystemPrompt: `당신은 CREWGENAI 개발팀의 ${agent.code} ${agent.name}(${agent.role})이다. ${agent.instructions}${this.o.learningsFor ? `\n\n${this.o.learningsFor(run.projectId)}` : ''}`.slice(0, 4000),
      cwd: workDir, tools: [...tools], editScopes: role === 'reviewer' ? [] : scope, allowedCommands: role === 'reviewer' ? [] : [...agent.allowedCommands, ...cmds.map((c) => c.prefix)],
      readDirs, sessionId, resumeSessionId: resumeSession, jsonSchema: schema, model: agent.model, effort: agent.effort, maxBudgetUsd: agent.maxBudgetUsd, pluginDirs,
      writeDirs: [...(procTmp ? [procTmp] : []), ...cmds.flatMap((c) => c.writeDirs)], localBinding: sockets && isolate, // 로컬 포트 열기를 허용했으면 격리 실행 작성자는 127.0.0.1에 서버·시험 서버를 띄울 수 있다(외부 네트워크는 계속 막힘)
    });
    const file = run.executor === 'mock' ? process.execPath : ex.cliPath;
    if (!file) { unpinLater(); dropTmp(); throw new Error('Claude CLI 경로가 없습니다.'); }
    const argv = run.executor === 'mock' ? [this.o.mockScript, ...args] : args;
    const attempt: Attempt = {
      id: uid(), runId, nodeId: node.id, visit, attemptNo, agentId: agent.id, agentVersion: agent.version, role, status: 'running', pid: null, procStart: null,
      sessionId: sessionId ?? resumeSession, resumedFrom: resumeSession, promptHash: sha256(prompt), argvRedacted: redactArgs(args), exitCode: null, resultSubtype: null,
      isError: null, costUsd: null, usage: null, permissionDenials: [], acceptance: null, changedFiles: [], outOfScopeChanges: [], summary: '', error: '', startedAt: now(), finishedAt: null,
    };
    try { this.s.insertAttempt(attempt); } catch { unpinLater(); dropTmp(); throw new Error(`중복 시도 차단: ${node.label} 방문 ${visit} 시도 ${attemptNo}`); }
    this.o.emit({ type: 'attempt', attempt });
    // 격리 실행으로 Bash도 실제 프로젝트에 직접 쓰지 못하므로 수정 범위만 잠근다.
    const lockScope = role === 'author' ? scope : null;
    const release = await this.acquire(runId, node.id, plan.folder, lockScope).catch((e) => { unpinLater(); dropTmp(); attempt.status = 'cancelled'; attempt.finishedAt = now(); this.saveAttempt(attempt); throw e; });
    let seq = 0;
    const sink: StreamSink = { sessionId: attempt.sessionId, result: null, limit: null };
    const addEv = (kind: Parameters<typeof this.s.addEvent>[0]['kind'], summary: string, raw: string) => {
      if (this.closed) return;
      const ev = { attemptId: attempt.id, seq: ++seq, at: now(), kind, summary: redact(summary), raw };
      this.s.addEvent(ev); this.o.emit({ type: 'event', event: ev });
    };
    try {
      this.setNode(runId, node.id, { status: role === 'reviewer' ? 'checking' : (this.s.getRunNode(runId, node.id).status === 'rework' ? 'rework' : 'running'), nextAction: role === 'reviewer' ? `${agent.name} 독립 검토 중` : `${agent.name} 작업 중` });
      const startedMs = Date.now();
      // 작업 시작 전 사용자 미커밋 변경(이번 실행의 앞선 시도가 바꾼 파일은 제외) — 이 경로는 자동 커밋하지 않는다
      const gitOn = role === 'author' && (this.o.gitCommits?.() ?? true);
      const prior = new Set(this.s.runAttempts(runId).flatMap((x) => x.changedFiles));
      const userDirty = gitOn ? new Set([...(await workspaceDirtyPaths(plan.folder))].filter((p) => !prior.has(p))) : new Set<string>();
      const inOwn = (f: string) => role === 'author' && scope.some((s) => within(f, s));
      // 여러 저장소 모드: 수정 범위가 속한 저장소만 복사한다(상위 폴더 전체를 복사하지 않음)
      const wsInfo = isolate ? await workspaceRepos(plan.folder) : null;
      const top = wsInfo?.mode === 'multi' && tops ? tops : undefined;
      const iso: IsoState | null = isolate ? prepareIsolated(plan.folder, workDir, inOwn, !!resumeSession, top) : null;
      // npm 시험 명령: Next.js 빌드는 링크한 node_modules를 받지 않으므로 그 저장소만 복제본(APFS 즉시 복제)으로 바꾼다
      if (iso) for (const rel of new Set(cmds.filter((c) => sockets || !c.localSockets).flatMap((c) => c.cloneDirs))) await materializeLink(workDir, rel, join(plan.folder, rel));
      const before = iso ? new Map(iso.before) : snapshot(workDir); // 세션 이어서 작업이면 중단 전 작업까지 포함해 비교
      const timeout = node.timeoutSec || agent.timeoutSec;
      if (ctl.abort.signal.aborted) throw new Cancelled(); // 한도·취소로 멈춘 실행에서 새 프로세스를 띄우지 않는다
      const h = startProcess(file, argv, {
        cwd: workDir, env: isolate ? scrubSecretEnv(cleanEnv(run.executor === 'mock' ? { ELECTRON_RUN_AS_NODE: '1', ...procEnv } : procEnv)) : cleanEnv(run.executor === 'mock' ? { ELECTRON_RUN_AS_NODE: '1', ...procEnv } : procEnv), stdin: prompt, timeoutSec: timeout,
        onStdoutLine: (l) => { const ev = interpretLine(l, sink); if (ev) addEv(ev.kind, ev.summary, ev.raw); },
        onStderrLine: (l) => { if (l.trim()) addEv('stderr', l.slice(0, 300), redact(l)); },
      });
      ctl.procs.set(attempt.id, h); // 취소·종료 대상에 먼저 등록한 뒤 시작 시각을 조회한다
      attempt.pid = h.pid; attempt.procStart = await processStart(h.pid); this.saveAttempt(attempt);
      const done = await h.done;
      ctl.procs.delete(attempt.id);
      if (this.closed) throw new Cancelled();
      const after = snapshot(workDir);
      let changed = diffSnapshots(before, after);
      if (isolate && changed.length) {
        // 격리 실행에서 빌드·시험이 만든 파일 중 git이 무시하는 것(build/, .next/ 등)은 변경으로 보지 않는다(반영·커밋 대상 아님)
        const ign = await ignoredPaths(plan.folder, changed);
        if (ign.size) { changed = changed.filter((f) => !ign.has(f)); addEv('system', `git이 무시하는 빌드·시험 산출물 ${ign.size}개는 반영하지 않았습니다.`, ''); }
      }
      if (snapshotTruncated(after)) addEv('system', `변경 감지 대상 파일이 너무 많아 일부만 비교했습니다(최대 ${SNAPSHOT_LIMIT}개). 연결 폴더를 좁히거나 큰 폴더를 정리하세요.`, '');
      let conflicts: string[] = [];
      // 다른 작업이 실행 중이어도 검사를 면제하지 않는다. 다른 작업의 수정 범위(실제 경로)에 속한 변경만 제외한다.
      const base = realFolder(plan.folder);
      // 지금 실행 중이거나 이 시도 도중에 끝난 다른 쓰기 작업의 범위(실행 구간이 겹친 작업)
      const others = [
        ...this.held.filter((x) => !(x.runId === runId && x.nodeId === node.id)).flatMap((x) => x.scopes),
        ...this.recentWriters.filter((w) => w.endedAt >= startedMs && !(w.runId === runId && w.nodeId === node.id)).flatMap((w) => w.scopes),
      ];
      if (isolate && iso) {
        // 격리 실행: 범위 밖 변경은 실제 프로젝트에 반영하지 않는다(차단). 범위 안 변경은 전부 반영하거나, 충돌·위험 경로가 있으면 하나도 반영하지 않는다.
        const outside = changed.filter((f) => !inOwn(f));
        // 사용자 취소는 반영하지 않는다. 작성 작업이 시간 제한에 걸린 경우는 그때까지 한 일(범위 검사를 통과한 것)을 반영하고 다음 시도가 같은 세션으로 이어 간다
        const keepCopy = done.timedOut && !done.cancelled && role === 'author'; // 시간 초과: 반영하지 않고 복사본을 남겨 다음 시도가 이어 감
        const discard = done.cancelled || done.timedOut || outside.length > 0;
        const res = discard ? { applied: [], conflicts: [], blocked: [], skipped: [], same: [] } : applyIsolated(plan.folder, workDir, changed.filter(inOwn), iso.base);
        if (keepCopy) addEv('system', `시간 제한에 걸렸습니다. 지금까지의 작업(${changed.length}개 파일)은 원본에 반영하지 않고 복사본에 남겨 두었습니다. 다음 시도가 같은 세션·같은 복사본에서 이어 가고, 끝나서 검사를 통과해야 반영합니다.`, '');
        attempt.changedFiles = res.applied; conflicts = [...res.conflicts, ...res.blocked];
        if (res.skipped.length) addEv('system', `복사본에 새로 생긴 링크 ${res.skipped.length}개는 원본에 만들지 않고 나머지만 반영했습니다: ${res.skipped.slice(0, 3).join(', ')}`, '');
        attempt.outOfScopeChanges = outside.map((f) => `${f} (격리 실행에서 차단, 반영 안 함)`);
        if (!keepCopy) cleanupIsolated(workDir);
      } else {
        attempt.changedFiles = changed.filter(inOwn);
        const outside = changed.filter((f) => !inOwn(f) && !others.some((o) => join(base, f) === o || join(base, f).startsWith(o + sep)));
        // 여러 저장소 연결: 직접 실행 직원은 수정 범위 안만 고칠 수 있다(CLI 권한). 맡은 저장소가 아닌 곳의 변경은
        // 같은 시간에 사용자·다른 프로그램이 바꾼 것이므로 실패로 치지 않고 기록만 남긴다.
        const repos = tops && !tools.includes('Bash') ? new Set(repoDirs(plan.folder).map((r) => r.rel).filter(Boolean)) : null;
        const foreign = repos && tops ? outside.filter((f) => { const t = f.split(/[\\/]/)[0]; return repos.has(t) && !tops.has(t); }) : [];
        if (foreign.length) addEv('system', `맡은 저장소 밖에서 다른 프로그램이 바꾼 파일 ${foreign.length}개는 범위 검사에서 제외했습니다: ${foreign.slice(0, 5).join(', ')}`, '');
        // 검토 담당(읽기 전용 도구만)은 파일을 바꿀 수 없다: 검토 중에 생긴 변경은 다른 프로그램이 한 것이므로 실패로 치지 않고 기록만 남긴다
        const readOnly = !tools.some((t) => t === 'Edit' || t === 'Write' || t === 'Bash');
        if (readOnly && outside.length) addEv('system', `검토 중에 다른 프로그램이 바꾼 파일 ${outside.length}개는 범위 검사에서 제외했습니다(검토 담당은 파일을 바꿀 수 없음): ${outside.slice(0, 5).join(', ')}`, '');
        attempt.outOfScopeChanges = readOnly ? [] : outside.filter((f) => !foreign.includes(f));
      }
      attempt.exitCode = done.code; attempt.sessionId = sink.result?.sessionId ?? sink.sessionId ?? attempt.sessionId;
      const r = sink.result;
      if (r) {
        attempt.resultSubtype = r.subtype; attempt.isError = r.isError; attempt.costUsd = r.costUsd; attempt.usage = r.usage; attempt.permissionDenials = r.permissionDenials.map(redact);
        attempt.summary = redact(r.text).slice(0, 8000);
        if (r.structured) this.setMeta(runId, `structured:${attempt.id}`, JSON.stringify(redactDeep(r.structured)));
      }
      attempt.acceptance = this.acceptance(plan, role === 'author' ? node : { ...node, outputs: [] }, attempt, done.code, r, done.timedOut || done.cancelled, attempt.outOfScopeChanges);
      if (conflicts.length) { attempt.acceptance.checks.push({ name: '격리 실행 반영', ok: false, detail: `실행 중 원본이 바뀌어 반영하지 않은 파일: ${conflicts.join(', ')}` }); attempt.acceptance.ok = false; }
      if (done.cancelled || ctl.abort.signal.aborted) { attempt.status = 'cancelled'; attempt.error = '취소로 프로세스를 종료했습니다.'; }
      else if (done.timedOut) { attempt.status = 'timeout'; attempt.error = `시간 제한(${timeout}초)을 넘어 프로세스를 종료했습니다.`; }
      else if (attempt.acceptance.ok) attempt.status = 'succeeded';
      else { attempt.status = 'failed'; attempt.error = attempt.acceptance.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' / '); }
      // 사용 한도로 끝났으면 실패가 아니라 '중단'으로 남긴다 — 해제 후 같은 세션을 이어서 작업한다(재시도로 한도를 더 소모하지 않음)
      const lim = attempt.status === 'failed' ? claudeLimit(sink, done.code) : null;
      if (lim) { attempt.status = 'interrupted'; attempt.error = `사용 한도 도달: ${redact(lim.text)}`; }
      attempt.finishedAt = now();
      this.atomic(() => { if (attempt.status === 'succeeded' && role === 'author') this.registerArtifacts(runId, node, attempt, plan); this.saveAttempt(attempt); });
      if (attempt.status === 'succeeded' && role === 'author') { await this.commitFor(runId, node, plan, attempt.changedFiles, agentIdentity(agent.code, agent.name), `${agent.code} ${agent.name}`, attempt, userDirty); this.saveAttempt(attempt); }
      this.o.tracer?.attemptFinished(run, attempt, node.label);
      if (attempt.status === 'cancelled') throw new Cancelled();
      if (lim) this.hitLimit(runId, node, lim);
      return attempt;
    } finally { release(); unpinLater(); dropTmp(); }
  }

  /** 중단된 격리 실행의 남은 작업을 '산출물만 확인' 선택 시 반영한다(범위 밖 변경이 있으면 반영하지 않음). */
  private applyLeftoverIsolation(runId: string, node: GraphNode, plan: PlanFields, scope: string[], _agent: Agent): AcceptanceResult['checks'][number] | null {
    // 격리 실행 여부는 직원 설정이 아니라 실제로 남은 격리 복사본·상태 파일로 판단한다(범위 설정으로 Bash를 받은 직원 포함)
    const dir = isolatedDir(`${runId}:${node.id}`);
    if (!existsSync(dir) || !existsSync(`${dir}.state.json`)) return null;
    const inOwn = (f: string) => scope.some((s) => within(f, s));
    const st = prepareIsolated(plan.folder, dir, inOwn, true);
    const changed = diffSnapshots(new Map(st.before), snapshot(dir));
    const outside = changed.filter((f) => !inOwn(f));
    if (outside.length) { cleanupIsolated(dir); return { name: '격리 실행 반영', ok: false, detail: `범위 밖 변경이 있어 반영하지 않음: ${outside.slice(0, 5).join(', ')}` }; }
    const r = applyIsolated(plan.folder, dir, changed, st.base);
    cleanupIsolated(dir);
    return r.conflicts.length || r.blocked.length ? { name: '격리 실행 반영', ok: false, detail: `반영하지 않음: ${[...r.conflicts, ...r.blocked].join(', ')}` } : { name: '격리 실행 반영', ok: true, detail: `중단 전 작업 ${r.applied.length}개 파일 반영` };
  }

  /** verifyOnly는 사용자가 '산출물만 확인'을 고른 중단 시도에만 쓴다. 일반 실행은 항상 종료 코드 0과 is_error=false를 요구한다. */
  private acceptance(plan: PlanFields, node: GraphNode, a: Attempt, code: number | null, r: ResultInfo | null, killed: boolean, outOfScope: string[], verifyOnly = false): AcceptanceResult {
    void a;
    const checks: AcceptanceResult['checks'] = [];
    if (!verifyOnly) {
      checks.push({ name: '프로세스 정상 종료', ok: code === 0 && !killed, detail: killed ? '취소·시간 초과로 종료' : `종료 코드 ${code ?? '없음'}` });
      checks.push({ name: '결과 상태', ok: !!r && r.isError === false && (r.subtype === 'success' || r.subtype === null), detail: r ? `subtype=${r.subtype} is_error=${r.isError}` : '결과 이벤트 없음' });
    } else checks.push({ name: 'CLI 종료 결과(확인 생략)', ok: true, detail: '중단된 시도 — 사용자가 산출물 기준 확인을 선택함. CLI 성공은 확인되지 않음' });
    for (const o of node.outputs) { const c = checkOutput(plan.folder, o); checks.push({ name: `산출물 ${o.path}`, ok: c.ok, detail: c.detail }); }
    checks.push({ name: '수정 범위 준수', ok: outOfScope.length === 0, detail: outOfScope.length ? `범위 밖 변경 ${outOfScope.length}건: ${outOfScope.slice(0, 5).join(', ')}` : '범위 밖 변경 없음' });
    return { ok: checks.every((c) => c.ok), checks };
  }

  private registerArtifacts(runId: string, node: GraphNode, a: Attempt, plan: PlanFields) {
    const known = new Set(this.s.artifacts(runId).filter((x) => x.nodeId === node.id).map((x) => `${x.relPath}:${x.sha256}`));
    const rels = new Set([...node.outputs.map((o) => normRel(o.path)), ...a.changedFiles]);
    for (const rel of rels) {
      const p = join(plan.folder, rel);
      if (!existsSync(p) || statSync(p).isDirectory()) continue;
      const sha = fileSha(p);
      if (known.has(`${rel}:${sha}`)) continue;
      this.s.addArtifact({ id: uid(), runId, nodeId: node.id, attemptId: a.id, path: p, relPath: rel, kind: classify(rel), sha256: sha, size: statSync(p).size, createdAt: now() });
    }
  }

  // ───────── 명령 검사 ─────────
  private async runCheckNode(runId: string, node: GraphNode, visit: number, plan: PlanFields) {
    const ctl = this.active.get(runId)!;
    const prev = this.s.findAttempts(runId, node.id, visit, 'check');
    // 같은 방문에서 이미 끝난 검사는 다시 실행하지 않고 그 결과를 쓴다(복구 시 중복 실행 방지).
    const finished = prev.find((a) => ['succeeded', 'failed', 'timeout'].includes(a.status));
    if (finished) {
      // 검사 기록·산출물 등록 전에 중단된 경우 시도 기록으로 보완한다
      this.atomic(() => {
      if (!this.s.checks(runId).some((c) => c.attemptId === finished.id)) {
        this.s.addCheck({ id: uid(), runId, nodeId: node.id, attemptId: finished.id, name: node.label, argv: node.command, exitCode: finished.exitCode, ok: finished.status === 'succeeded', output: `${finished.summary}\n(중단 후 시도 기록으로 복원)`, durationMs: 0, createdAt: now() });
      }
      const have = new Set(this.s.artifacts(runId).filter((x) => x.attemptId === finished.id).map((x) => x.relPath));
      for (const o of node.outputs) { const p = join(plan.folder, o.path); if (!have.has(normRel(o.path)) && existsSync(p) && statSync(p).isFile()) this.s.addArtifact({ id: uid(), runId, nodeId: node.id, attemptId: finished.id, path: p, relPath: normRel(o.path), kind: 'report', sha256: fileSha(p), size: statSync(p).size, createdAt: now() }); }
      });
      if (finished.status === 'succeeded') return { status: 'ok' as const, summary: `검사 통과(기록 재사용): ${node.command.join(' ')}`, outputs: node.outputs.map((o) => o.path) };
      return { status: 'fail' as const, summary: '', outputs: [], reason: `검사 실패(${finished.error})`, feedbackText: `검사 "${node.label}" 실패 — 명령: ${node.command.join(' ')} · ${finished.error}\n출력 끝부분:\n${finished.summary}` };
    }
    const attemptNo = prev.length + 1;
    const attempt: Attempt = {
      id: uid(), runId, nodeId: node.id, visit, attemptNo, agentId: null, agentVersion: null, role: 'check', status: 'running', pid: null, procStart: null, sessionId: null, resumedFrom: null,
      promptHash: sha256(node.command.join('\u0000')), argvRedacted: node.command.map(redact), exitCode: null, resultSubtype: null, isError: null, costUsd: null, usage: null,
      permissionDenials: [], acceptance: null, changedFiles: [], outOfScopeChanges: [], summary: '', error: '', startedAt: now(), finishedAt: null,
    };
    try { this.s.insertAttempt(attempt); } catch { throw new Error(`중복 검사 차단: ${node.label}`); }
    const release = await this.acquire(runId, node.id, plan.folder, null);
    // 실행 자리를 얻은 직후(프로세스 시작 직전)에 검사 코드 해시를 비교한다 — 대기 중 변경도 잡는다
    const pins = JSON.parse(this.meta(runId, 'check_pins') ?? '{}') as Record<string, string>;
    const tampered = Object.entries(pins).filter(([p, h]) => node.command.some((c) => (isAbsolute(c) ? c : join(plan.folder, c)) === p) && fileSha(p) !== h).map(([p]) => p);
    if (tampered.length) {
      release();
      attempt.status = 'failed'; attempt.error = `검사 파일이 실행 중 변경됐습니다: ${tampered.join(', ')}`; attempt.finishedAt = now();
      this.atomic(() => { this.saveAttempt(attempt); this.s.addCheck({ id: uid(), runId, nodeId: node.id, attemptId: attempt.id, name: node.label, argv: node.command, exitCode: null, ok: false, output: attempt.error, durationMs: 0, createdAt: now() }); });
      return { status: 'fail' as const, summary: '', outputs: [], reason: attempt.error, feedbackText: `${attempt.error}. 검사 코드를 바꿔 통과시키지 말고 원래 검사를 통과하도록 고치세요.` };
    }
    this.setNode(runId, node.id, { status: 'checking', nextAction: `검사 실행: ${node.command.join(' ')}` });
    const t0 = Date.now(); let output = '';
    try {
      // Windows: test·grep은 앱에 포함된 내장 검사(Node)로 실행한다(Windows에는 해당 명령이 없음)
      const builtin = BUILTIN_CHECK.has(node.command[0]); // 정확한 이름만(프로젝트의 test.cmd 등은 해당하지 않음)
      const bin0 = node.command[0].split('/').pop() ?? '';
      const h = startProcess(builtin ? process.execPath : node.command[0], builtin ? [join(dirname(this.o.mockScript), 'check-builtin.cjs'), bin0, ...node.command.slice(1)] : node.command.slice(1), {
        cwd: plan.folder, env: checkEnvFilter(cleanEnv(builtin ? { ELECTRON_RUN_AS_NODE: '1' } : {})), stdin: '', timeoutSec: node.timeoutSec, // 키·토큰 환경 변수 제외
        onStdoutLine: (l) => { if (output.length < 200000) output += `${l}\n`; }, onStderrLine: (l) => { if (output.length < 200000) output += `${l}\n`; },
      });
      ctl.procs.set(attempt.id, h);
      attempt.pid = h.pid; attempt.procStart = await processStart(h.pid); this.saveAttempt(attempt);
      const done = await h.done; ctl.procs.delete(attempt.id);
      if (this.closed) throw new Cancelled();
      attempt.exitCode = done.code;
      const outChecks = node.outputs.map((o) => ({ o, c: checkOutput(plan.folder, o) })).filter((x) => !x.c.ok);
      const exitOk = done.code === 0 && !done.timedOut && !done.cancelled;
      const ok = exitOk && outChecks.length === 0; // 검사 노드도 필수 산출물·형식 계약을 지켜야 통과
      attempt.status = done.cancelled ? 'cancelled' : done.timedOut ? 'timeout' : ok ? 'succeeded' : 'failed';
      attempt.summary = redact(output.split('\n').slice(-40).join('\n'));
      attempt.error = ok ? '' : done.timedOut ? `시간 제한(${node.timeoutSec}초) 초과` : !exitOk ? `종료 코드 ${done.code ?? '없음'}` : `산출물 계약 불충족: ${outChecks.map((x) => `${x.o.path}(${x.c.detail})`).join(', ')}`;
      attempt.finishedAt = now();
      this.atomic(() => { // 시도 결과·검사 기록·산출물 등록을 함께 저장
        this.saveAttempt(attempt);
        this.s.addCheck({ id: uid(), runId, nodeId: node.id, attemptId: attempt.id, name: node.label, argv: node.command, exitCode: done.code, ok, output: redact(output), durationMs: Date.now() - t0, createdAt: now() });
        for (const o of node.outputs) { const p = join(plan.folder, o.path); if (existsSync(p) && statSync(p).isFile()) this.s.addArtifact({ id: uid(), runId, nodeId: node.id, attemptId: attempt.id, path: p, relPath: normRel(o.path), kind: 'report', sha256: fileSha(p), size: statSync(p).size, createdAt: now() }); }
      });
      if (attempt.status === 'cancelled') throw new Cancelled();
      if (ok) return { status: 'ok' as const, summary: `검사 통과: ${node.command.join(' ')}`, outputs: node.outputs.map((o) => o.path) };
      return { status: 'fail' as const, summary: '', outputs: [], reason: `검사 실패(${attempt.error})`, feedbackText: `검사 "${node.label}" 실패 — 명령: ${node.command.join(' ')} · ${attempt.error}\n출력 끝부분:\n${attempt.summary}` };
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      attempt.status = 'failed'; attempt.error = (e as Error).message; attempt.finishedAt = now(); this.saveAttempt(attempt);
      return { status: 'fail' as const, summary: '', outputs: [], reason: `검사를 실행하지 못함: ${attempt.error}` };
    } finally { release(); }
  }

  // ───────── 분기·취합·사용자 검토 ─────────
  private evalBranch(node: GraphNode, state: S, plan: PlanFields) {
    const c = node.condition!;
    const rec = state.records[c.sourceNodeId];
    let actual = '';
    if (c.field === 'outcome') actual = rec?.status === 'ok' ? 'succeeded' : rec?.status ?? '';
    else {
      const jsonOut = (rec?.outputs ?? []).find((o) => o.endsWith('.json'));
      try {
        let v: unknown = jsonOut ? JSON.parse(readFileSync(isAbsolute(jsonOut) ? jsonOut : join(plan.folder, jsonOut), 'utf8')) : undefined;
        for (const k of (c.jsonPath ?? '').split('.').filter(Boolean)) v = (v as Record<string, unknown>)?.[k];
        actual = v === undefined ? '' : String(v);
      } catch { actual = ''; }
    }
    const hit = actual === c.equals;
    return { status: hit ? 'true' as const : 'false' as const, summary: `조건 ${c.field === 'json' ? c.jsonPath : '결과'} = "${actual}" → ${hit ? '참' : '거짓'}`, outputs: rec?.outputs ?? [] };
  }

  private runMerge(runId: string, graph: WorkGraph, node: GraphNode, plan: PlanFields) {
    const run = this.s.getRun(runId);
    const snap = this.s.runSnapshot(runId);
    const md = buildReport({ billing: (this.meta(runId, 'billing') ?? 'unknown') as Billing, run, plan, graph, agents: snap.agents, nodes: this.s.runNodes(runId), attempts: this.s.runAttempts(runId), artifacts: this.s.artifacts(runId), checks: this.s.checks(runId), reviews: this.s.reviews(runId) });
    const rel = normRel(join(plan.outputDir || 'crewgenai-output', `RESULT-${runId.slice(0, 8)}.md`));
    const abs = join(plan.folder, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, md);
    this.noteSystemWrite(runId, node.id, abs);
    const sha = fileSha(abs);
    this.s.addArtifact({ id: uid(), runId, nodeId: node.id, attemptId: null, path: abs, relPath: rel, kind: 'report', sha256: sha, size: statSync(abs).size, createdAt: now() });
    const hash = sha256(`${run.graphVersionId}|${sha}|${this.s.artifacts(runId).map((a) => `${a.relPath}:${a.sha256}`).sort().join(',')}`);
    this.s.saveDeliverable({ runId, hash, reportPath: abs, goal: plan.goal, doneCriteria: plan.doneCriteria, markdown: md, createdAt: now() });
    return { status: 'ok' as const, summary: `결과물 ${rel}`, outputs: [rel] };
  }

  /** 검토 대상 해시 = 흐름 버전 + 결과물 해시 + 현재 산출물 파일 내용 해시. 파일이 바뀌면 달라진다. */
  subjectHash(runId: string): string | null {
    const d = this.s.latestDeliverable(runId);
    if (!d) return null;
    const run = this.s.getRun(runId);
    const latest = new Map<string, string>();
    for (const a of this.s.artifacts(runId)) latest.set(a.path, a.path);
    const cur = [...latest.keys()].sort().map((p) => `${p}:${fileSha(p)}`).join(',');
    return sha256(`${run.graphVersionId}|${d.hash}|${cur}`);
  }

  private async runUserReview(runId: string, node: GraphNode, visit: number) {
    void visit;
    const subject = this.subjectHash(runId);
    if (!subject) return { status: 'fail' as const, summary: '', outputs: [], reason: '검토할 결과물이 없습니다. 결과물 취합 단계가 먼저 필요합니다.' };
    this.s.markReviewsStale(runId, node.id, subject); // 대상이 바뀐 이전 결정은 재사용하지 않는다
    const pick = () => this.s.reviews(runId).filter((r) => r.nodeId === node.id && r.kind === 'user' && !r.stale && r.subjectHash === subject && r.verdict !== 'hold').pop();
    let decision = pick();
    if (!decision) {
      this.setNode(runId, node.id, { status: 'review_wait', nextAction: '결과물·검토 화면에서 수정 요청 / 보류 / 검토 완료를 선택하세요.' });
      try { interrupt({ kind: 'userReview', nodeId: node.id, subject }); } catch (e) { if (isGraphInterrupt(e)) throw e; throw e; }
      decision = pick();
      if (!decision) throw new Error('검토 결정과 현재 결과물이 일치하지 않습니다. 결과물을 다시 확인하세요.');
    }
    if (decision.verdict === 'approve') return { status: 'ok' as const, summary: `팀장 검토 완료${decision.comments ? `: ${decision.comments}` : ''}`, outputs: [] };
    return { status: 'fail' as const, summary: '', outputs: [], reason: `팀장 수정 요청: ${decision.comments}`, feedbackText: `팀장 수정 요청: ${decision.comments}`, target: decision.targetNodeId };
  }

  // ───────── 조회 ─────────
  detail(runId: string): RunDetail {
    const run = this.s.getRun(runId);
    return {
      run, graph: this.s.getGraphVersion(run.graphVersionId).graph, nodes: this.s.runNodes(runId), attempts: this.s.runAttempts(runId), artifacts: this.s.artifacts(runId),
      checks: this.s.checks(runId), reviews: this.s.reviews(runId), deliverable: this.s.latestDeliverable(runId), currentSubjectHash: this.subjectHash(runId), billing: (this.meta(runId, 'billing') ?? 'unknown') as Billing,
    };
  }
}

/** 직원 지시에 붙이는 스킬 안내: 작업에 맞는 스킬을 먼저 불러 쓰게 한다(이름 목록은 길면 자른다) */
export function skillNote(names: string[], role: 'author' | 'reviewer'): string {
  const list = [...new Set(names.map((n) => n.split(':').pop() ?? n))].slice(0, 80);
  return ['## 쓸 수 있는 스킬',
    role === 'reviewer'
      ? '- 검토를 시작할 때 이 검토에 맞는 스킬(코드 리뷰·보안 검토·점검 등)이 있으면 Skill 도구로 불러 그 절차대로 검토한다. 검토는 읽기 전용 그대로다.'
      : '- 작업을 시작할 때 이 작업에 맞는 스킬이 있으면 Skill 도구로 불러 그 절차를 따른다(예: 버그는 디버깅, 기능은 시험 주도 개발, 끝내기 전에는 완료 전 검증). 지시에 스킬 이름이 적혀 있으면 그 스킬을 먼저 쓴다.',
    '- 스킬은 수정 범위·허용 명령을 넓히지 않는다. 쓴 스킬 이름을 보고에 적는다.',
    `- 목록(Claude 기본 제공 스킬 외): ${list.join(', ')}`].join('\n');
}
