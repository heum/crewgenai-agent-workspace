// 운영: 오퍼레이터 루프(미션)
// 사용자 지시 → 오퍼레이터 계획(Claude, 구조화 출력) → 사이클 흐름 자동 구성·실행
//   (담당 Agent 수행 → Codex 리뷰 → Claude 재검토 → [검사] → 취합)
// → 오퍼레이터 판단(계속 / 사용자 확인 / 완료) → 사용자가 멈출 때까지 반복
// 오퍼레이터는 작업 완료·검토 필요·추가 정보 필요·사이클 상한 도달 때만 사용자에게 묻는다.
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Agent, GraphEdge, GraphNode, LiveEvent, Mission, MissionDetail, MissionEvent, MissionFile, MissionGap, MissionDecision, MissionResult, MissionChoice, MissionPick, StaffProposal, MissionDenial, MissionBlocker, ProjectDoc, WorkingItem, MissionSnapshot, MissionStage, MissionStatus, PlanFields, RunDetail, WorkGraph } from '../shared/types';
import { buildClaudeArgs, claudeLimit, cleanEnv, interpretLine, type LimitInfo, type StreamSink, isOurProcess, killGroupAndWait, processStart, redact, redactDeep, startProcess, type ProcessHandle, type ResultInfo } from './cli/claudeCli';
import { now, uid, type Store } from './db';
import type { Engine } from './engine/engine';
import { allowedRoots, escapes, normRel, validateGraph } from './engine/validate';
import { autoLayout } from '../shared/layout';
import { checkArgv } from './checks';
import { LEARN_SCHEMA, type LearningStore } from './learning';
import { missionCommitsSince, revertCommits, syncRepoFastForward, tagSnapshot, workspaceHeads, workspaceRepos } from './git';
import { docReposFor, levelAllows, repoTestCommands, workBranchName, type CommandLevel } from './autopilot';

/** 사용자가 고를 선택지: 고르면 무엇이 달라지는지(effect), 추천 여부와 이유. 추천은 안내일 뿐 자동으로 고르지 않는다. */
const CHOICE_ITEMS = { type: 'array', items: { type: 'object', required: ['label', 'effect', 'recommended', 'why'], properties: {
  label: { type: 'string' }, effect: { type: 'string' }, recommended: { type: 'boolean' }, why: { type: 'string' } } } };
const STAFF_ITEMS = { type: 'array', items: { type: 'object', required: ['kind', 'agentCode', 'name', 'role', 'instructions', 'reason'], properties: {
  kind: { type: 'string', enum: ['add', 'update'] }, agentCode: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, instructions: { type: 'string' },
  workPaths: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } } } };
/** 사용자에게 무엇을 묻는가: 사용자만 정할 수 있는 결정만. 자료 정합성 문제는 직원·오퍼레이터가 처리하고 기록한다. */
const ASK_RULE = '- 사용자에게 묻는 것(gaps·question)은 사용자만 정할 수 있는 결정으로 한정한다: 제품이 어떻게 보이고 동작하는지, 범위·우선순위, 병합·배포·비용·외부 공개. 문서 줄 번호·개수·파일 위치·자료끼리의 작은 불일치·검증 기록 정리 같은 자료 정합성 문제는 묻지 않는다. 근거가 더 분명한 쪽(최신 사용자 결정 > 실제 코드 > 최신 문서)을 따르고, 따른 근거를 결과 보고의 기록 칸에 남긴다.';
/** 준비·정리 작업의 끝: 완벽이 아니라 다음 일을 시작할 수 있을 만큼. */
const ENOUGH_RULE = '- 기준 정리·자료 대조·검증 같은 준비 작업은 완벽을 목표로 하지 않는다. 다음 단계(개발·구현)를 시작할 수 있을 만큼 되면 넘어가고, 남은 정리는 개발 중 필요할 때 한다. 같은 자료를 다시 검증하는 사이클을 되풀이하지 않는다.';
/** 사용자에게 수작업을 맡기지 않는다: 직원이 못 하는 일은 보류하고 다음 일로 간다. */
/** 작업마다 사용자가 바로 열어 볼 결과물을 남긴다(계획·판단 공통) */
const RESULT_RULE = [
  '- 작업마다 사용자가 바로 열어 보고 확인할 수 있는 결과물을 남긴다. 작업 성격에 맞게: 화면 작업은 결과 화면 스크린샷(png) 또는 열어 볼 수 있는 html, 기능·서버 작업은 시험 결과 요약 문서와 바뀐 코드 파일, 설계·문서 작업은 그 문서. 계획의 outputs에 이 결과물을 넣는다.',
  '- 결과물이 사용자가 볼 수 없는 준비 작업(대조·검증 기록 정리)만으로 사이클을 채우지 않는다.',
].join('\n');
/** 판단: 작업별 결과물 목록 */
const RESULTS_RULE = '- results: 이번 사이클 작업마다 사용자가 열어 볼 결과물을 넣는다. path는 프로젝트 폴더 기준 상대 경로(실제로 있는 파일만) 또는 이 컴퓨터에서 실행 중인 화면 주소(http://localhost:포트/…, 실제로 띄운 경우만). changed에는 무엇이 달라졌는지 한 문장, check에는 사용자가 열어서 확인할 것(어디를 보고 무엇이 맞으면 되는지) 한 문장을 쓴다. 실패한 작업도 확인할 결과물이 있으면 넣고 changed에 실패를 밝힌다. 진행 보고(summary)에는 결과물 목록을 다시 쓰지 않는다.';
/** 진전 없는 사이클이 이만큼 이어지면 멈추고 묻는다 */
const IDLE_LIMIT = 2;
const NO_MANUAL_RULE = '- 사용자에게 수작업을 맡기지 않는다: 앱에서 직원을 대신 실행하기, 터미널 명령 실행, 결과·원문 붙여넣기, 파일 직접 저장을 요청하거나 질문 선택지로 내지 않는다. 직원 권한·도구로 할 수 없는 일은 막힘(이유)으로 진행 보고에 남기고, 그 일 없이 할 수 있는 다음 개발 작업으로 넘어간다. 같은 막힘 때문에 같은 질문을 되풀이하지 않는다. 예외는 사용자만 할 수 있는 일(본인 계정 로그인, 비밀값 입력, 실제 메일·결제 같은 외부 발송 승인)뿐이며, 이때는 무엇을 왜 하는지 한 줄로 요청한다. 리뷰의 후속 항목([후속])은 다음 작업 목록에 기록만 하고 이번 작업을 다시 하지 않는다.';
/** 판단 summary = 사용자가 보고 판단하는 진행 보고 */
const REPORT_RULE = [
  '- summary는 사용자가 이것만 보고 진행을 판단하는 **진행 보고**다. 마크다운으로 아래 순서를 지킨다(없는 칸은 "없음"):',
  '  1. 한 줄 요약: 이번 사이클에 실제로 된 것.',
  '  2. `| 항목 | 상태 | 확인 방법 |` 표: 이번 사이클에 다룬 기능·작업 항목(문서의 ID가 있으면 ID와 쉬운 이름). 상태는 계획 / 코드 작성 / 시험 통과(직접 실행해 결과를 본 것만) / PR 필요(저장소·브랜치) / 막힘(이유) 중 하나. 확인 방법은 스크린샷·결과 파일 경로·시험 명령과 결과 수.',
  '  3. 진척: 이번 범위 전체 항목 수 대비 PR 필요·시험 통과·작업 중·막힘·시작 전 개수.',
  '  4. 사용자가 할 일: PR 병합(저장소·브랜치·한 줄 요약), 제품 결정(최대 3개, 쉬운 말).',
  '  5. 다음 사이클에 할 것(항목 3~5개).',
  '  6. 기록(접어 두는 칸): 자료 불일치를 어떻게 처리했는지 등 판단에 필요 없는 세부. 짧게.',
  '- 측정하지 않은 것은 상태를 올리지 않는다. 문서만 있는 항목을 코드·시험 통과로 쓰지 않는다.',
].join('\n');

const PLAN_SCHEMA = {
  type: 'object', required: ['summary', 'question', 'gaps', 'tasks'],
  properties: {
    summary: { type: 'string' }, question: { type: 'string' }, questionOptions: { type: 'array', items: { type: 'string' } }, questionChoices: CHOICE_ITEMS, staffProposals: STAFF_ITEMS,
    gaps: { type: 'array', items: { type: 'object', required: ['doc', 'issue', 'need'], properties: { doc: { type: 'string' }, issue: { type: 'string' }, need: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, choices: CHOICE_ITEMS, explain: { type: 'string' },
      refs: { type: 'array', items: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, line: { type: 'integer' } } } } } } },
    tasks: { type: 'array', items: { type: 'object', required: ['title', 'agentCode', 'instructions', 'writeScope', 'outputs', 'doneCriteria', 'checkCommand'],
      properties: { title: { type: 'string' }, agentCode: { type: 'string' }, instructions: { type: 'string' }, writeScope: { type: 'array', items: { type: 'string' } },
        outputs: { type: 'array', items: { type: 'object', required: ['path', 'format'], properties: { path: { type: 'string' }, format: { type: 'string', enum: ['markdown', 'json', 'html', 'text', 'code', 'image', 'any'] } } } },
        doneCriteria: { type: 'string' }, checkCommand: { type: 'array', items: { type: 'string' } },
        needs: { type: 'object', properties: { commands: { type: 'array', items: { type: 'string' } }, readPaths: { type: 'array', items: { type: 'string' } } } } } } },
  },
};
const JUDGE_SCHEMA = {
  type: 'object', required: ['decision', 'summary', 'question', 'nextFocus'],
  properties: { decision: { type: 'string', enum: ['continue', 'ask_user', 'done'] }, summary: { type: 'string' }, question: { type: 'string' }, questionOptions: { type: 'array', items: { type: 'string' } }, questionChoices: CHOICE_ITEMS, staffProposals: STAFF_ITEMS, nextFocus: { type: 'string' },
    results: { type: 'array', items: { type: 'object', required: ['task', 'title', 'path', 'changed', 'check'], properties: { task: { type: 'string' }, title: { type: 'string' }, path: { type: 'string' }, changed: { type: 'string' }, check: { type: 'string' } } } } },
};
interface PlanTask { title: string; agentCode: string; instructions: string; writeScope: string[]; outputs: { path: string; format: GraphNode['outputs'][number]['format'] }[]; doneCriteria: string; checkCommand: string[]; needs?: { commands?: string[]; readPaths?: string[] } }
type RawStaff = { kind?: string; agentCode?: string; name?: string; role?: string; instructions?: string; workPaths?: string[]; reason?: string };
interface Plan { staffProposals?: RawStaff[]; summary: string; question: string; questionOptions?: string[]; questionChoices?: unknown; gaps?: MissionGap[]; tasks: PlanTask[] }
interface RawResult { task?: string; title?: string; path?: string; changed?: string; check?: string }
interface Judge { results?: RawResult[]; staffProposals?: RawStaff[]; decision: 'continue' | 'ask_user' | 'done'; summary: string; question: string; questionOptions?: string[]; questionChoices?: unknown; nextFocus: string }

/** 오퍼레이터가 낸 선택지 정리: 빈 값·중복을 빼고 최대 4개, 각 200자 */
function cleanOptions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) { const t = String(x ?? '').trim().slice(0, 200); if (t && !out.includes(t)) out.push(t); if (out.length >= 4) break; }
  return out;
}
/** 선택지 정리: 최대 4개, 추천은 하나만(처음 것). 선택지 문구가 없으면 버린다. */
export function cleanChoices(v: unknown): MissionChoice[] {
  if (!Array.isArray(v)) return [];
  const out: MissionChoice[] = []; let rec = false;
  for (const x of v as Record<string, unknown>[]) {
    const label = redact(String(x?.label ?? '').trim()).slice(0, 200);
    if (!label || out.some((c) => c.label === label)) continue;
    const recommended = !!x?.recommended && !rec; if (recommended) rec = true;
    out.push({ label, effect: redact(String(x?.effect ?? '').trim()).slice(0, 400), recommended, why: recommended ? redact(String(x?.why ?? '').trim()).slice(0, 300) : '' });
    if (out.length >= 4) break;
  }
  return out;
}
/** 질문 선택지: 설명이 있는 선택지를 우선하고, 없으면 예전 문구 목록 */
function pickChoices(choices: unknown, options: unknown): { opts: string[]; choices: MissionChoice[] } {
  const ch = cleanChoices(choices);
  return ch.length ? { opts: ch.map((c) => c.label), choices: ch } : { opts: cleanOptions(options), choices: [] };
}
const gapKey = (g: { doc: string; issue: string }) => `${g.doc.trim()}|${g.issue.trim()}`;

type Row = Record<string, unknown>;
/** Windows판은 직원이 Bash를 쓰지 않는다(OS 격리 없음): 명령이 필요한 작업은 실행 전에 사용자 확인으로 돌린다 */
const BASH_OK = false;

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
  /** 배운 것 — 지시·답변에서 배운 사실을 저장하고 오퍼레이터 지시에 붙인다 */
  learnings?: LearningStore;
  learnEnabled?: () => boolean;
  autoAssist?: () => boolean; // 자동 처리: 문서 저장소 최신화, 저장소 시험 명령 허용, 작업 브랜치 자동 생성
  commandLevel?: () => CommandLevel; // 명령 허용 범위
}

/** 오퍼레이터 호출이 사용 한도에 걸림 */
class OperatorLimit extends Error { constructor(public lim: LimitInfo) { super('오퍼레이터 호출이 사용 한도에 걸렸습니다.'); this.name = 'OperatorLimit'; } }

/** 거부된 명령에서 허용 명령 접두어 후보를 만든다: 첫 단순 명령의 이름과 그 뒤 옵션(값 포함). 예) 'shasum -a 256 /x/y' → 'shasum -a 256', 'git -C /repo log' → 'git -C' */
export function commandPrefix(command: string): string | null {
  const first = command.split(/;|&&|\|\||\|/)[0].trim();
  const toks = first.split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const out = [toks[0]];
  for (let i = 1; i < toks.length && out.length < 4; i++) {
    const t = toks[i];
    if (!t.startsWith('-')) break;
    out.push(t);
    const v = toks[i + 1];
    if (v && !v.startsWith('-') && /^[\w.=:-]{1,12}$/.test(v) && !/[\/\\]/.test(v) && t.length === 2 && /^-[a-z]$/i.test(t) && /^\d+$|^[a-z]+$/i.test(v) && toks[0] !== 'git') { out.push(v); i++; }
  }
  return out.join(' ');
}

/** 에이전트가 고칠 수 없는 내 PC 환경 문제로 보이는 실패(명령·프로그램 없음, 접근 거부, 네트워크·로그인) */
// 프로세스·도구 수준의 신호만 본다(앱 기능을 설명하는 'authentication' 같은 단어로 잘못 멈추지 않게)
export const ENV_FAILURE = /\b(ENOENT|EACCES|EPERM|ENOTFOUND|ECONNREFUSED|EAI_AGAIN)\b|command not found|is not recognized as an internal or external command|검사를 실행하지 못함|프로세스 시작 실패|실행 파일\(.*\)을 해석하지 못했습니다|Claude CLI가 준비되지 않았습니다|not logged in|로그인되지 않았습니다|network is unreachable/i;
/** 실패 원인을 비교용 문자열로: 숫자·경로·해시를 지워 같은 원인이면 같은 값이 되게 */
export function failureSig(reason: string, step = ''): string {
  const exit = /종료 코드 (-?\d+|없음)/.exec(reason)?.[1] ?? '';
  return `${step.replace(/\d+/g, '').trim()}|${exit}|` + reason.toLowerCase().replace(/[a-z]:\\[^\s]+|\/[^\s]+/gi, '<경로>').replace(/[0-9a-f]{7,}/g, '<값>').replace(/\d+/g, '<수>').replace(/\s+/g, ' ').trim().slice(0, 160);
}

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

  answer(id: string, text: string, action: 'continue' | 'stop', keep?: Partial<Mission> | 'pending'): Mission {
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
    if (action === 'stop') { this.event(m, 'system', '사용자가 미션을 종료했습니다.'); const st = this.set(id, { status: 'stopped', stage: 'stopped', question: null }); void this.learn(id); return st; }
    // 이번 사이클에 실행이 있었으면 다음 사이클로, 계획 단계 질문이었으면 같은 사이클을 다시 계획한다. 상한은 사용자 승인만큼 늘린다.
    const ran = !!this.d.store.db.prepare('SELECT 1 FROM mission_cycles WHERE mission_id=? AND cycle=?').get(id, m.cycle);
    const cycle = ran ? m.cycle + 1 : m.cycle;
    const next = this.set(id, { status: 'planning', stage: 'plan', question: null, questionOptions: null, questionChoices: null, gaps: null, denials: null, blockers: null, parkedSigs: [], idleCycles: 0, cycle, maxCycles: Math.max(m.maxCycles, cycle + this.d.maxCycles() - 1), ...(keep === 'pending' ? { gaps: m.gaps ?? null, denials: m.denials ?? null, blockers: m.blockers ?? null, parkedSigs: m.parkedSigs ?? [] } : keep ?? {}) });
    void this.loop(id);
    return next;
  }

  /** 보류한 업무를 사용자가 해결함(권한 허용·환경 수정 등): 보류를 풀어 다음 계획부터 다시 시도할 수 있게 한다 */
  retryParked(id: string): Mission {
    const m = this.get(id);
    if (!m.denials?.length && !m.blockers?.length && !m.gaps?.length && !m.parkedSigs?.length) return m;
    this.event(m, 'answer', '보류한 업무를 해결했습니다. 다음 계획부터 다시 시도하세요.');
    return this.set(id, { denials: null, blockers: null, gaps: null, parkedSigs: [], denialSigs: [], failSigs: [] });
  }

  /**
   * 확인 필요 항목에 사용자가 고른 결정을 반영한다: 결정은 미션에 쌓여 다음 계획·판단에서 '사용자 결정'으로 그대로 따르고,
   * 결정한 항목은 확인 필요 목록에서 뺀다. resume이면(확인 대기 중일 때) 바로 이어서 진행한다.
   */
  decide(id: string, picks: MissionPick[], resume: boolean): Mission {
    const m = this.get(id);
    if (['planning', 'running', 'evaluating', 'waiting_user', 'done'].indexOf(m.status) < 0) throw new Error('끝난 미션에는 결정을 반영할 수 없습니다. 이어서 다시 시작한 뒤 결정하세요.');
    const gaps = m.gaps ?? [];
    // 항목은 순번이 아니라 문서·내용으로 찾는다: 화면이 새로 고쳐지기 전에 목록이 바뀌어도 다른 항목에 결정이 붙지 않게
    const seen = new Set<number>(); const made: MissionDecision[] = []; const at = new Date().toISOString();
    let stale = false;
    for (const p of Array.isArray(picks) ? picks : []) {
      const choice = String(p?.choice ?? '').trim().slice(0, 600);
      if (!choice) continue;
      const i = gaps.findIndex((g) => gapKey(g) === gapKey({ doc: String(p?.doc ?? ''), issue: String(p?.issue ?? '') }));
      if (i < 0) { stale = true; continue; }
      if (seen.has(i)) continue;
      seen.add(i); made.push({ doc: gaps[i].doc, issue: gaps[i].issue, choice: redact(choice), at });
    }
    if (!made.length) throw new Error(stale ? '확인 필요 목록이 바뀌었습니다. 화면을 새로 고친 뒤 다시 고르세요.' : '결정할 항목을 하나 이상 고르세요.');
    this.event(m, 'answer', `확인 필요 항목 결정:\n${made.map((d) => `- [${d.doc || '문서 미지정'}] ${d.issue} → ${d.choice}`).join('\n')}`, { decisions: made });
    const keys = new Set(made.map(gapKey));
    const decisions = [...(m.decisions ?? []).filter((d) => !keys.has(gapKey(d))), ...made]; // 결정은 지우지 않는다(같은 항목은 새 결정으로 바꿈)
    const rest = gaps.filter((_, i) => !seen.has(i));
    const next = this.set(id, { decisions, gaps: rest.length ? rest : null });
    // 확인 대기 중이면 바로 이어서 계획한다. 고르지 않은(나중에) 항목은 확인 필요로 그대로 남긴다.
    // 결정은 근거 부족 항목만 푼다: 고르지 않은 항목과 보류한 업무(권한·환경)는 그대로 둔다
    if (resume && next.status === 'waiting_user') return this.answer(id, '', 'continue', { gaps: rest.length ? rest : null, denials: m.denials ?? null, blockers: m.blockers ?? null, parkedSigs: m.parkedSigs ?? [] });
    return next;
  }

  /**
   * 실행 전 권한 점검: 작업마다 오퍼레이터가 적은 필요 명령·읽을 경로가 담당 직원에게 허용돼 있는지 본다.
   * 허용되지 않은 작업은 이번 사이클에서 빼고(돌려 봐야 같은 거부로 실패) 확인 필요 항목으로 돌려준다.
   */
  private preflight(plan: PlanFields, agents: Agent[], tasks: PlanTask[]): { keep: PlanTask[]; held: { task: PlanTask; denials: MissionDenial[] }[] } {
    const by = (code: string) => agents.find((a) => a.code === code) ?? agents.find((a) => a.code === '00');
    const folder = resolve(plan.folder);
    const refs = [...plan.referenceDocs, ...plan.priorOutputs].map((r) => resolve(folder, r));
    const inside = (p: string, r: string) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
    const readable = (p: string, ag: Agent) => { const a = resolve(folder, p); return inside(a, folder) || [...refs, ...ag.references.map((r) => resolve(folder, r))].some((r) => inside(a, r)); }; // 직원에게 준 참조 자료도 읽을 수 있다
    const toks = (c: string) => c.trim().split(/\s+/).filter(Boolean);
    const auto = this.d.autoAssist?.() ? repoTestCommands(plan.folder).map((c) => c.prefix) : []; // 자동 처리: 저장소 시험 명령은 실행 때 허용된다
    const level: CommandLevel = BASH_OK ? (this.d.commandLevel?.() ?? 'low') : 'low';
    const hasBash = (a: Agent) => a.tools.includes('Bash') || (level !== 'low' && (a.tools.includes('Edit') || a.tools.includes('Write'))); // 중간·높음이면 쓰기 직원도 Bash를 받는다
    const allowed = (a: Agent, c: string) => BASH_OK && hasBash(a) && levelAllows(level, c, [...a.allowedCommands, ...auto]); // 묶은 명령은 부분마다 범위·직원 허용 명령으로 본다
    const keep: PlanTask[] = []; const held: { task: PlanTask; denials: MissionDenial[] }[] = [];
    for (const t of tasks) {
      const a = by(t.agentCode);
      if (!a) { keep.push(t); continue; }
      const ds: MissionDenial[] = [];
      for (const c of (t.needs?.commands ?? []).map(String).filter((x) => x.trim()).slice(0, 10)) {
        if (allowed(a, c)) continue;
        const suggestion = BASH_OK ? commandPrefix(c) : null;
        ds.push({ agentId: a.id, agent: `${a.code} ${a.name}`, tool: '실행 전 점검 · 명령', kind: BASH_OK ? 'command' : 'other', target: c.slice(0, 300), suggestion, sig: `pre|${a.id}|cmd|${suggestion ?? c}` });
      }
      for (const p of (t.needs?.readPaths ?? []).map(String).filter((x) => x.trim()).slice(0, 10)) {
        if (readable(p, a)) continue;
        const abs = resolve(folder, p);
        ds.push({ agentId: a.id, agent: `${a.code} ${a.name}`, tool: '실행 전 점검 · 읽기', kind: 'path', target: abs, suggestion: abs, sig: `pre|${a.id}|path|${abs}` });
      }
      if (ds.length) held.push({ task: t, denials: ds }); else keep.push(t);
    }
    return { keep, held };
  }

  /**
   * 이번 실행에서 직원이 권한 때문에 막힌 행위를 모은다: CLI가 보고한 권한 거부 목록 + 작업 폴더 밖 경로 거부(--restricted) 기록.
   * 권한은 지시문으로 바뀌지 않으므로, 같은 설정으로 다시 시도하지 않도록 미션을 멈추는 근거로 쓴다.
   */
  private permissionBlocks(runId: string): MissionDenial[] {
    const out: MissionDenial[] = [];
    const seen = new Set<string>();
    const agents = new Map(this.d.store.listAgents(this.d.store.getRun(runId).projectId, true).map((a) => [a.id, a]));
    const add = (agentId: string | null, tool: string, kind: MissionDenial['kind'], target: string) => {
      const t = target.trim().slice(0, 300);
      if (!t) return;
      const suggestion = kind === 'command' ? commandPrefix(t) : kind === 'path' ? t : null;
      const sig = `${agentId ?? ''}|${tool}|${kind === 'command' ? suggestion : t}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      const a = agentId ? agents.get(agentId) : undefined;
      out.push({ agentId, agent: a ? `${a.code} ${a.name}` : '(직원 정보 없음)', tool, kind, target: t, suggestion, sig });
    };
    const field = (s: string, k: string) => (new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)`).exec(s)?.[1] ?? '').replace(/\\(["\\/])/g, '$1');
    for (const a of this.d.store.runAttempts(runId)) {
      if (a.role !== 'author' && a.role !== 'reviewer') continue;
      for (const d of a.permissionDenials) {
        const tool = d.split(' ')[0];
        const rest = d.slice(tool.length + 1);
        if (tool === 'Bash') add(a.agentId, tool, 'command', field(rest, 'command') || rest);
        else { const p = field(rest, 'file_path') || field(rest, 'path') || field(rest, 'notebook_path'); add(a.agentId, tool, p ? 'path' : 'other', p || rest); }
      }
      for (const e of this.d.store.events(a.id)) {
        if (e.kind !== 'denied') continue;
        const m = /([A-Za-z]:\\[^\s]+|\/[^\s]+) is outside /.exec(e.summary);
        if (m) add(a.agentId, '파일 도구', 'path', m[1]);
      }
    }
    return out.slice(0, 20);
  }

  // ───── 배운 것 ─────
  private learningNow = new Set<string>();
  private learnAgain = new Set<string>();
  private learnedSection(projectId: string): string[] {
    if (!this.d.learnings || !(this.d.learnEnabled?.() ?? true)) return [];
    const s = this.d.learnings.promptSection(projectId);
    return s ? [s, ''] : [];
  }
  /**
   * 이 미션에서 사용자가 한 말(지시·추가 지시·답변)과 그 맥락을 오퍼레이터가 읽고, 다음 지시·다른 프로젝트에 쓸 사실만 뽑아 저장한다.
   * 저장한 것은 바로 반영하고 '검토 필요'로 표시한다. 실패해도 미션 진행에는 영향이 없다.
   */
  private async learn(id: string) {
    if (!this.d.learnings || !(this.d.learnEnabled?.() ?? true) || this.closed) return;
    // 정리 중이면 끝난 뒤 한 번 더 정리한다(그사이 들어온 답변을 놓치지 않게)
    if (this.learningNow.has(id)) { this.learnAgain.add(id); return; }
    const m = this.get(id);
    const evs = this.events(id).filter((e) => e.seq > (m.learnedSeq ?? 0));
    if (!evs.some((e) => ['user', 'directive', 'answer'].includes(e.kind))) return;
    this.learningNow.add(id);
    try {
      const project = this.d.store.getProject(m.projectId);
      const label: Record<string, string> = { user: '사용자 지시', directive: '사용자 추가 지시', answer: '사용자 답변', question: '오퍼레이터 질문', operator_judge: '오퍼레이터 판단' };
      // 대화는 앞에서부터 8,000자까지 보내고, 보낸 기록까지만 정리한 것으로 표시한다(잘린 뒤쪽은 다음에 이어서 정리)
      // 사용자가 한 말(지시·추가 지시·답변)은 잘라내지 않고 그대로 보낸다(맥락용 질문·판단만 600자로 줄임)
      const mine = new Set(['user', 'directive', 'answer']);
      const lines: string[] = []; let used = 0; let lastSent = m.learnedSeq ?? 0;
      for (const e of evs) {
        if (!label[e.kind]) { lastSent = e.seq; continue; }
        const line = `- [${label[e.kind]}] ${mine.has(e.kind) ? e.text : e.text.slice(0, 600)}`;
        if (used + line.length > 24000 && lines.length) break;
        lines.push(line); used += line.length + 1; lastSent = e.seq;
      }
      const convo = lines.join('\n');
      const known = this.d.learnings.applicable(m.projectId).map((l) => `- ${l.text}`).join('\n') || '- (없음)';
      const prompt = [
        '# 학습 정리', '',
        '당신은 CREWGENAI 개발팀의 00 총괄 오퍼레이터다. 아래는 이번 미션에서 사용자와 주고받은 내용이다. 다음 지시와 다른 프로젝트에서 사용자를 더 잘 이해하는 데 쓸 사실만 뽑는다. 파일은 수정하지 않는다.', '',
        `## 프로젝트: ${project.plan.name}`, '',
        '## 이번 미션의 대화', convo, '',
        '## 이미 알고 있는 것(중복으로 넣지 않는다)', known, '',
        '## 규칙',
        '- 사용자가 직접 말했거나 분명히 보여 준 것만 쓴다. 추측하지 않는다.',
        '- 이번 한 번에만 해당하는 작업 내용은 빼고, 반복해서 쓸 수 있는 것만 쓴다: 선호(문체·형식·진행 방식)=preference, 내 PC 환경(설치된 도구·허용된 명령·경로)=environment, 하지 말 것=rule, 프로젝트 사실=fact.',
        '- 모든 프로젝트에 해당하면 scope=global, 이 프로젝트에만 해당하면 scope=project.',
        '- 한 항목은 한 문장, 80자 안팎. 비밀값·개인 정보·고객 원문은 쓰지 않는다. 최대 6개. 없으면 빈 배열.',
      ].join('\n');
      const out = await this.callOperator<{ items: { scope: 'global' | 'project'; kind: 'preference' | 'environment' | 'rule' | 'fact'; text: string }[] }>(m, project.plan, prompt, LEARN_SCHEMA, `${id}:learn`);
      let n = 0;
      for (const it of (Array.isArray(out?.items) ? out.items : []).slice(0, 6)) {
        if (!it || typeof it.text !== 'string') continue;
        const r = this.d.learnings.add({ scope: it.scope === 'project' ? 'project' : 'global', projectId: m.projectId, kind: it.kind, text: it.text }, { source: `미션: ${redact(m.prompt).slice(0, 60)}`, reviewed: false });
        if (r) n++;
      }
      this.set(id, { learnedSeq: lastSent });
      if (lastSent < Math.max(...evs.map((e) => e.seq))) this.learnAgain.add(id);
      if (n) {
        this.event(this.get(id), 'system', `배운 것 ${n}개를 저장했습니다. 다음 지시부터 반영하며, 왼쪽 아래 '배운 것'에서 검토·수정할 수 있습니다.`);
        this.d.emit({ type: 'learning' });
      }
    } catch { /* 학습 정리 실패는 미션에 영향 없음 */ } finally {
      this.learningNow.delete(id);
      if (this.learnAgain.delete(id) && !this.closed) void this.learn(id);
    }
  }

  // ───── 문서 저장소 최신화(자동 처리) ─────
  /**
   * 사이클 시작 때 이 프로젝트가 쓰는 문서 저장소만 fast-forward로 최신화한다. 실패는 기록만 하고 진행한다.
   * 대상: 빌드 파일이 없는 저장소 중 참고 문서·이전 결과물·수정 허용 경로가 그 저장소 안을 가리키거나 스킬을 가져오는 저장소.
   * 연결 폴더 전체처럼 저장소를 포함하는 상위 경로는 대상을 정하는 근거로 보지 않는다(관련 없는 저장소를 건드리지 않게).
   */
  private async syncDocs(m: Mission, plan: PlanFields) {
    if (!this.d.autoAssist?.() || !(this.d.gitCommits?.() ?? true) || this.closed) return;
    const docs = docReposFor(plan.folder, [...plan.referenceDocs, ...plan.priorOutputs, ...plan.writablePaths]);
    const moved: string[] = []; const skipped: string[] = [];
    for (const r of docs.slice(0, 20)) {
      if (this.closed) return;
      const res = await syncRepoFastForward(r.abs);
      if (res.moved) moved.push(`${r.rel || '연결 폴더'} ${res.note}`);
      else if (res.note) skipped.push(`${r.rel || '연결 폴더'}: ${res.note}`);
    }
    if (moved.length || skipped.length) this.event(m, 'system', [moved.length ? `문서 저장소 최신화: ${moved.join(', ')}` : '', skipped.length ? `최신화하지 않음: ${skipped.join(' / ')}` : ''].filter(Boolean).join('\n'));
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
    const st = this.set(id, { status: 'stopped', stage: 'stopped', question: null, limitUntil: null });
    void this.learn(id);
    return st;
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
        await this.syncDocs(m, project.plan);
        if (this.closed || this.get(id).status === 'stopped') return;
        const plan = await this.patient(id, () => this.callOperator<Plan>(this.get(id), project.plan, this.planPrompt(this.get(id), project.plan, agents), PLAN_SCHEMA));
        if (this.get(id).status === 'stopped') return;
        this.event(m, 'operator_plan', `사이클 ${m.cycle} 계획: ${plan.summary} (작업 ${plan.tasks.length}개)`, plan);
        this.collectStaff(id, plan.staffProposals, agents);
        const gaps = (Array.isArray(plan.gaps) ? plan.gaps : []).filter((g) => g && (String(g.issue ?? '').trim() || String(g.need ?? '').trim()))
          .slice(0, 12).map((g): MissionGap => {
            const pc = pickChoices((g as { choices?: unknown }).choices, g.options); const o = pc.opts; const explain = String(g.explain ?? '').trim().slice(0, 1200);
            const refs = (Array.isArray(g.refs) ? g.refs : []).filter((r) => r && String(r.path ?? '').trim()).slice(0, 4)
              .map((r) => ({ path: String(r.path).trim().slice(0, 500), line: Number.isInteger(r.line) && Number(r.line) > 0 ? Number(r.line) : null }));
            return { doc: String(g.doc ?? '').slice(0, 200), issue: String(g.issue ?? '').slice(0, 600), need: String(g.need ?? '').slice(0, 600), ...(o.length ? { options: o } : {}), ...(pc.choices.length ? { choices: pc.choices } : {}), ...(explain ? { explain } : {}), ...(refs.length ? { refs } : {}) };
          })
          .filter((g) => !(this.get(id).decisions ?? []).some((d) => gapKey(d) === gapKey(g))); // 이미 결정한 항목은 다시 묻지 않는다(계획 중에 고른 결정 포함)
        // 사용자가 '나중에'로 남긴 항목은 새 계획이 다른 항목을 내도 결정·해결 전까지 유지한다
        { const cur = this.get(id); const kept = (cur.gaps ?? []).filter((g) => !(cur.decisions ?? []).some((d) => gapKey(d) === gapKey(g)));
          const fresh = gaps.filter((g) => !kept.some((k) => gapKey(k) === gapKey(g)));
          gaps.splice(0, gaps.length, ...kept, ...fresh.slice(0, Math.max(0, 12 - kept.length))); }
        if (gaps.length && plan.tasks.length) {
          // 근거가 부족한 부분이 있어도 기존 문서·결과물로 할 수 있는 일은 진행한다. 부족한 부분은 확인 필요로만 남긴다.
          this.event(m, 'system', `근거가 부족한 부분은 확인 필요로 남기고, 할 수 있는 작업부터 진행합니다.\n${gaps.map((g) => `- [${g.doc || '문서 미지정'}] ${g.issue}`).join('\n')}`, { gaps });
          this.set(id, { gaps });
        } else if (gaps.length) {
          // 근거가 없어 시작할 수 있는 작업이 하나도 없음: 채워야 할 부분을 알려 주고 멈춘다(문서를 보완한 뒤 이어서 진행)
          const q = `근거 문서를 보완해 주세요.${plan.question.trim() ? ` ${plan.question.trim()}` : ''}\n${gaps.map((g) => `- [${g.doc || '문서 미지정'}] ${g.issue}${g.need ? ` → 채울 내용: ${g.need}` : ''}`).join('\n')}`;
          const qc = plan.question.trim() ? pickChoices(plan.questionChoices, plan.questionOptions) : null; const qo = qc ? qc.opts : null; // 오퍼레이터가 함께 물은 질문은 근거 부족 항목과 같이 보여 준다
          this.event(m, 'question', q, { gaps });
          this.set(id, { status: 'waiting_user', stage: 'ask_user', question: q, gaps, questionOptions: qo, questionChoices: qc?.choices.length ? qc.choices : null });
          return;
        }
        if (plan.question.trim() || plan.tasks.length === 0) {
          const pq = plan.question.trim() ? pickChoices(plan.questionChoices, plan.questionOptions) : { opts: [], choices: [] }; const opts = pq.opts;
          this.event(m, 'question', plan.question.trim() || '진행할 작업을 정하지 못했습니다. 추가 지시가 필요합니다.', opts.length ? { options: opts } : undefined);
          this.set(id, { status: 'waiting_user', stage: 'ask_user', question: plan.question.trim() || '진행할 작업을 정하지 못했습니다. 무엇을 할지 알려 주세요.', questionOptions: opts, questionChoices: pq.choices.length ? pq.choices : null });
          return;
        }

        // 2) 실행 전 권한 점검: 허용되지 않은 명령·경로가 필요한 작업은 돌리지 않고 확인 필요로 뺀다
        const pre = this.preflight(project.plan, agents, plan.tasks);
        if (pre.held.length) {
          const ds = pre.held.flatMap((h) => h.denials);
          const list = pre.held.map((h) => `- ${h.task.title}: ${h.denials.map((d) => d.target).join(', ')}`).join('\n');
          const cur = this.get(id);
          const merged = [...(cur.denials ?? []).filter((d) => !ds.some((x) => x.sig === d.sig)), ...ds].slice(0, 30);
          if (!pre.keep.length) {
            const q = `계획한 작업이 모두 허용되지 않은 명령·경로를 필요로 해서 실행하지 않았습니다. 아래 항목을 허용하거나 지시를 바꿔 주세요.\n${list}`;
            this.event(m, 'question', q, { denials: ds });
            this.set(id, { status: 'waiting_user', stage: 'ask_user', question: q, denials: merged });
            return;
          }
          this.event(m, 'system', `실행 전 점검: 허용되지 않은 명령·경로가 필요한 작업은 이번 사이클에서 빼고 확인 필요로 남깁니다. 나머지 작업은 진행합니다.\n${list}`, { denials: ds });
          this.set(id, { denials: merged, parkedSigs: [...new Set([...(cur.parkedSigs ?? []), ...ds.map((d) => d.sig)])] });
          plan.tasks = pre.keep;
        }

        // 3) 사이클 흐름 구성·실행
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
        // 권한 거부: 실행이 실패했거나 직전 사이클과 같은 거부가 반복되면 같은 설정으로 다시 시도하지 않고 멈춘다(권한은 앱 설정으로만 바뀐다)
        if (!this.replan.has(id)) {
          const blocks = this.permissionBlocks(run.id);
          const cur = this.get(id);
          const prev = cur.denialSigs ?? [];
          const parked = cur.parkedSigs ?? [];
          const repeated = blocks.some((b) => prev.includes(b.sig));
          if (blocks.length && (fin.status !== 'succeeded' || repeated)) {
            const list = blocks.map((b) => `- ${b.agent} · ${b.tool}: ${b.target}`).join('\n');
            const merged = [...(cur.denials ?? []).filter((d) => !blocks.some((x) => x.sig === d.sig)), ...blocks].slice(0, 30);
            if (blocks.some((b) => parked.includes(b.sig))) {
              // 보류했던 업무가 같은 거부로 다시 막힘: 묻고 멈추지 않고 보류를 유지한 채 다른 일을 계속한다(진전 없는 사이클이 이어지면 아래에서 멈춤)
              this.event(m, 'system', `보류했던 업무가 같은 권한 거부로 다시 막혀 보류를 유지합니다. 다른 작업을 계속합니다.\n${list}`, { denials: blocks });
              this.set(id, { denials: merged, denialSigs: blocks.map((b) => b.sig) });
            } else {
            // 처음 막힘: 그 업무만 보류(확인 필요)하고 나머지는 계속한다. 보류한 업무는 사용자가 해결하기 전까지 다시 계획하지 않는다.
            this.event(m, 'system', `권한 때문에 막힌 업무를 보류했습니다(확인 필요). 해결하기 전까지 다시 계획하지 않고 나머지 작업을 계속합니다.\n${list}`, { denials: blocks });
            this.set(id, { denials: merged, denialSigs: blocks.map((b) => b.sig), parkedSigs: [...new Set([...parked, ...blocks.map((b) => b.sig)])] });
            }
          } else this.set(id, { denialSigs: blocks.map((b) => b.sig) });
        }
        // 실패가 내 PC 환경 문제이거나 지난 사이클과 같은 원인으로 반복되면, 다시 계획해도 같은 실패가 나므로 멈추고 사용자 검토를 받는다
        if (!this.replan.has(id)) {
          const failed = fin.status === 'failed' ? this.d.store.runNodes(run.id).filter((n) => n.status === 'failed' && n.failureReason) : [];
          const labels = new Map(built.graph.nodes.map((n) => [n.id, n.label]));
          const items = failed.map((n) => ({ step: labels.get(n.nodeId) ?? n.nodeId, reason: n.failureReason.slice(0, 600) }));
          if (fin.status === 'failed' && !items.length && fin.reason) items.push({ step: '실행', reason: fin.reason.slice(0, 600) });
          const prev = this.get(id).failSigs ?? [];
          const blockers: MissionBlocker[] = items.flatMap((x): MissionBlocker[] => ENV_FAILURE.test(x.reason) ? [{ ...x, kind: 'environment' as const }] : prev.includes(failureSig(x.reason, x.step)) ? [{ ...x, kind: 'repeated' as const }] : []);
          if (blockers.length) {
            const list = blockers.map((b) => `- [${b.kind === 'environment' ? '내 PC 환경' : '같은 실패 반복'}] ${b.step}: ${b.reason}`).join('\n');
            const parked = this.get(id).parkedSigs ?? [];
            const bsig = (b: MissionBlocker) => `fail|${failureSig(b.reason, b.step)}`;
            const all = [...(this.get(id).blockers ?? []).filter((x) => !blockers.some((b) => bsig(b) === bsig(x))), ...blockers].slice(0, 20);
            if (blockers.some((b) => parked.includes(bsig(b)))) {
              // 보류했던 업무가 같은 원인으로 다시 실패: 보류를 유지한 채 다른 일을 계속한다(진전 없는 사이클이 이어지면 아래에서 멈춤)
              this.event(m, 'system', `보류했던 업무가 같은 원인으로 다시 실패해 보류를 유지합니다. 다른 작업을 계속합니다.\n${list}`, { blockers });
              this.set(id, { blockers: all, failSigs: items.map((x) => failureSig(x.reason, x.step)) });
            } else {
            this.event(m, 'system', `스스로 풀 수 없는 실패가 난 업무를 보류했습니다(확인 필요). 해결하기 전까지 다시 계획하지 않고 나머지 작업을 계속합니다.\n${list}`, { blockers });
            this.set(id, { blockers: all, parkedSigs: [...new Set([...parked, ...blockers.map(bsig)])], failSigs: items.map((x) => failureSig(x.reason, x.step)) });
            }
          } else
          this.set(id, { failSigs: items.map((x) => failureSig(x.reason, x.step)) });
        }
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
        this.collectStaff(id, judge.staffProposals, this.d.ensureAgents(m.projectId).filter((a) => a.active));
        m = this.set(id, { results: resolveResults(project.plan.folder, judge.results), resultsCycle: m.cycle });
        if (judge.decision === 'done') {
          const pk = this.get(id); const open = (pk.denials?.length ?? 0) + (pk.blockers?.length ?? 0);
          this.set(id, { status: 'done', stage: 'done', summary: judge.summary, question: `완료 보고: ${judge.summary}${open ? `\n(보류한 업무 ${open}건은 확인이 필요합니다)` : ''}` });
          this.event(m, 'question', '완료 보고 — 결과물을 검토하고 추가 지시하거나 종료하세요.');
          void this.learn(id);
          return;
        }
        if (judge.decision === 'ask_user') {
          const jq = judge.question ? pickChoices(judge.questionChoices, judge.questionOptions) : { opts: [], choices: [] }; const opts = jq.opts;
          this.set(id, { status: 'waiting_user', stage: 'ask_user', summary: judge.summary, question: judge.question || judge.summary, questionOptions: opts, questionChoices: jq.choices.length ? jq.choices : null });
          this.event(m, 'question', judge.question || judge.summary);
          return;
        }
        // 진전 없는 사이클(직원이 실제 프로젝트에 반영한 변경이 없음)은 상한을 쓰지 않는다. 두 번 이어지면 같은 자리를 도는 것이므로 멈추고 묻는다.
        const progressed = this.d.store.runAttempts(run.id).some((a) => a.role === 'author' && a.changedFiles.length > 0);
        const idle = progressed ? 0 : (this.get(id).idleCycles ?? 0) + 1;
        if (idle >= IDLE_LIMIT) {
          const q = `최근 ${idle}개 사이클 동안 실제로 반영된 변경이 없었습니다(같은 자리를 돌고 있음). 오퍼레이터 판단: ${judge.summary}\n다음 초점: ${judge.nextFocus}\n방향을 바꿔 계속할까요, 종료할까요?`;
          this.set(id, { status: 'waiting_user', stage: 'ask_user', summary: judge.summary, question: q, idleCycles: 0 });
          this.event(m, 'question', q, { idle });
          return;
        }
        if (!progressed) { m = this.set(id, { idleCycles: idle, maxCycles: m.maxCycles + 1 }); this.event(m, 'system', `사이클 ${m.cycle}은 반영된 변경이 없어 사이클 상한에 넣지 않습니다(상한 ${m.maxCycles}).`); }
        else m = this.set(id, { idleCycles: 0 });
        if (m.cycle >= m.maxCycles) {
          const q = `사이클 ${m.cycle}회를 진행했습니다(설정 상한). 오퍼레이터 판단: ${judge.summary}. 다음 초점: ${judge.nextFocus}. 계속 진행할까요?`;
          const capChoices: MissionChoice[] = [
            { label: '계속 진행', effect: `사이클 상한을 늘려 다음 초점(${judge.nextFocus.slice(0, 120)})부터 이어서 진행합니다.`, recommended: true, why: '오퍼레이터가 남은 일이 분명하고 사용자 확인 없이 진행할 수 있다고 판단했습니다.' },
            { label: '여기서 종료', effect: '미션을 종료합니다. 지금까지의 결과물과 기록은 그대로 남고, 나중에 이어서 다시 시작할 수 있습니다.', recommended: false, why: '', action: 'stop' },
          ];
          this.set(id, { status: 'waiting_user', stage: 'ask_user', summary: judge.summary, question: q, questionOptions: capChoices.map((c) => c.label), questionChoices: capChoices });
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
      const a = mk('agent', `${t.title} (${author.code} ${author.name})`, x, 130, { agentId: author.id, instructions: `${t.instructions}\n\n[문서 기준] 근거 문서·할 일 목록에 적힌 내용 그대로 작업한다. 문서에 없거나 애매한 기능·결정은 추측해 만들거나 바꾸지 말고, 결과 보고의 '확인 필요'에 적는다.`, writeScope: scope, outputs: outs, doneCriteria: t.doneCriteria, skipInlineReview: true });
      const cx = mk('codexReview', `Codex 리뷰: ${t.title}`, x, 260, { inputs: outs.map((o) => o.path), doneCriteria: t.doneCriteria, timeoutSec: 1800 });
      const rv = mk('review', `Claude 재검토: ${t.title} (${reviewer.code} ${reviewer.name})`, x, 390, { agentId: reviewer.id, doneCriteria: t.doneCriteria,
        instructions: 'Codex 리뷰 보고서의 지적을 원문 산출물과 직접 대조한다. 재작업(changes_requested)은 완료 조건을 충족하지 못했거나, 근거 문서와 다르게 만들었거나, P0·P1(정확성·보안·요구 위반) 지적이 타당할 때만 요청한다. P2 같은 경미한 지적·표현·완성도 지적은 재작업 사유가 아니다. 승인하되 summary에 "남은 경미 지적"으로 적는다. 근거 없는 지적은 이유를 들어 기각한다.' });
      nodes.push(a, cx, rv);
      e(a, cx); e(cx, rv); e(rv, a, 'fail');
      let last = rv;
      const ck0 = this.safeCheck(t.checkCommand, author, plan.folder);
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
  private safeCheck(argv: string[], author: Agent, folder: string): string[] | null {
    return checkArgv(argv, author.allowedCommands, folder);
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
      ...this.learnedSection(m.projectId),
      `## 사이클: ${m.cycle} / 상한 ${m.maxCycles}`, '',
      '## 프로젝트', `- 이름: ${plan.name}`, `- 목표: ${plan.goal}`, `- 원하는 결과물: ${plan.deliverable}`, `- 완료 조건: ${plan.doneCriteria}`, `- 작업 범위: ${plan.scope}`,
      `- 자동 수정 허용 경로: ${allowedRoots(plan).join(', ') || '(없음)'}`, '',
      '## 사용 가능한 직원', ...agents.map((a) => `- ${a.code} ${a.name}: ${a.role} · 도구 ${a.tools.join(',')}${a.tools.includes('Edit') || a.tools.includes('Write') ? ' · 쓰기 가능' : ' · 읽기 전용'}`), '',
      ...this.docsSection(plan, m.projectId),
      '## 지금까지의 판단·질문·사용자 답변', this.history(m), '',
      ...this.decisionsSection(m),
      '## 규칙',
      '- 작업마다 writeScope(수정 경로)는 자동 수정 허용 경로 안이어야 하고, 작업끼리 겹치지 않게 나눈다. outputs는 writeScope 안에 둔다.',
      '- agentCode는 위 목록의 쓰기 가능한 직원 코드만 쓴다. 각 작업 결과는 Codex 리뷰와 다른 직원의 Claude 재검토를 거친다.',
      '- outputs의 path는 만들 파일 경로다. 여러 파일을 담는 폴더를 산출물로 하려면 폴더 경로를 쓰고, 그 안 파일의 형식을 format에 쓴다(폴더 안에 그 형식 파일이 하나 이상 있어야 통과). 형식을 가리지 않으면 any.',
      '- checkCommand는 셸 없이 실행할 argv 배열이다(필요 없으면 빈 배열). 셸·인터프리터 코드 실행은 거부되며, 담당의 허용 명령이나 grep/test만 쓸 수 있다.',
      '- 먼저 근거 문서·기존 결과물을 읽고 업무를 분석한다. 근거가 빈약하거나 애매한 부분(내용 없음·서로 모순·결정 안 됨·범위 불명확)은 gaps에 문서별로 issue(무엇이 부족한지, 문서의 어느 부분인지)와 need(사용자가 채워야 할 내용)를 쓴다. 그래도 기존 문서·결과물로 할 수 있는 작업은 tasks로 계속 계획한다(gaps는 확인 필요로만 남고 진행을 막지 않는다). 이번 지시 전체가 근거 없이는 시작할 수 없을 때만 tasks를 비운다. 추측으로 빈 곳을 메우지 않는다. 근거가 충분하면 gaps는 빈 배열.',
      "- gaps 항목이 사용자가 고르기만 하면 되는 결정(어느 기준을 따를지, 유지·되돌림, 범위·우선순위 등)이면 choices에 2~4개의 선택지를 쓴다: label(예: 'HTML 기준 유지'), effect(고르면 무엇이 달라지는지 쉬운 한 문장, 예: '제품 화면을 HTML에 맞춰 고친다'), recommended(추천하는 안 하나만 true), why(추천 이유 한 문장). 사용자에게 명령 실행·결과 붙여넣기 같은 수작업을 선택지로 내지 않는다. '보류'는 앱이 따로 주므로 넣지 않는다. 내용을 사용자가 직접 채워야 하는 항목이면 options는 빈 배열.",
      ASK_RULE, ENOUGH_RULE, NO_MANUAL_RULE, RESULT_RULE,
      '- gaps 항목마다 explain에 이 문서들을 읽지 않은 사용자도 바로 이해하도록 쉬운 말로 3~5문장을 쓴다: 무엇이 문제인지(문서에 실제로 적힌 내용·서로 다른 두 내용을 짧게 옮겨 보여 줌), 왜 진행에 영향이 있는지, 각 선택지를 고르면 무엇이 달라지는지. 내부 약어·업무 ID(예: 문서 코드, W-00-15)는 그대로 쓰지 말고 무엇인지 풀어 쓴다. refs에는 근거 위치를 프로젝트 폴더 기준 경로(폴더 밖 참고 문서는 절대 경로)와 줄 번호로 적는다(사용자가 바로 열어 본다). 아직 없는 문서는 refs에 넣지 않는다.',
      '- 사용자 결정(위)에 있는 항목은 gaps에 다시 쓰지 않고, 그 결정을 그대로 따른다. 관련 작업 지시에는 해당 결정을 그대로 옮겨 적는다.',
      `- 할 일 목록: 자동 수정 허용 경로 아래에 할 일 목록 파일(예: ${plan.outputDir || 'docs'}/WORK_LIST.md)이 있으면 그 항목을 기준으로 작업을 만들고, 작업 지시에 항목 ID와 근거 문서 위치(파일·절)를 그대로 적는다. 목록이 없고 기존 문서·결과물이 있으면 첫 작업 하나로 기획 문서·기존 결과물에서 할 일 목록을 정리한다(항목·근거 위치·상태만 한 번에 정리, 전수 대조·완벽한 표를 목표로 하지 않는다). 문서에 없는 기능·결정은 목록에 만들지 않고 '확인 필요'로 표시한다.`,
      ...(this.d.autoAssist?.() ? [`- 자동 처리(앱이 함): 직원 변경은 dev·main에 커밋하지 않고 작업 브랜치 ${workBranchName(m.id)}에 커밋된다(push·PR·병합은 사용자). 따라서 저장소가 dev·main이라는 이유로 작업을 보류하거나 브랜치 생성을 확인 필요로 올리지 않는다. Bash를 가진 직원에게는 저장소에 있는 시험 명령(scripts/gradle.sh·scripts/check.sh·npm check)이 자동 허용된다(네트워크 없음).`] : []),
      '- needs: 작업에 Bash 명령이 필요하면 commands에 실제 실행할 명령을, 프로젝트 폴더 밖에서 읽어야 하는 파일·폴더가 있으면 readPaths에 절대 경로를 쓴다. 담당 직원에게 허용되지 않은 것이 있으면 그 작업은 실행하지 않고 사용자 확인으로 돌린다. 필요 없으면 빈 배열.',
      '- 이 PC(Windows판)에서는 직원이 Bash 명령을 쓸 수 없다. 명령이 꼭 필요한 일은 needs.commands에 적어 사용자에게 맡긴다.',
      '- 진행에 꼭 필요한 정보가 없거나 사용자 결정이 필요하면 tasks를 비우고 question에 한 가지 질문만 쓴다. 고르면 되는 질문이면 questionChoices에 2~4개의 선택지를 쓴다: label(선택지), effect(고르면 무엇이 달라지는지 쉬운 한 문장), recommended(추천하는 안 하나만 true), why(추천 이유 한 문장, 추천 안에만). 그렇지 않으면 question은 빈 문자열.',
      '- 이전 사이클의 결과·판단을 이어받아 남은 일만 계획한다. 작업은 1~4개로 작게 나눈다.',
      '- staffProposals: 이번 지시를 하는 데 지금 직원으로는 부족한 근거가 있을 때만(맞는 역할의 직원이 없음, 같은 직원이 역할·지시 때문에 반복해 엇나감, 직원 지시가 근거 문서·사용자 결정과 어긋남) 제안한다. 새 직원은 kind=add(name·role·instructions, 비슷한 일을 하는 기존 직원 코드를 agentCode에, 작업 폴더는 workPaths), 기존 직원의 역할·지시 변경은 kind=update(agentCode와 바뀐 role·instructions 전체). reason에는 이번 사이클에서 본 근거를 쓴다. 도구·명령 권한은 제안하지 않는다. 오퍼레이터(00)는 바꾸지 않는다. 제안은 사용자가 적용할 때까지 반영되지 않으니 지금 있는 직원으로 계획을 계속한다. 필요 없으면 빈 배열.',
      ...this.staffSection(m),
      ...this.parkedSection(m),
    ].join('\n');
  }

  /**
   * 오퍼레이터의 직원 제안을 모은다(진행은 막지 않는다). 오퍼레이터(00) 자신과 없는 직원은 바꾸지 않고,
   * 같은 내용으로 이미 기다리는·무시한 제안은 다시 올리지 않는다. 기다리는 제안은 최대 6건.
   */
  private collectStaff(id: string, raw: RawStaff[] | undefined, agents: Agent[]): void {
    if (!Array.isArray(raw) || !raw.length) return;
    const m = this.get(id);
    const list = [...(m.staffProposals ?? [])];
    const added: StaffProposal[] = [];
    const t = (v: unknown, n: number) => redact(String(v ?? '').trim()).slice(0, n);
    for (const r of raw.slice(0, 3)) {
      const kind = r?.kind === 'update' ? 'update' : r?.kind === 'add' ? 'add' : null;
      if (!kind) continue;
      const code = t(r.agentCode, 10);
      const name = t(r.name, 60); const role = t(r.role, 300); const instructions = t(r.instructions, 6000); const reason = t(r.reason, 800);
      if (!reason || (!instructions && !role)) continue;
      if (kind === 'update' && (!code || code === '00' || !agents.some((a) => a.code === code))) continue;
      if (kind === 'add' && !name) continue;
      const same = (p: StaffProposal) => p.kind === kind && (kind === 'update' ? p.agentCode === code : p.name === name) && p.status !== 'applied';
      if (list.some(same) || list.filter((p) => p.status === 'pending').length >= 6) continue;
      const workPaths = (Array.isArray(r.workPaths) ? r.workPaths : []).map((w) => String(w ?? '').trim().slice(0, 300)).filter(Boolean).slice(0, 6);
      const p: StaffProposal = { id: uid(), kind, agentId: agents.find((a) => a.code === code)?.id ?? null, agentCode: code, name, role, instructions, workPaths, reason, cycle: m.cycle, at: new Date().toISOString(), status: 'pending' };
      list.push(p); added.push(p);
    }
    if (!added.length) return;
    this.set(id, { staffProposals: list.slice(-40) });
    this.event(m, 'system', `오퍼레이터의 직원 제안 ${added.length}건 — 적용할지 골라 주세요(진행은 계속합니다).\n${added.map((p) => `- ${p.kind === 'add' ? `새 직원 '${p.name}'` : `${p.agentCode} ${p.name || ''} 역할·지시 변경`}: ${p.reason}`).join('\n')}`, { staffProposals: added });
  }

  /** 직원 제안을 적용·무시로 표시한다(실제 직원 저장은 서비스가 한다) */
  markStaffProposal(id: string, proposalId: string, status: 'applied' | 'dismissed', result: string): Mission {
    const m = this.get(id);
    const p = (m.staffProposals ?? []).find((x) => x.id === proposalId);
    if (!p) throw new Error('직원 제안을 찾을 수 없습니다.');
    if (p.status !== 'pending') throw new Error('이미 처리한 직원 제안입니다.');
    this.event(m, 'answer', status === 'applied' ? `직원 제안 적용: ${result}` : `직원 제안 무시: ${p.kind === 'add' ? `새 직원 '${p.name}'` : `${p.agentCode} 역할·지시 변경`} — 다시 제안하지 말 것`);
    return this.set(id, { staffProposals: (m.staffProposals ?? []).map((x) => (x.id === proposalId ? { ...x, status, result } : x)) });
  }

  /** 직원 제안 기록: 기다리는 것·무시한 것은 다시 제안하지 않게 알린다 */
  private staffSection(m: Mission): string[] {
    const ps = (m.staffProposals ?? []).filter((p) => p.status !== 'applied');
    if (!ps.length) return [];
    return ['## 직원 제안 기록(다시 제안하지 말 것)', ...ps.map((p) => `- [${p.status === 'pending' ? '사용자 확인 대기' : '사용자가 무시함'}] ${p.kind === 'add' ? `새 직원 '${p.name}'` : `${p.agentCode} 역할·지시 변경`}`), ''];
  }

  /** 사용자가 확인 필요 항목에 고른 결정: 오퍼레이터·직원이 추측하지 않고 그대로 따른다 */
  private decisionsSection(m: Mission): string[] {
    const ds = m.decisions ?? [];
    if (!ds.length) return [];
    return ['## 사용자 결정(확정 — 그대로 따르고 다시 묻지 않는다)', ...ds.map((d) => `- [${d.doc || '문서 미지정'}] ${d.issue} → ${d.choice}`), ''];
  }

  /** 보류한 업무(사용자 확인 대기): 같은 업무·같은 권한이 필요한 작업을 다시 계획하지 않게 알린다 */
  private parkedSection(m: Mission): string[] {
    const ds = m.denials ?? []; const bs = m.blockers ?? [];
    if (!ds.length && !bs.length) return [];
    return ['', '## 보류한 업무(사용자 확인 대기 — 다시 계획하지 말 것)',
      ...ds.map((d) => `- 권한: ${d.agent} · ${d.tool}: ${d.target}`), ...bs.map((b) => `- ${b.kind === 'environment' ? '내 PC 환경' : '같은 실패 반복'}: ${b.step} — ${b.reason.slice(0, 200)}`),
      '- 위 업무와 같은 작업, 같은 명령·경로가 필요한 작업은 계획하지 않는다. 그 결과가 없어도 할 수 있는 나머지 일을 계획한다.',
      '- 남은 일이 모두 보류한 업무에 달려 있으면 tasks를 비우고 question에 무엇을 해결해야 하는지 한 가지로 묻는다.'];
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
      ...this.learnedSection(m.projectId),
      '## 사용자 지시', m.prompt, '', `## 사이클: ${m.cycle} / 상한 ${m.maxCycles}`, '',
      '## 프로젝트 완료 조건', plan.doneCriteria || '(미입력)', '',
      `## 실행 결과: ${d.run.status}${d.run.reason ? ` — ${d.run.reason}` : ''}`, ...(failed.length ? ['### 실패 단계', ...failed.map((f) => `- ${f}`)] : []), '',
      '## 리뷰 기록', ...(reviews.length ? reviews : ['- (없음)']), '',
      '## 직원(역할·지시 요약 — 직원 제안 판단용)', ...this.d.ensureAgents(m.projectId).filter((a) => a.active && a.code !== '00').map((a) => `- ${a.code} ${a.name}: ${a.role} — ${a.instructions.replace(/\s+/g, ' ').slice(0, 400)}`), '',
      '## 지금까지의 판단·사용자 답변', this.history(m), '',
      ...this.decisionsSection(m),
      '## 이번 사이클 결과물(요약 보고서)', md.slice(0, 15000), '',
      '## 판단 규칙',
      '- done: 사용자 지시와 완료 조건을 산출물로 충족했을 때만. 실행이 실패했거나 검증이 없으면 done이 아니다.',
      '- ask_user: 사용자 결정·검토가 꼭 필요하거나, 같은 실패가 반복되거나, 추가 정보가 없으면 진행할 수 없을 때. question에 한 가지 질문을 쓴다. 고르면 되는 질문이면 questionChoices에 2~4개의 선택지를 쓴다: label(선택지), effect(고르면 무엇이 달라지는지 쉬운 한 문장), recommended(추천하는 안 하나만 true), why(추천 이유 한 문장, 추천 안에만).',
      '- continue: 남은 일이 분명하고 사용자 확인 없이 진행할 수 있을 때. nextFocus에 다음 사이클의 초점을 쓴다.',
      '- 측정하지 않은 성과나 실행하지 않은 검사를 근거로 쓰지 않는다.',
      REPORT_RULE, ASK_RULE, ENOUGH_RULE, NO_MANUAL_RULE, RESULTS_RULE,
      '- staffProposals: 이번 지시를 하는 데 지금 직원으로는 부족한 근거가 있을 때만(맞는 역할의 직원이 없음, 같은 직원이 역할·지시 때문에 반복해 엇나감, 직원 지시가 근거 문서·사용자 결정과 어긋남) 제안한다. 새 직원은 kind=add(name·role·instructions, 비슷한 일을 하는 기존 직원 코드를 agentCode에, 작업 폴더는 workPaths), 기존 직원의 역할·지시 변경은 kind=update(agentCode와 바뀐 role·instructions 전체). reason에는 이번 사이클에서 본 근거를 쓴다. 도구·명령 권한은 제안하지 않는다. 오퍼레이터(00)는 바꾸지 않는다. 제안은 사용자가 적용할 때까지 반영되지 않으니 지금 있는 직원으로 계획을 계속한다. 필요 없으면 빈 배열.',
      ...this.staffSection(m),
      '- 보류한 업무(아래)는 사용자 확인을 기다리는 중이다. 그 실패만으로 ask_user를 고르지 말고 나머지 일로 판단한다. 남은 일이 보류한 업무뿐이면 ask_user.',
      ...this.parkedSection(m),
    ].join('\n');
  }

  /** 오퍼레이터 호출: Claude CLI(읽기 전용 도구, 구조화 출력). 모의 실행이면 모의 CLI를 쓴다. */
  /** key: 프로세스 관리 칸(기본은 미션 ID). 배운 것 정리는 계획 호출과 칸을 나눠 서로의 정리 과정이 겹치지 않게 한다. */
  private async callOperator<T>(m: Mission, plan: PlanFields, prompt: string, schema: object, key: string = m.id): Promise<T> {
    const ex = this.d.executor();
    const op = this.d.store.listAgents(m.projectId).find((a) => a.code === '00');
    const args = buildClaudeArgs({
      prompt, appendSystemPrompt: `당신은 CREWGENAI 개발팀의 00 총괄 오퍼레이터다. ${op?.instructions ?? ''}`.slice(0, 4000), cwd: plan.folder,
      tools: ['Read', 'Grep', 'Glob'], editScopes: [], allowedCommands: [], readDirs: [], sessionId: randomUUID(), resumeSessionId: null,
      jsonSchema: schema, model: op?.model ?? '', effort: op?.effort, maxBudgetUsd: op?.maxBudgetUsd ?? null,
    });
    const file = ex.executor === 'mock' ? process.execPath : ex.cliPath;
    if (!file) throw new Error('Claude CLI가 준비되지 않았습니다.');
    const argv = ex.executor === 'mock' ? [this.d.mockScript, ...args] : args;
    const sink: StreamSink = { sessionId: null, result: null, limit: null };
    const h = startProcess(file, argv, { cwd: plan.folder, env: cleanEnv(ex.executor === 'mock' ? { ELECTRON_RUN_AS_NODE: '1' } : {}), stdin: prompt, timeoutSec: 900,
      onStdoutLine: (l) => { interpretLine(l, sink); }, onStderrLine: () => {} });
    this.procs.set(key, h);
    const sid = args[args.indexOf('--session-id') + 1] ?? '';
    const ps = await processStart(h.pid);
    if (!this.closed) this.d.store.db.prepare('INSERT OR REPLACE INTO mission_procs VALUES(?,?,?,?)').run(key, h.pid, ps, sid);
    const done = await h.done;
    this.procs.delete(key);
    if (!this.closed) this.d.store.db.prepare('DELETE FROM mission_procs WHERE mission_id=?').run(key);
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

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/i;

/** 판단이 적은 결과물을 확인한다: 화면 주소는 이 컴퓨터(localhost)만, 파일은 프로젝트 폴더 안(링크를 푼 실제 경로 기준)만. */
export function resolveResults(folder: string, raw: unknown): MissionResult[] {
  const out: MissionResult[] = [];
  let root = folder; try { root = realpathSync(folder); } catch { /* 폴더 없음 */ }
  for (const r of (Array.isArray(raw) ? raw : []).slice(0, 20) as RawResult[]) {
    const p = String(r?.path ?? '').trim();
    if (!p) continue;
    const base = { task: String(r.task ?? '').slice(0, 200), title: String(r.title ?? '').slice(0, 200) || p.slice(0, 200), changed: redact(String(r.changed ?? '')).slice(0, 600), check: redact(String(r.check ?? '')).slice(0, 600) };
    if (/^[a-z]+:\/\//i.test(p)) {
      if (LOCAL_URL.test(p)) out.push({ ...base, kind: 'url', path: p, relPath: p, exists: true });
      continue; // 외부 주소는 넣지 않는다
    }
    const abs = isAbsolute(p) ? resolve(p) : resolve(folder, p);
    let real = abs; let exists = false;
    try { real = realpathSync(abs); exists = statSync(real).isFile() || statSync(real).isDirectory(); } catch { exists = false; }
    const rel = relative(root, real);
    const relLex = relative(resolve(folder), abs);
    if ((exists ? rel : relLex).startsWith('..') || isAbsolute(exists ? rel : relLex)) continue; // 프로젝트 밖
    out.push({ ...base, kind: 'file', path: exists ? real : abs, relPath: (exists ? rel : relLex).split(sep).join('/'), exists });
  }
  return out;
}
