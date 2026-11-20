// 앱 기능 계층 — Electron과 분리돼 있어 시험에서 직접 구동할 수 있다.
import { closeSync, constants as fsc, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeDocs, defaultDocSet, loadTemplates, safeRel } from './docset';
import { fileSha, isAppTempPath } from './engine/fsutil';
import { DemoManager, demoInfo, readManifest, serviceHash, verifyDemo } from './demo';
import { isCharacterId } from '../shared/characterIds';
import type { Attention, AttentionItem, CommitPreview, Learning, LearningFields, DocItem, MissionChoice, MissionCommitRequest, PendingDecision, ProjectDoc, RefSnippet, SkillSource } from '../shared/types';
import { COMMAND_LEVELS, projectSkillDirs, workBranchName, type CommandLevel } from './autopilot';
import { defaultSkillDirs, describeSkillSources } from './skills';
import { redact, redactKeepLines } from './cli/claudeCli';
import type { DemoAsk, DemoService, MissionLimits } from '../shared/types';
import type { Agent, AgentFields, AppSettings, UsagePaceView, DevSyncView, DevSyncRepoResult, CliStatus, CodexStatus, LiveEvent, MissionReadiness, PlanFields, ReadinessItem, ReviewRecord, WorkGraph } from '../shared/types';
import { checkCodex } from './cli/codexCli';
import { APPROVED_FLAG_LABEL, approvedDiff, commitApproved, findRequestCommit, gitRoot, gitShutdown, previewApprovedCommit, mergeDevToMain, ensureSecretIgnore, gitIgnored, syncRepoToDev, workspaceRepos } from './git';
import { LearningStore } from './learning';
import { MissionRunner, sameQuestion } from './mission';
import { decisionVersion } from '../shared/decisions';
export { decisionVersion };
import { autoLayout, needsLayout } from '../shared/layout';
import { checkCli } from './cli/claudeCli';
import { Store } from './db';
import { NodeSqliteSaver } from './engine/checkpointer';
import { Engine, type Tracer } from './engine/engine';
import { DEFAULT_TEMPLATE_SET, TEMPLATE_SETS, defaultGraph, type TemplateSetId } from './engine/templates';
import { escapes, normRel, validateGraph } from './engine/validate';
import { refDirFor } from './refs';
import { envHas, normEnvRel, resolveEnvPath, secretValueProblem, VAR_NAME, writeEnvVar } from './secrets';
import { DEFAULT_PACE, onUsage, paceDecision, restoreUsage, usageSnapshot, type UsageSnapshot } from './pace';

export interface ServiceDeps {
  /** 참고 사이트 스냅샷 저장(Electron 창으로 공개 페이지를 열어 저장). 없으면 참고 사이트를 쓰지 않는다 */
  captureRef?: (url: string, dir: string) => Promise<{ title: string; finalUrl: string }>;
  dbFile: string;
  mockScript: string;
  mockCodexScript?: string;
  emit: (e: LiveEvent) => void;
  tracer?: (svc: Service) => Tracer;
  secretStore?: { get(): string | null; set(v: string | null): void };
  /** 권장 문서 템플릿 폴더(resources/docs/prompts) — 프로젝트 완성 문서 세트의 표준 세트 */
  promptsDir?: string;
  /** 사용 한도 해제 시각 여유·시각 미상 시 대기(시험용 조정) */
  limitGraceMs?: number;
  limitFallbackMs?: number;
}

const DEFAULT_SETTINGS: Omit<AppSettings, 'langsmithKeySet'> = {
  cliPath: null, executor: 'claude', maxConcurrent: 3, codexPath: null, codexModel: 'gpt-6.1-sol', codexEffort: 'high', missionMaxCycles: 5, learning: true, gitCommits: true, langsmithEnabled: false, langsmithProject: 'crewgenai-agent-workspace', langsmithEndpoint: 'https://api.smith.langchain.com',
};

export function normalizePlan(p: PlanFields): PlanFields {
  const rel = normRel;
  for (const w of [...(p.writablePaths ?? []), p.outputDir ?? '']) if (w && escapes(w)) throw new Error(`프로젝트 밖을 가리키는 경로는 쓸 수 없습니다: ${w}`);
  return {
    name: p.name.trim(), goal: p.goal ?? '', folder: p.folder ?? '', referenceDocs: p.referenceDocs ?? [], priorOutputs: p.priorOutputs ?? [], deliverable: p.deliverable ?? '',
    doneCriteria: p.doneCriteria ?? '', writablePaths: (p.writablePaths ?? []).filter((x) => x.trim()).map(rel).map((x) => x || '.').filter((x) => !x.startsWith('..') && !isAbsolute(x)), scope: p.scope ?? '', // writablePaths의 '.' = 프로젝트 전체
   
    outputDir: rel(p.outputDir || 'crewgenai-output') || 'crewgenai-output',
  };
}

/**
 * 앱 밖에서 물려받은 LangSmith·LangChain 자동 추적 설정을 지운다. 추적은 앱 설정을 켰을 때만,
 * 비밀값·원문을 뺀 앱 자체 추적기로 보낸다(LangGraph 자동 추적이 상태 전체를 보내지 않게).
 */
for (const k of Object.keys(process.env)) if (/^(LANGSMITH_|LANGCHAIN_)/i.test(k)) delete process.env[k];

export class Service {
  readonly store: Store;
  readonly engine: Engine;
  readonly missions: MissionRunner;
  readonly learnings: LearningStore;
  private cli: CliStatus | null = null;
  private codex: CodexStatus | null = null;
  private memSecret: string | null = null;

  readonly demo: DemoManager;
  private offUsage: () => void = () => {};
  constructor(private d: ServiceDeps) {
    this.store = new Store(d.dbFile);
    this.demo = new DemoManager(this.store.db, join(dirname(d.dbFile), 'demo-logs'));
    this.learnings = new LearningStore(this.store.db);
    // 사용량 속도 조절: 마지막으로 받은 사용률을 이 PC에 저장해 재시작 뒤에도 쓴다(계정 전체 사용률이라 프로젝트와 무관)
    restoreUsage(this.store.getSetting<UsageSnapshot | null>('usageWindow', null));
    this.offUsage = onUsage((snap) => { try { this.store.setSetting('usageWindow', snap); } catch { /* 저장 실패는 무시 */ } });
    const saver = new NodeSqliteSaver(this.store.db);
    // 실행 이벤트를 화면으로 보내면서 미션 루프 다이어그램의 현재 단계도 갱신한다
    const emit = (e: LiveEvent) => { d.emit(e); try { this.missions?.onLive(e); } catch { /* 미션 갱신 실패는 실행에 영향 없음 */ } };
    this.engine = new Engine({
      referenceRoot: join(dirname(d.dbFile), 'references'),
      store: this.store, checkpointer: saver, emit, mockScript: d.mockScript, mockCodexScript: d.mockCodexScript,
      codex: () => ({ path: this.codex?.path ?? this.settings().codexPath, model: this.settings().codexModel || 'gpt-6.1-sol', effort: this.settings().codexEffort || 'high' }),
      executor: () => ({ executor: this.settings().executor, cliPath: this.cli?.path ?? this.settings().cliPath, authMethod: this.cli?.authMethod ?? null }),
      maxConcurrent: () => this.settings().maxConcurrent,
      gitCommits: () => this.settings().gitCommits !== false,
      tracer: d.tracer?.(this),
      limitGraceMs: d.limitGraceMs, limitFallbackMs: d.limitFallbackMs,
      learningsFor: (pid) => (this.settings().learning !== false ? this.learnings.promptSection(pid, 1200) : ''),
      skills: (folder) => ({ dirs: [...new Set([...this.skillDirs(), ...(this.settings().autoAssist !== false ? projectSkillDirs(folder) : [])])], cacheDir: join(dirname(d.dbFile), 'skill-bundles') }),
      autoAssist: () => this.settings().autoAssist !== false,
      testLocalSockets: () => this.settings().testLocalSockets === true,
      commandLevel: () => this.commandLevel(),
    });
    this.missions = new MissionRunner({
      pace: () => this.paceNow(),
      referenceRoot: join(dirname(d.dbFile), 'references'),
      captureRef: d.captureRef ? async (url, missionId) => { const dir = refDirFor(join(dirname(d.dbFile), 'references'), missionId, url); const r = await d.captureRef!(url, dir); return { ...r, dir }; } : undefined,
      techAuto: () => this.settings().techAuto !== false,
      docTidy: () => this.settings().docTidy !== false,
      devSync: () => this.settings().devSync !== false,
      store: this.store, engine: this.engine, emit: d.emit, mockScript: d.mockScript,
      executor: () => ({ executor: this.settings().executor, cliPath: this.cli?.path ?? this.settings().cliPath }),
      maxCycles: () => this.settings().missionMaxCycles || 5,
      gitCommits: () => this.settings().gitCommits !== false,
      ensureAgents: (pid) => (this.store.listAgents(pid).length ? this.store.listAgents(pid) : this.loadAgentTemplates(pid)),
      projectDocs: (pid) => this.projectDocs(pid),
      learnings: this.learnings,
      learnEnabled: () => this.settings().learning !== false,
      autoAssist: () => this.settings().autoAssist !== false,
      commandLevel: () => this.commandLevel(),
      testLocalSockets: () => this.settings().testLocalSockets === true,
      skillNames: (folder) => describeSkillSources([...new Set([...this.skillDirs(), ...(this.settings().autoAssist !== false ? projectSkillDirs(folder) : [])])]).flatMap((x) => x.skills),
      demoVerify: (projectId, asks) => verifyDemo(this.demo, projectId, this.store.getProject(projectId).plan, asks),
    });
  }

  async codexStatus(refresh: boolean): Promise<CodexStatus> {
    if (!this.codex || refresh) this.codex = await checkCodex(this.settings().codexPath);
    return this.codex;
  }

  private async gitItem(folder: string): Promise<ReadinessItem> {
    const ws = folder && existsSync(folder) ? await workspaceRepos(folder) : { mode: 'none' as const, repos: [] };
    const base = { key: 'git', label: 'git 저장소 연결', tab: 'plan' as const };
    if (ws.mode === 'none') return { ...base, ok: false,
      detail: '연결 폴더가 git 저장소이거나, 바로 아래에 git 저장소 폴더가 있어야 직원별 커밋과 스냅샷 되돌리기를 쓸 수 있습니다. 여러 저장소를 담은 상위 폴더에는 git init을 하지 말고, 각 저장소 폴더를 그대로 두세요. 새 폴더라면 그 폴더에서 git init 후 첫 커밋을 만드세요.' };
    if (ws.mode === 'single') {
      const has = ws.repos[0].hasCommit;
      const root = await gitRoot(folder);
      return { ...base, ok: has, detail: has ? `${root} · 직원별 커밋·스냅샷·되돌리기 사용` : '커밋이 하나도 없는 저장소입니다. 되돌릴 기준점이 없으므로 첫 커밋을 먼저 만드세요.' };
    }
    const ready = ws.repos.filter((r) => r.hasCommit).map((r) => r.rel);
    const empty = ws.repos.filter((r) => !r.hasCommit).map((r) => r.rel);
    const list = (xs: string[]) => `${xs.slice(0, 8).join(', ')}${xs.length > 8 ? ` 외 ${xs.length - 8}개` : ''}`;
    return { ...base, ok: ready.length > 0,
      detail: ready.length
        ? `여러 저장소 · 하위 저장소 ${ready.length}개(${list(ready)})에 저장소별로 직원 커밋·스냅샷·되돌리기 사용${empty.length ? ` · 커밋이 없어 자동 커밋하지 않는 저장소: ${list(empty)}` : ''} · 저장소 밖 파일은 커밋하지 않음`
        : `하위 저장소(${list(empty)})에 커밋이 하나도 없습니다. 되돌릴 기준점이 없으므로 첫 커밋을 먼저 만드세요.` };
  }

  /** 운영 지시 전 필수 준비 항목(화면 표시와 서버 차단에 같은 기준을 쓴다). */
  async missionReadiness(projectId: string, refresh = false): Promise<MissionReadiness> {
    const p = this.store.getProject(projectId).plan;
    const agents = this.store.listAgents(projectId).filter((a) => a.active);
    const op = agents.find((a) => a.code === '00');
    const writers = agents.filter((a) => a.tools.includes('Edit') || a.tools.includes('Write'));
    const items: ReadinessItem[] = [
      { key: 'folder', label: '연결 폴더', ok: !!p.folder && existsSync(p.folder), detail: p.folder ? (existsSync(p.folder) ? p.folder : `폴더가 없습니다: ${p.folder}`) : '기획에서 Finder로 폴더를 선택하세요.', tab: 'plan' },
      { key: 'goal', label: '목표', ok: !!p.goal.trim(), detail: p.goal.trim() ? '입력됨' : '오퍼레이터가 계획·판단의 기준으로 씁니다.', tab: 'plan' },
      { key: 'done', label: '완료 조건', ok: !!p.doneCriteria.trim(), detail: p.doneCriteria.trim() ? '입력됨' : '무엇을 만족하면 완료인지 적어야 오퍼레이터가 완료를 판단합니다.', tab: 'plan' },
      ...(this.settings().gitCommits !== false ? [await this.gitItem(p.folder)] : []),
      { key: 'writable', label: '자동 수정 허용 경로', ok: p.writablePaths.length > 0, detail: p.writablePaths.length ? p.writablePaths.join(', ') : 'Agent가 고쳐도 되는 폴더를 하나 이상 고르세요.', tab: 'plan' },
      { key: 'operator', label: '오퍼레이터(00 총괄)', ok: !!op, detail: op ? `${op.code} ${op.name}` : '직원 탭의 기본 템플릿 불러오기에서 팀 구성을 고르거나 00 직원을 활성화하세요.', tab: 'agents' },
      { key: 'team', label: '작성·검토 직원', ok: writers.length >= 1 && agents.length >= 2, detail: `활성 ${agents.length}명 · 작성 가능 ${writers.length}명 (작성 1명 이상, 검토할 다른 직원 포함 2명 이상 필요)`, tab: 'agents' },
    ];
    if (this.settings().executor === 'claude') {
      const st = await this.cliStatus(refresh || !this.cli?.ready);
      const cx = await this.codexStatus(refresh || !this.codex?.ready);
      items.push({ key: 'claude', label: 'Claude CLI', ok: st.ready, detail: st.ready ? `준비됨 ${st.version ?? ''}` : `${st.problem ?? ''} ${st.fix ?? ''}`.trim(), tab: 'settings' });
      items.push({ key: 'codex', label: 'Codex CLI', ok: cx.ready, detail: cx.ready ? `준비됨 ${cx.version ?? ''}` : `${cx.problem ?? ''} ${cx.fix ?? ''}`.trim(), tab: 'settings' });
    }
    // 실행 준비(참고): 큰 작업 전에 미리 확인할 실행 환경. 부족해도 지시는 받되, 무엇이 막힐지 미리 보여 준다
    const st = this.settings();
    const shellAgents = agents.filter((a) => a.tools.includes('Bash') || (st.commandLevel && st.commandLevel !== 'low' && (a.tools.includes('Edit') || a.tools.includes('Write'))));
    let demo = { services: 0, apis: 0, errors: [] as string[] };
    try { const man = readManifest(p); demo = { services: man.services.length, apis: man.apis.length, errors: man.errors }; } catch { /* 목록 없음 */ }
    items.push({ key: 'exec', label: '실행 준비 · 명령', ok: true, info: true, detail: `명령 허용 범위 ${st.commandLevel === 'high' ? '높음' : st.commandLevel === 'medium' ? '중간' : '낮음'} · 명령을 실행할 수 있는 직원 ${shellAgents.length}명 · 로컬 포트 열기 ${st.testLocalSockets ? '허용' : '꺼짐(서버 시험·시연 불가)'}`, tab: 'settings' });
    items.push({ key: 'demo', label: '실행 준비 · 시연 환경', ok: true, info: true, detail: demo.services ? `시연 서비스 ${demo.services}개 · API 예시 ${demo.apis}개${demo.errors.length ? ` · 목록 오류 ${demo.errors.length}건` : ''}` : '시연 목록이 아직 없습니다. 첫 큰 기능을 만들 때 직원이 시연 환경을 함께 준비합니다.', tab: null });
    const b = this.missions.blocking(projectId);
    const activeMission = b ? { id: b.id, projectId: b.projectId, projectName: this.store.getProject(b.projectId).plan.name, status: b.status, sameProject: b.projectId === projectId } : null;
    if (b) items.push({ key: 'single', label: '작동 중인 미션 없음', ok: false, detail: b.projectId === projectId ? '이 프로젝트에 열려 있는 미션이 있습니다. 그 미션에 추가 지시하거나 종료하세요.' : `다른 프로젝트(${activeMission!.projectName})에서 미션이 작동 중입니다. 미션은 한 번에 하나만 작동합니다.`, tab: null });
    return { ready: items.every((i) => i.ok || i.info), items, activeMission };
  }

  /** 필수 항목이 하나라도 빠지면 지시를 받지 않는다(화면 우회 불가). */
  async startMission(projectId: string, prompt: string, limits?: Partial<MissionLimits> | null) {
    const r = await this.missionReadiness(projectId);
    const single = r.items.find((i) => i.key === 'single' && !i.ok);
    if (single) throw new Error(`${single.detail}${r.activeMission && !r.activeMission.sameProject ? ' 미션은 한 번에 하나만 작동합니다.' : ''}`);
    if (!r.ready) throw new Error(`지시하려면 먼저 설정하세요: ${r.items.filter((i) => !i.ok).map((i) => i.label).join(', ')}`);
    return this.missions.start(projectId, prompt, limits ?? null);
  }

  // ───── 설정 ─────
  settings(): AppSettings {
    const s = { ...DEFAULT_SETTINGS, ...this.store.getSetting<Partial<AppSettings>>('app', {}) };
    return { ...s, langsmithKeySet: !!this.langsmithKey() } as AppSettings;
  }
  saveSettings(p: Partial<AppSettings>, key?: string | null): AppSettings {
    const cur = this.settings();
    const next = { ...cur, ...p, missionMaxCycles: Math.min(50, Math.max(1, Math.floor(Number(p.missionMaxCycles ?? cur.missionMaxCycles)) || 5)), maxConcurrent: Math.min(16, Math.max(1, Math.floor(Number(p.maxConcurrent ?? cur.maxConcurrent)) || 1)) };
    if (p.devSyncHour !== undefined) next.devSyncHour = Math.min(23, Math.max(0, Math.floor(Number(p.devSyncHour)) || 0));
    if (p.paceReservePct !== undefined) next.paceReservePct = Math.min(50, Math.max(0, Math.round(Number(p.paceReservePct)) || 0));
    if (p.skillDirs !== undefined) next.skillDirs = Array.isArray(p.skillDirs) ? [...new Set(p.skillDirs.filter((x) => typeof x === 'string' && isAbsolute(x)))].slice(0, 20) : undefined;
    const { langsmithKeySet: _k, ...persist } = next;
    this.store.setSetting('app', persist);
    if (key !== undefined) { if (this.d.secretStore) this.d.secretStore.set(key); else this.memSecret = key; }
    return this.settings();
  }
  /** 명령 허용 범위: 설정값이 없거나 잘못되면 중간 */
  commandLevel(): CommandLevel { const v = this.settings().commandLevel; return COMMAND_LEVELS.includes(v as CommandLevel) ? (v as CommandLevel) : 'medium'; }
  /** 스킬 폴더: 설정값이 없으면 이 PC의 기본 위치 중 있는 것 */
  skillDirs(): string[] {
    const v = this.settings().skillDirs;
    return Array.isArray(v) ? v.filter((p) => typeof p === 'string' && isAbsolute(p)) : defaultSkillDirs();
  }
  skillSources(dirs: string[] | null): { dirs: string[]; sources: SkillSource[] } {
    const list = dirs ? dirs.filter((p) => typeof p === 'string' && isAbsolute(p)) : this.skillDirs();
    return { dirs: list, sources: describeSkillSources(list) };
  }
  langsmithKey(): string | null { return this.d.secretStore ? this.d.secretStore.get() : this.memSecret; }

  async cliStatus(refresh: boolean): Promise<CliStatus> {
    if (!this.cli || refresh) { this.cli = await checkCli(this.settings().cliPath); this.d.emit({ type: 'cli', status: this.cli }); }
    return this.cli;
  }

  // ───── 프로젝트 ─────
  createProject(plan: PlanFields) {
    const p = normalizePlan(plan);
    if (!p.name) throw new Error('프로젝트 이름을 입력하세요.');
    if (!p.folder || !existsSync(p.folder) || !statSync(p.folder).isDirectory()) throw new Error('연결할 프로젝트 폴더를 선택하세요.');
    return this.store.createProject(p);
  }
  updatePlan(id: string, plan: PlanFields) {
    // 앱 임시 폴더(격리 복사본 등) 경로는 참고 자료로 저장하지 않는다(지나면 사라지고, 격리 실행의 쓰기를 막음)
    const p = normalizePlan({ ...plan, referenceDocs: (plan.referenceDocs ?? []).filter((r) => !isAppTempPath(r)), priorOutputs: (plan.priorOutputs ?? []).filter((r) => !isAppTempPath(r)) });
    if (!p.name) throw new Error('프로젝트 이름을 입력하세요.');
    if (!p.folder || !existsSync(p.folder)) throw new Error('연결한 프로젝트 폴더가 없습니다.');
    return this.store.updatePlan(id, p);
  }

  // ───── 직원 ─────
  saveAgent(projectId: string, agentId: string | null, f: AgentFields): Agent {
    if (!f.name.trim()) throw new Error('직원 이름을 입력하세요.');
    if (f.reviewerAgentId && f.reviewerAgentId === agentId) throw new Error('자기 자신을 독립 검토 담당으로 지정할 수 없습니다.');
    for (const w of f.workPaths ?? []) if (escapes(w)) throw new Error(`프로젝트 밖을 가리키는 작업 폴더는 쓸 수 없습니다: ${w}`);
    const character = isCharacterId(f.character) ? f.character : undefined; // 캐릭터 번호는 정해진 20종만
    return this.store.saveAgent(projectId, agentId, { ...f, character, timeoutSec: Math.max(10, Number(f.timeoutSec) || 1800), maxRetries: Math.max(0, Math.min(10, Number(f.maxRetries) || 0)) });
  }
  duplicateAgent(agentId: string): Agent {
    const a = this.store.getAgent(agentId);
    const { id: _i, projectId, version: _v, updatedAt: _u, ...fields } = a;
    return this.store.saveAgent(projectId, null, { ...fields, name: `${fields.name} 복제` });
  }
  setAgentActive(agentId: string, active: boolean): Agent {
    const a = this.store.getAgent(agentId);
    const { id: _i, projectId, version: _v, updatedAt: _u, ...fields } = a;
    return this.store.saveAgent(projectId, agentId, { ...fields, active });
  }
  /** 해고: 지금 일하는 직원과, 작동 중인 미션의 오퍼레이터(00)는 해고하지 않는다. 기록은 남기고 목록·배정에서만 뺀다. */
  fireAgent(agentId: string): { cleared: string[] } {
    const a = this.store.getAgent(agentId);
    if (this.store.isFired(agentId)) throw new Error('이미 해고한 직원입니다.');
    if (this.missions.working(a.projectId).some((w) => w.agentId === agentId)) throw new Error(`${a.code} ${a.name}은(는) 지금 일하는 중입니다. 작업이 끝나거나 미션을 중단한 뒤 해고하세요.`);
    if (a.code === '00' && this.missions.list(a.projectId).some((m) => ['planning', 'running', 'evaluating'].includes(m.status))) throw new Error('작동 중인 미션의 오퍼레이터(00 총괄)는 해고할 수 없습니다. 미션을 먼저 중단하세요.');
    return { cleared: this.store.fireAgent(agentId) };
  }
  /**
   * 직원 제안 적용·무시. 새 직원은 비슷한 기존 직원의 도구만 물려받고(허용 명령·참고 자료·Bash·웹은 물려받지 않음), 기존 직원은 이름·역할·지시만 바꾼다.
   * 권한(도구·허용 명령)은 제안으로 바뀌지 않는다.
   */
  resolveStaffProposal(missionId: string, proposalId: string, action: 'apply' | 'dismiss', edit: { name: string; role: string; instructions: string } | null) {
    const m = this.missions.get(missionId);
    const p = (m.staffProposals ?? []).find((x) => x.id === proposalId);
    if (!p) throw new Error('직원 제안을 찾을 수 없습니다.');
    if (p.status !== 'pending') throw new Error('이미 처리한 직원 제안입니다.');
    if (action === 'dismiss') return this.missions.markStaffProposal(missionId, proposalId, 'dismissed', '');
    const name = (edit?.name ?? p.name).trim().slice(0, 60); const role = (edit?.role ?? p.role).trim().slice(0, 300); const instructions = (edit?.instructions ?? p.instructions).trim().slice(0, 6000);
    const agents = this.store.listAgents(m.projectId);
    if (p.kind === 'update') {
      const a = p.agentId ? agents.find((x) => x.id === p.agentId) : undefined;
      if (!a || this.store.isFired(a.id)) throw new Error(`제안할 때의 ${p.agentCode} 직원이 없습니다(해고됐거나 바뀜). 이 제안은 무시하세요.`);
      if (a.code === '00') throw new Error('오퍼레이터(00)는 제안으로 바꾸지 않습니다.');
      if (this.missions.working(m.projectId).some((w) => w.agentId === a.id)) throw new Error(`${a.code} ${a.name}은(는) 지금 일하는 중입니다. 작업이 끝난 뒤 적용하세요.`);
      const { id: _i, projectId: _p, version: _v, updatedAt: _u, fired: _f, ...fields } = a;
      this.saveAgent(m.projectId, a.id, { ...fields, name: name || a.name, role: role || a.role, instructions: instructions || a.instructions });
      return this.missions.markStaffProposal(missionId, proposalId, 'applied', `${a.code} ${name || a.name}의 역할·지시를 바꿈`);
    }
    if (!name) throw new Error('새 직원 이름을 입력하세요.');
    const base = p.agentId ? agents.find((x) => x.id === p.agentId && x.code !== '00' && !this.store.isFired(x.id)) : undefined;
    const used = new Set(agents.map((x) => x.code));
    let n = 1; while (used.has(String(n).padStart(2, '0'))) n++;
    const code = String(n).padStart(2, '0');
    const tools = (base?.tools ?? ['Read', 'Grep', 'Glob', 'Edit', 'Write']).filter((t) => t !== 'Bash' && t !== 'WebFetch' && t !== 'Skill');
    const a = this.saveAgent(m.projectId, null, {
      code, name, role, instructions, references: [], workPaths: p.workPaths, tools, allowedCommands: [],
      expectedOutput: base?.expectedOutput ?? '', doneCriteria: base?.doneCriteria ?? '', reviewerAgentId: base?.reviewerAgentId ?? null, model: base?.model ?? '', effort: base?.effort,
      maxBudgetUsd: base?.maxBudgetUsd ?? null, timeoutSec: base?.timeoutSec ?? 1800, maxRetries: base?.maxRetries ?? 1, active: true,
    });
    return this.missions.markStaffProposal(missionId, proposalId, 'applied', `새 직원 ${a.code} ${a.name} 추가`);
  }

  /**
   * 확인 필요 항목의 근거 위치 미리보기(읽기 전용). 경로는 프로젝트 폴더 기준이고, 못 찾으면 산출물·수정 허용 경로 아래에서 찾는다.
   * 실제 경로(링크를 따라간 경로)가 그 프로젝트 폴더·참고 자료 안일 때만 읽고, 비밀값은 가린다.
   */
  refSnippet(missionId: string, ref: string, line: number | null): RefSnippet {
    const m = this.missions.get(missionId);
    const plan = this.store.getProject(m.projectId).plan;
    const clean = ref.trim().replace(/^["'`]|["'`]$/g, '').slice(0, 1000);
    const empty = (note: string): RefSnippet => ({ path: clean, exists: false, start: 1, lines: [], target: null, total: 0, note });
    if (!clean || clean.includes('\0')) return empty('경로가 비어 있습니다.');
    const roots = [plan.folder, ...plan.referenceDocs, ...plan.priorOutputs, ...this.store.listAgents(m.projectId).flatMap((a) => a.references)].filter(Boolean)
      .map((r) => { try { return realpathSync(r); } catch { return null; } }).filter((r): r is string => !!r);
    const inside = (p: string) => roots.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
    const bases = isAbsolute(clean) ? [''] : [plan.folder, ...[plan.outputDir, ...plan.writablePaths].filter(Boolean).map((w) => join(plan.folder, w))];
    let abs: string | null = null;
    for (const b of bases) {
      const c = b ? join(b, clean) : clean;
      try { const r = realpathSync(c); if (inside(r) && statSync(r).isFile()) { abs = r; break; } } catch { /* 다음 후보 */ }
    }
    if (!abs) return empty('프로젝트 폴더·참고 자료 안에서 이 파일을 찾지 못했습니다(아직 없거나 경로가 다름).');
    // 확인한 파일과 읽는 파일이 같아야 한다: 연 뒤 다시 실제 경로·파일 번호를 대조해, 확인 사이에 링크로 바꿔치기한 경우 읽지 않는다
    let buf: Buffer;
    const fd = openSync(abs, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    try {
      const fst = fstatSync(fd);
      let again: string; try { again = realpathSync(abs); } catch { again = ''; }
      const st2 = again ? statSync(again) : null;
      if (!fst.isFile() || again !== abs || !inside(again) || !st2 || st2.ino !== fst.ino || st2.dev !== fst.dev) return empty('파일이 확인 중에 바뀌어 미리 볼 수 없습니다. 다시 눌러 주세요.');
      if (fst.size > 4 * 1024 * 1024) return { ...empty('파일이 커서 미리 볼 수 없습니다. 기본 앱으로 여세요.'), path: abs, exists: true };
      buf = Buffer.alloc(fst.size); let off = 0;
      while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) break; off += n; }
      buf = buf.subarray(0, off);
    } finally { closeSync(fd); }
    if (buf.includes(0)) return { ...empty('텍스트 파일이 아니어서 미리 볼 수 없습니다. 기본 앱으로 여세요.'), path: abs, exists: true };
    const all = redactKeepLines(buf.toString('utf8')).split(/\r?\n/); // 파일 전체를 먼저 가린 뒤 줄을 고른다(여러 줄 비밀값)
    const target = line && line >= 1 && line <= all.length ? Math.floor(line) : null;
    const start = target ? Math.max(1, target - 12) : 1;
    const end = target ? Math.min(all.length, target + 12) : Math.min(all.length, 40);
    return { path: abs, exists: true, start, lines: all.slice(start - 1, end).map((l) => l.slice(0, 400)), target, total: all.length };
  }

  /** 사용자가 확인해야 진행되는 항목(모든 프로젝트). 에이전트가 스스로 풀 수 없는 것을 먼저 보여 주는 데 쓴다. */
  attention(): Attention {
    const items: AttentionItem[] = [];
    for (const p of this.store.listProjects()) {
      for (const m of this.missions.list(p.id)) {
        if (m.status !== 'waiting_user') {
          // 진행 중·완료 보고 미션의 보류한 업무(나머지는 계속 진행): 사용자가 해결해야 다시 시도한다
          const open = (m.denials?.length ?? 0) + (m.blockers?.length ?? 0);
          if (open && !['stopped', 'failed'].includes(m.status)) items.push({ projectId: p.id, kind: m.denials?.length ? 'denied' : 'blocked', label: `보류한 업무 ${open}건 — 해결해야 다시 시도합니다(나머지 작업은 계속)`, missionId: m.id });
          const staff = (m.staffProposals ?? []).filter((x) => x.status === 'pending').length;
          if (staff && !['stopped', 'failed'].includes(m.status)) items.push({ projectId: p.id, kind: 'staff', label: `직원 제안 ${staff}건 — 적용할지 골라 주세요(진행은 계속)`, missionId: m.id });
          const pick = (m.gaps ?? []).filter((g) => g.options?.length).length;
          if (pick && !['stopped', 'failed'].includes(m.status)) items.push({ projectId: p.id, kind: 'gaps', label: `골라 줄 결정 ${pick}건 — 고르면 다음 계획부터 그대로 따릅니다(나머지 작업은 계속)`, missionId: m.id });
          continue;
        }
        const kind: AttentionItem['kind'] = m.checkpoint ? 'checkpoint' : m.denials?.length ? 'denied' : m.blockers?.length ? 'blocked' : m.gaps?.length ? 'gaps' : 'question';
        items.push({ projectId: p.id, kind, label: (m.question ?? '').split('\n')[0].slice(0, 140) || '오퍼레이터가 확인을 요청했습니다', missionId: m.id });
      }
      const missionRuns = new Set(this.missions.list(p.id).map((m) => m.currentRunId).filter(Boolean));
      for (const r of this.store.listRuns(p.id)) {
        if (r.status === 'review_wait') items.push({ projectId: p.id, kind: 'review', label: '팀장 검토를 기다립니다', runId: r.id });
        else if (r.status === 'needs_resume' && !this.engine.limitOf(r.id) && !missionRuns.has(r.id)) items.push({ projectId: p.id, kind: 'resume', label: '중단된 실행 — 재개 방법을 골라야 합니다', runId: r.id });
      }
    }
    const order: AttentionItem['kind'][] = ['checkpoint', 'denied', 'blocked', 'gaps', 'question', 'staff', 'resume', 'review'];
    items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    return { items, learningsToReview: this.learnings.toReview() };
  }

  /** 사용자가 버튼으로 고를 결정 목록(오퍼레이터 질문의 선택지, 근거 부족 항목의 선택지). 추천은 안내만 하고 고르지 않는다. */
  /** 사용자 확인함: 결정이 필요한 모든 항목(진행 중이어도). urgent는 미션 전체가 기다리는 것(팝업 대상). all은 이전 호출 호환용 */
  pendingDecisions(_all = false): PendingDecision[] {
    const out: PendingDecision[] = [];
    const asChoices = (choices: MissionChoice[] | null | undefined, options: string[] | null | undefined): MissionChoice[] =>
      choices?.length ? choices : (options ?? []).map((label) => ({ label, effect: '', recommended: false, why: '' }));
    for (const p of this.store.listProjects()) {
      for (const m of this.missions.list(p.id)) {
        const title = m.prompt.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 80) ?? '미션';
        const base = { projectId: p.id, projectName: p.plan.name, missionId: m.id, missionTitle: title, cycle: m.cycle };
        // 승인 커밋 요청은 미션이 멈춰 있어도 보여 준다(미션 진행과 따로 정할 수 있음). 승인 전에는 아무것도 커밋하지 않는다.
        for (const r of m.commitRequests ?? []) {
          if (r.status !== 'pending') continue;
          out.push({ ...base, key: `${m.id}|c|${r.id}`, kind: 'commit', task: `커밋 승인 요청 · 사이클 ${r.cycle}${r.task ? ` · ${r.task}` : ''}`, question: `${r.repo || '연결 폴더'} 저장소에 파일 ${r.files.length}개를 커밋할까요?`, explain: r.why, doc: '', issue: '', choices: [], waiting: false, commit: r });
        }
        // main 병합 요청: 큰 단원이 끝났을 때만 묻는다(유일하게 묻는 git 작업). 승인 전에는 아무것도 병합하지 않는다
        if (m.mergeRequest?.status === 'pending') {
          const r = m.mergeRequest;
          out.push({ ...base, key: `${m.id}|m|${r.id}`, kind: 'merge', task: `main 병합 · 사이클 ${r.cycle} · ${r.title}`, question: `큰 단원 '${r.title}'이(가) 끝났습니다. dev를 main에 병합할까요?`,
            explain: r.summary, doc: '', issue: '', waiting: false, urgent: false,
            resumes: '병합해도 개발은 계속됩니다. 병합하면 각 저장소의 dev를 main에 합쳐 push합니다(충돌한 저장소는 합치지 않고 알림).',
            choices: [{ label: 'main에 병합', effect: '저장소마다 dev를 main에 합쳐 push', why: '', recommended: false }, { label: '아직 아님', effect: '지금은 병합하지 않고 다음 큰 단원 때 다시 묻기', why: '', recommended: false }] });
        }
        if (['stopped', 'failed'].includes(m.status)) continue; // 완료 보고 미션도 남은 결정은 보여 준다
        // 확인함: 결정이 필요한 것은 모두 모은다(진행 중이어도). 팝업은 미션 전체가 그 결정을 기다릴 때(urgent)만 띄운다.
        const blocked = m.status === 'waiting_user' && m.pauseKind !== 'restart';
        const cpBlocks = blocked && !!m.checkpoint?.blocking; // 미션을 멈추게 한 검토 카드인가(정기 카드는 진행을 막지 않음)
        const shown = new Set<string>();
        if (m.checkpoint) {
          const c = m.checkpoint;
          for (const d of c.decisions) shown.add(`${d.doc}|${d.question}`);
          out.push({ ...base, key: `${m.id}|cp|${c.cycle}|${c.at}`, kind: 'checkpoint', task: `결과 검토 · 사이클 ${c.cycle}`, question: c.title, explain: `${c.features.length}개 기능 결과와 시연이 준비됐습니다.${c.decisions.length ? ` 정할 것 ${c.decisions.length}건.` : ''}${c.assumptions.length ? ` 가정하고 진행한 세부 ${c.assumptions.length}건.` : ''}`, doc: '', issue: '', choices: [], waiting: cpBlocks,
            urgent: cpBlocks, held: cpBlocks ? '이 결정 없이는 진행할 수 있는 작업이 없어 미션이 기다립니다.' : '개발은 계속 진행 중입니다. 시연을 보고 피드백·결정을 보내면 다음 계획부터 반영합니다.', resumes: cpBlocks ? '결정·피드백을 보내면 미션이 이어서 진행합니다.' : '피드백·결정은 다음 계획부터 반영(지금 실행은 그대로)' });
        }
        // 미션이 기다리는 질문은 선택지가 없어도 보여 준다(직접 적어 답한다). 앱 재시작은 사용자 결정이 아니므로 넣지 않는다.
        if (m.status === 'waiting_user' && m.question && !m.checkpoint?.blocking && m.pauseKind !== 'restart' && !(m.gaps?.length && !(m.questionOptions?.length))) {
          out.push({ ...base, key: `${m.id}|q|${m.cycle}|${m.question.slice(0, 200)}`, kind: 'question', task: `오퍼레이터 질문 · 사이클 ${m.cycle}`, question: m.question, explain: '', doc: '', issue: '', choices: asChoices(m.questionChoices, m.questionOptions), waiting: true,
            urgent: true, held: '진행할 수 있는 작업이 없어 미션 전체가 이 답을 기다립니다.', resumes: '답하면 미션이 이어서 진행합니다.' });
        }
        // 권한 때문에 보류한 업무: 그 업무만 빠지고 나머지는 계속 진행한다. 허용하면 그 직원에게만 허용하고 보류한 업무를 다시 시도한다.
        for (const d of m.pauseKind === 'restart' ? [] : m.denials ?? []) {
          const what = d.kind === 'command' ? `명령 '${d.suggestion ?? d.target}'` : d.kind === 'path' ? `경로 '${d.suggestion ?? d.target}' 읽기` : `${d.tool} 사용`;
          const allow: MissionChoice[] = d.suggestion && d.kind !== 'other' ? [{ label: d.kind === 'command' ? `${d.agent}에게 '${d.suggestion}' 허용` : `참고 자료로 '${d.suggestion}' 추가`, effect: d.kind === 'command' ? `허용 범위: ${d.agent} 한 명이 '${d.suggestion}'로 시작하는 명령을 격리 복사본 안에서 실행(다른 직원·다른 명령은 그대로 막힘). 보류한 업무를 다시 시도합니다.` : `허용 범위: 이 경로를 읽기 전용 참고 자료로 엶(쓰기는 그대로 막힘). 보류한 업무를 다시 시도합니다.`, recommended: false, why: '' }] : [];
          out.push({ ...base, key: `${m.id}|p|${d.sig}`, kind: 'permission', task: `보류한 업무 · ${d.agent} · ${d.tool}`, question: `${d.agent}이(가) ${what} 권한이 없어 이 업무를 보류했습니다. 허용할까요?`, explain: `거부된 요청: ${d.target}`, doc: '', issue: '', choices: [...allow, { label: '허용하지 않고 보류 유지', effect: '이 업무는 계속 보류하고 나머지 작업만 진행합니다.', recommended: false, why: '' }], waiting: blocked, denial: d,
            urgent: false, held: '권한이 없어 이 업무만 보류했습니다(나머지는 계속 진행).', resumes: `${d.agent}의 보류한 업무(허용하면 다음 계획부터 다시 시도)`, grants: allow.length ? allow[0].effect : undefined });
        }
        // 앱이 처리해 봤지만 꼭 필요한 권한(오퍼레이터 요청·같은 막힘 반복): 미션은 계속 진행하고, 허용하면 그 직원에게만 연다
        for (const a of m.pauseKind === 'restart' ? [] : m.permAsks ?? []) {
          const what = a.kind === 'path' ? `경로 '${a.suggestion}' 읽기` : `명령 '${a.suggestion}'`;
          const grant = a.kind === 'command' ? `허용 범위: ${a.agent} 한 명이 '${a.suggestion}'로 시작하는 명령을 격리 복사본 안에서 실행(다른 직원·다른 명령은 그대로 막힘).` : `허용 범위: 이 경로를 읽기 전용 참고 자료로 엶(쓰기는 그대로 막힘).`;
          out.push({ ...base, key: `${m.id}|pa|${a.sig}`, kind: 'permission', task: `권한 요청 · ${a.agent}`, question: `${a.agent}에게 ${what}을(를) 허용할까요?`, explain: `${a.why}${a.target && a.target !== a.suggestion ? `\n실제 명령: ${a.target}` : ''}`, doc: '', issue: '',
            choices: [{ label: a.kind === 'command' ? `${a.agent}에게 '${a.suggestion}' 허용` : `참고 자료로 '${a.suggestion}' 추가`, effect: grant, recommended: false, why: '' }, { label: '허용하지 않음', effect: '오퍼레이터가 이 방법 없이 진행합니다. 같은 요청은 다시 묻지 않습니다.', recommended: false, why: '' }],
            waiting: false, denial: a, urgent: false, held: '미션은 멈추지 않고 계속 진행 중입니다. 허용하면 다음 계획부터 이 방법을 씁니다.', resumes: '허용하면 다음 계획부터 이 직원이 이 방법을 씁니다', grants: grant });
        }
        // 환경 실패 등으로 보류한 업무(위쪽 막대의 '보류한 업무'와 같은 것): 사용자가 해결했다고 하면 다시 시도
        if (m.blockers?.length && !['stopped', 'failed'].includes(m.status)) {
          const list = m.blockers.map((b) => `- ${b.step}: ${b.reason}`).join('\n');
          out.push({ ...base, key: `${m.id}|bk|${m.blockers.length}|${m.blockers.map((b) => b.step).join('|').slice(0, 200)}`, kind: 'blocker', task: `보류한 업무 ${m.blockers.length}건`, question: '앱이 스스로 풀 수 없는 문제로 이 업무를 보류했습니다. 해결했으면 다시 시도할까요?', explain: list.slice(0, 3000), doc: '', issue: '',
            choices: [{ label: '해결했으니 다시 시도', effect: '다음 계획부터 보류한 업무를 다시 시도합니다.', recommended: false, why: '' }, { label: '보류 유지', effect: '보류한 채로 나머지 작업만 계속합니다.', recommended: false, why: '' }],
            waiting: blocked, urgent: false, held: '이 업무만 보류했습니다(나머지는 계속 진행).', resumes: '해결했다고 고르면 다음 계획부터 다시 시도합니다.' });
        }
        // 직원 제안(위쪽 막대의 '직원 제안'과 같은 것)
        for (const sp of (m.staffProposals ?? []).filter((x) => x.status === 'pending' && !['stopped', 'failed'].includes(m.status))) {
          out.push({ ...base, key: `${m.id}|sp|${sp.id}`, kind: 'staff', staffId: sp.id, task: `직원 제안 · ${sp.kind === 'add' ? '새 직원' : `${sp.agentCode} 변경`}`, question: sp.kind === 'add' ? `새 직원 '${sp.name}'(${sp.role})을(를) 둘까요?` : `${sp.agentCode} ${sp.name}의 역할·지시를 바꿀까요?`, explain: `${sp.reason}\n\n이름: ${sp.name}\n역할: ${sp.role}${sp.workPaths.length ? `\n작업 폴더: ${sp.workPaths.join(', ')}` : ''}\n\n업무 지시(적용될 전체):\n${sp.instructions}`, doc: '', issue: '',
            choices: [{ label: '제안 적용', effect: sp.kind === 'add' ? '이 직원을 추가합니다(도구·권한은 비슷한 기존 직원과 같게).' : '이 직원의 역할·지시를 제안대로 바꿉니다.', recommended: false, why: '' }, { label: '적용하지 않음', effect: '지금 직원으로 계속합니다.', recommended: false, why: '' }],
            waiting: false, urgent: false, held: '진행은 계속됩니다. 적용하면 다음 계획부터 반영됩니다.', resumes: '적용하면 운영 화면의 직원 제안 카드에서 고친 것과 같게 반영됩니다.' });
        }
        // 시연 실행 승인·다시 켜기: 지금 시연 목록의 내용이 확인 때와 같을 때만(바뀌었으면 다음 확인에서 다시 묻는다)
        for (const a of m.demoAsks ?? []) {
          let s: DemoService | undefined; try { s = readManifest(this.store.getProject(m.projectId).plan).services.find((x) => x.id === a.serviceId); } catch { s = undefined; }
          if (!s || serviceHash(s) !== a.hash) continue;
          const env = Object.entries(s.env).map(([k, v]) => `${k}=${redact(String(v))}`); // 승인 전에 전부 보여 준다(자르지 않음)
          const approve = a.kind === 'approve';
          const yes = approve ? '승인하고 켜기' : '다시 켜기'; const no = approve ? '지금은 켜지 않음' : '그대로 두기';
          const grant = approve ? `앱이 '${s.repo || '.'}' 폴더에서 이 명령으로 시연 서버를 켭니다(격리 밖, 이 PC의 127.0.0.1${s.port ? `:${s.port}` : ''}). 이후 포트만 바뀌면 다시 묻지 않고, 명령·폴더·환경값이 바뀌면 다시 묻습니다.` : '앱이 켠 이 서버를 끄고 같은 명령으로 다시 켭니다(사용자가 직접 띄운 서버는 건드리지 않음).';
          out.push({ ...base, key: `${m.id}|demo|${a.serviceId}|${a.kind}|${a.hash}`, kind: 'demo', task: `시연 · ${s.name}`, question: approve ? `시연 서버 '${s.name}'을(를) 켜도 될까요?` : `시연 서버 '${s.name}'을(를) 다시 켤까요?`,
            explain: [a.why, `명령: ${s.start.join(' ')}`, `폴더: ${s.repo || '.'}`, s.port ? `포트: ${s.port}` : '', env.length ? `환경값: ${env.join(', ')}` : ''].filter(Boolean).join('\n'), doc: '', issue: '',
            choices: [{ label: yes, effect: grant, recommended: false, why: '' }, { label: no, effect: approve ? '켜지 않습니다. 실서버 확인 없이 개발을 계속하고, 같은 내용은 다시 묻지 않습니다.' : '지금 서버를 그대로 둡니다. 같은 상태는 다시 묻지 않습니다.', recommended: false, why: '' }],
            waiting: false, urgent: false, demo: a, held: '시연 서버가 꺼져 있거나 예전 코드일 수 있어 실서버 확인이 멈춰 있습니다(개발은 계속).', resumes: '정하면 앱이 바로 켜고 다음 판단부터 실서버로 확인합니다.', grants: grant });
        }
        for (const g of m.pauseKind === 'restart' ? [] : m.gaps ?? []) {
          if ((shown.has(`${g.doc}|${g.issue}`) || [...shown].some((k) => sameQuestion(k.slice(k.indexOf('|') + 1), g.issue))) && !g.secret) continue; // 검토 카드에 이미 있는 결정은 한 번만(비밀값 입력은 확인함에서 받으므로 따로 보인다)
          const folder = this.store.getProject(m.projectId)?.plan.folder ?? '';
          const sp = g.secret ? resolveEnvPath(folder, g.secret.file) : null;
          const secret = g.secret ? { ...g.secret, saved: !!sp && 'abs' in sp && envHas(sp.abs, g.secret.name) } : undefined;
          out.push({ ...base, key: `${m.id}|g|${g.doc}|${g.issue}`, kind: 'gap', task: g.doc || '문서 미지정', question: g.issue, explain: g.explain ?? g.need ?? '', doc: g.doc, issue: g.issue, choices: asChoices(g.choices, g.options), waiting: blocked,
            urgent: blocked && !!g.blocking, held: g.blocking ? '이 결정에 달린 작업만 보류했습니다.' : '이 결정에 달린 부분만 보류하고 나머지는 계속 진행합니다.', resumes: '정하면 다음 계획부터 이 결정을 따릅니다.', ...(secret ? { secret } : {}) });
        }
      }
    }
    return out;
  }

  /**
   * 확인함 결정 적용(앱 화면·텔레그램 공통): 적용 직전에 각 항목이 아직 유효한지(같은 질문·같은 선택지인지) 다시 확인하고, 유효한 것만 반영한다.
   * 질문·결정·권한 항목만 다룬다(커밋 승인·검토 카드는 각자의 화면에서). 한 번 반영된 항목은 목록에서 빠지므로 같은 결정이 두 번 반영되지 않는다.
   * 추천 표시·미응답·시간 경과는 적용하지 않는다: 이 함수는 사용자가 고른 것만 받는다.
   */
  applyDecisions(picks: { key: string; choice: string; version?: string }[], via = '앱'): { applied: number; stale: number; lines: string[]; failed?: string[] } {
    const live = new Map(this.pendingDecisions().map((x) => [x.key, x]));
    const ok = (p: { key: string; choice: string; version?: string }) => {
      const it = live.get(p.key); const c = String(p.choice ?? '').trim();
      if (!it || !c || !['question', 'gap', 'permission', 'merge', 'demo', 'blocker', 'staff'].includes(it.kind)) return false;
      if (p.version && p.version !== decisionVersion(it)) return false; // 보여 준 뒤 질문·선택지가 바뀜
      if (['permission', 'merge', 'demo', 'blocker', 'staff'].includes(it.kind) && !it.choices.some((x) => x.label === c)) return false; // 권한·main 병합·시연 실행은 보여 준 선택지만
      // 비밀값 항목에 키처럼 보이는 글(공백·한글 없는 한 덩어리)을 답으로 적으면 기록에 남지 않게 받지 않는다(값은 '파일에 저장'으로만)
      if (it.secret && !it.choices.some((x) => x.label === c) && !/[\s가-힣]/.test(c)) return false;
      return true;
    };
    const go = picks.filter(ok); const stale = picks.length - go.length;
    const lines: string[] = []; const failed = new Set<string>(); // 적용하지 못한 항목(화면에서 처리됨으로 숨기지 않게)
    for (const missionId of [...new Set(go.map((p) => live.get(p.key)!.missionId))]) {
      const mine = go.filter((p) => live.get(p.key)!.missionId === missionId).map((p) => ({ it: live.get(p.key)!, choice: p.choice.trim() }));
      const title = mine[0].it.missionTitle;
      for (const x of mine.filter((y) => y.it.kind === 'merge')) {
        if (x.choice === 'main에 병합') { void this.mergeMain(missionId, via); lines.push(`· ${title}: main 병합을 시작합니다(${via}). 끝나면 결과를 알려 드립니다.`); }
        else { this.missions.setMergeRequest(missionId, { status: 'declined', via }); lines.push(`· ${title}: main 병합은 아직 하지 않습니다(${via}).`); }
      }
      for (const x of mine.filter((y) => y.it.kind === 'demo' && y.it.demo)) {
        const a = x.it.demo!; const yes = x.choice === x.it.choices[0].label;
        this.missions.resolveDemoAsk(missionId, a, yes);
        if (!yes) { lines.push(`· ${title}: 시연 '${a.name}'은(는) 켜지 않고 그대로 둡니다(${via}).`); continue; }
        void this.demoFromInbox(missionId, x.it.projectId, a, via);
        lines.push(`· ${title}: 시연 '${a.name}'을(를) ${a.kind === 'approve' ? '승인하고 켭니다' : '다시 켭니다'}(${via}). 결과는 진행 기록에 남깁니다.`);
      }
      for (const x of mine.filter((y) => y.it.kind === 'blocker')) {
        if (x.choice === x.it.choices[0].label) { this.missions.retryBlockers(missionId); lines.push(`· ${title}: 보류한 업무를 다음 계획부터 다시 시도합니다(${via}).`); }
        else lines.push(`· ${title}: 보류한 업무는 그대로 둡니다(${via}).`);
      }
      for (const x of mine.filter((y) => y.it.kind === 'staff' && y.it.staffId)) {
        const apply = x.choice === x.it.choices[0].label;
        try { this.resolveStaffProposal(missionId, x.it.staffId!, apply ? 'apply' : 'dismiss', null); lines.push(`· ${title}: 직원 제안을 ${apply ? '적용했습니다' : '적용하지 않았습니다'}(${via}).`); }
        catch (e) { failed.add(x.it.key); lines.push(`· ${title}: 직원 제안을 처리하지 못했습니다 — ${(e as Error).message}`); }
      }
      if (!mine.some((x) => !['merge', 'demo', 'blocker', 'staff'].includes(x.it.kind))) continue;
      const perms = mine.filter((x) => x.it.kind === 'permission'); const allowed = perms.filter((x) => !x.choice.startsWith('허용하지 않'));
      for (const x of allowed) this.allowDenial(x.it);
      for (const x of perms) if (x.it.key.includes('|pa|') && x.it.denial) this.missions.resolvePermAsk(missionId, x.it.denial.sig, !x.choice.startsWith('허용하지 않'));
      if (allowed.length) this.missions.retryParked(missionId, allowed.map((x) => x.it.denial!.sig));
      const withEffect = (x: { it: PendingDecision; choice: string }) => { const c = x.it.choices.find((y) => y.label === x.choice); return (c?.effect ? `${x.choice} — ${c.effect}` : x.choice).slice(0, 600); };
      const q = mine.find((x) => x.it.kind === 'question'); const gaps = mine.filter((x) => x.it.kind === 'gap');
      if (gaps.length) this.missions.decide(missionId, gaps.map((g) => ({ doc: g.it.doc, issue: g.it.issue, choice: withEffect(g) })), !q && gaps.some((g) => g.it.waiting));
      if (q) this.missions.answer(missionId, withEffect(q), 'continue', 'pending');
      const parts = [gaps.length && `결정 ${gaps.length}건`, q && '질문 답 1건', allowed.length && `권한 ${allowed.length}건 허용`, perms.length - allowed.length && `권한 ${perms.length - allowed.length}건 보류 유지`].filter(Boolean).join(', ');
      lines.push(`· ${title}: ${parts} 반영(${via}) → ${q || gaps.some((g) => g.it.waiting) ? '멈춰 있던 미션이 이어서 진행합니다' : '진행 중인 미션이 다음 계획부터 따릅니다'}${allowed.length ? ' · 보류한 업무를 다시 시도합니다' : ''}`);
    }
    return { applied: go.length - failed.size, stale: stale + failed.size, lines, failed: [...failed] };
  }
  /**
   * 확인함의 비밀값(API 키 등)을 연결 폴더의 .env 파일에 저장하고, 그 결정을 '넣었음'으로 처리한다.
   * 값은 파일에만 쓴다(미션 기록·로그·응답에는 변수 이름과 파일 위치만). git 저장소 안이면 그 파일이 .gitignore로 무시되는지 확인한 뒤에만 쓴다.
   */
  async saveSecret(inp: { key: string; file: string; name: string; value: string }): Promise<{ ok: true; line: string } | { ok: false; error: string }> {
    const it = this.pendingDecisions().find((x) => x.key === inp.key);
    if (!it || it.kind !== 'gap') return { ok: false, error: '이미 처리됐거나 없는 확인 항목입니다.' };
    const name = String(inp.name ?? '').trim(); const file = normEnvRel(inp.file);
    if (!VAR_NAME.test(name)) return { ok: false, error: '환경 변수 이름은 영문·숫자·밑줄만 쓸 수 있습니다(예: OPENAI_API_KEY).' };
    const bad = secretValueProblem(inp.value); if (bad) return { ok: false, error: bad };
    const folder = this.store.getProject(it.projectId)?.plan.folder ?? '';
    if (!folder || !existsSync(folder)) return { ok: false, error: '프로젝트 연결 폴더를 찾을 수 없습니다.' };
    const r = resolveEnvPath(folder, file); if ('error' in r) return { ok: false, error: `${file}: ${r.error}` };
    const repo = await gitRoot(dirname(r.abs));
    if (repo) {
      // 저장소 기준 경로를 직접 계산하지 않고 파일이 있는 폴더에서 이름으로 묻는다(Windows 짧은 경로 이름·구분자 차이로 어긋나지 않게)
      ensureSecretIgnore(repo);
      if (!(await gitIgnored(dirname(r.abs), basename(r.abs)))) return { ok: false, error: `${file}이(가) .gitignore로 무시되지 않아 커밋될 수 있어 저장하지 않았습니다. 저장소의 .gitignore를 확인하세요.` };
    }
    try { writeEnvVar(r.abs, name, inp.value); } catch (e) { return { ok: false, error: `파일에 쓰지 못했습니다: ${(e as NodeJS.ErrnoException).code ?? '알 수 없는 오류'}` }; }
    const choice = `넣었음 — ${file}의 ${name}에 저장(앱에서 입력, 값은 기록하지 않음)`;
    const res = this.applyDecisions([{ key: it.key, choice }], '앱');
    return { ok: true, line: `${file}의 ${name}에 저장했습니다(이 PC에만, 커밋 제외).${res.applied ? ' 이 결정은 \'넣었음\'으로 처리했습니다.' : ''}` };
  }
  /** 권한 보류 허용: 그 직원에게만 그 명령을 허용하거나, 그 경로를 읽기 전용 참고 자료로 연다 */
  private allowDenial(it: PendingDecision) {
    const d = it.denial; if (!d?.suggestion) return;
    if (d.kind === 'command') {
      const a = this.store.listAgents(it.projectId).find((x) => x.id === d.agentId);
      if (!a) throw new Error('직원을 찾을 수 없습니다(해고됐을 수 있음).');
      const { id: _i, projectId: _p, version: _v, updatedAt: _u, fired: _f, ...fields } = a as Agent & { fired?: unknown };
      this.saveAgent(it.projectId, a.id, { ...fields, tools: fields.tools.includes('Bash') ? fields.tools : [...fields.tools, 'Bash'], allowedCommands: fields.allowedCommands.includes(d.suggestion) ? fields.allowedCommands : [...fields.allowedCommands, d.suggestion] });
    } else if (d.kind === 'path') {
      const p = this.store.getProject(it.projectId);
      if (!p.plan.referenceDocs.includes(d.suggestion)) this.updatePlan(p.id, { ...p.plan, referenceDocs: [...p.plan.referenceDocs, d.suggestion] });
    }
  }

  // ───── 사용자 승인 커밋 ─────
  private commitReq(missionId: string, requestId: string): { req: MissionCommitRequest; folder: string; branch: string | undefined } {
    const m = this.missions.get(missionId);
    const req = (m.commitRequests ?? []).find((r) => r.id === requestId);
    if (!req) throw new Error('커밋 요청을 찾을 수 없습니다.');
    const folder = this.store.getProject(m.projectId).plan.folder;
    return { req, folder, branch: this.settings().autoAssist !== false ? workBranchName(m.id) : undefined };
  }
  async commitPreview(missionId: string, requestId: string): Promise<CommitPreview> {
    const { req, folder, branch } = this.commitReq(missionId, requestId);
    return { ...(await previewApprovedCommit(folder, req.repo, req.files, req.message, branch)), flagLabels: APPROVED_FLAG_LABEL };
  }
  /**
   * 사용자가 승인한 커밋(앱·텔레그램 공통): 보여 준 내용(hash)과 지금이 같을 때만 그 파일만 커밋한다. push·병합하지 않는다.
   * 같은 요청은 한 번만 실행한다(동시 승인·중복 클릭은 '처리 중/이미 처리'로 거절). 실행 중 앱이 꺼지면 재시작 때 실제 커밋 여부를 확인한다.
   */
  async commitApprove(missionId: string, requestId: string, shownHash: string, via = '앱'): Promise<MissionCommitRequest> {
    const { req, folder, branch } = this.commitReq(missionId, requestId);
    if (this.committing.has(requestId) || req.status === 'approving') throw new Error('이 커밋 요청은 지금 처리 중입니다.');
    if (req.status !== 'pending') throw new Error(`이미 처리한 커밋 요청입니다(${req.status === 'approved' ? `커밋됨 ${req.sha?.slice(0, 8) ?? ''}` : req.status === 'declined' ? '거절됨' : '실패'}).`);
    this.committing.add(requestId);
    this.missions.markCommitRequest(missionId, requestId, { status: 'approving', shownHash: String(shownHash ?? '') }, `커밋 승인(${via}): ${req.repo || '(연결 폴더)'} · "${req.message}" — 커밋하는 중`);
    try {
      const r = await commitApproved(folder, req.repo, req.files, req.message, String(shownHash ?? ''), { 'Crewgenai-Mission': missionId, 'Crewgenai-Approved': 'user', 'Crewgenai-Request': requestId }, branch);
      return this.missions.markCommitRequest(missionId, requestId, { status: 'approved', sha: r.sha, branch: r.branch, error: r.note }, `커밋 완료(${via} 승인): ${req.repo || '(연결 폴더)'} · "${req.message}" → ${r.branch ?? ''} ${r.sha.slice(0, 8)}${r.note ? ` (${r.note})` : ''}`);
    } catch (e) {
      const msg = (e as Error).message;
      // 보여 준 뒤 바뀐 경우는 요청을 승인 대기로 되돌려 새 내용으로 다시 확인하게 한다(다른 변경까지 커밋하지 않음). 그 밖의 실패는 기록한다.
      if (/바뀌었습니다|커밋할 수 없는 파일/.test(msg)) this.missions.markCommitRequest(missionId, requestId, { status: 'pending', shownHash: null }, `커밋하지 않음: 보여 준 뒤 변경 내용이 바뀌었습니다. 새 내용으로 다시 확인하세요.`);
      else this.missions.markCommitRequest(missionId, requestId, { status: 'failed', error: msg.slice(0, 500) }, `커밋 실패: "${req.message}" — ${msg.slice(0, 300)}`);
      throw e;
    } finally { this.committing.delete(requestId); }
  }
  private committing = new Set<string>();
  /** 앱 시작 때: 커밋하던 중 꺼진 요청은 저장소 기록(요청 표식)을 보고 실제로 커밋됐는지 확인해 정리한다(다시 커밋하지 않음) */
  async recoverCommits(): Promise<void> {
    for (const p of this.store.listProjects()) for (const m of this.missions.list(p.id)) for (const r of m.commitRequests ?? []) {
      if (r.status !== 'approving') continue;
      const found = await findRequestCommit(join(p.plan.folder, r.repo || '.'), r.id).catch(() => null);
      if (found) this.missions.markCommitRequest(m.id, r.id, { status: 'approved', sha: found.sha, branch: found.branch }, `커밋 확인(앱 재시작 후): "${r.message}" → ${found.branch ?? ''} ${found.sha.slice(0, 8)}`);
      else this.missions.markCommitRequest(m.id, r.id, { status: 'pending', shownHash: null }, `커밋하던 중 앱이 꺼져 커밋되지 않았습니다. 변경 내용을 다시 확인하고 승인하세요.`);
    }
  }
  /** 텔레그램 '변경 상세'용 코드 차이(비밀값 파일·줄 제외, 길이 제한, 한 번 더 가림) */
  async commitDiff(missionId: string, requestId: string): Promise<string> {
    const { req, folder, branch } = this.commitReq(missionId, requestId);
    return redactKeepLines(await approvedDiff(folder, req.repo, req.files, branch));
  }
  commitDecline(missionId: string, requestId: string): MissionCommitRequest {
    const { req } = this.commitReq(missionId, requestId);
    if (req.status !== 'pending') throw new Error('이미 처리한 커밋 요청입니다.');
    return this.missions.markCommitRequest(missionId, requestId, { status: 'declined' }, `커밋하지 않음(사용자 결정): ${req.repo || '(연결 폴더)'} · "${req.message}"`);
  }

  /** 배운 것 직접 추가·수정(사용자가 한 것이므로 검토한 것으로 본다) */
  saveLearning(id: string | null, f: LearningFields & { active?: boolean }): Learning {
    if (f.scope === 'project' && !f.projectId) throw new Error('프로젝트를 고르세요.');
    if (id) return this.learnings.update(id, { text: f.text, scope: f.scope, projectId: f.projectId, kind: f.kind, active: f.active ?? true, reviewed: true });
    const r = this.learnings.add(f, { source: '직접 입력', reviewed: true });
    if (!r) throw new Error('같은 내용이 이미 있거나 내용이 비어 있습니다.');
    return r;
  }

  agentTemplateSets() {
    return Object.values(TEMPLATE_SETS).map((t) => ({ id: t.id, label: t.label, description: t.description, agents: t.agents.map((a) => ({ code: a.code, name: a.name, role: a.role })) }));
  }
  /** 직원 기본 템플릿 세트를 불러온다. 같은 코드의 직원이 이미 있으면 건너뛰고(기존 직원은 바꾸지 않음), 이번에 만든 직원에만 기본 검토 담당을 배정한다. */
  loadAgentTemplates(projectId: string, setId: TemplateSetId = DEFAULT_TEMPLATE_SET): Agent[] {
    const set = TEMPLATE_SETS[setId];
    if (!set) throw new Error(`알 수 없는 템플릿 세트: ${setId}`);
    const existing = this.store.listAgents(projectId);
    const created: Agent[] = [];
    for (const t of set.agents) if (!existing.some((a) => a.code === t.code)) created.push(this.store.saveAgent(projectId, null, t));
    const all = this.store.listAgents(projectId);
    for (const a of created) {
      const rc = set.reviewers[a.code];
      const r = rc ? all.find((x) => x.code === rc) : undefined;
      if (r && r.id !== a.id) {
        const { id, projectId: pid, version: _v, updatedAt: _u, ...fields } = a;
        this.store.saveAgent(pid, id, { ...fields, reviewerAgentId: r.id });
      }
    }
    return this.store.listAgents(projectId);
  }

  // ───── 그래프 ─────
  validate(projectId: string, g: WorkGraph) { return validateGraph(g, this.store.listAgents(projectId), this.store.getProject(projectId).plan); }
  saveGraph(projectId: string, gIn: WorkGraph, note: string) {
    const g = needsLayout(gIn) ? autoLayout(gIn) : gIn; // 카드가 겹친 채 들어온 흐름은 정렬해서 저장
    const issues = this.validate(projectId, g);
    if (issues.some((i) => i.level === 'error')) return { version: null, issues };
    return { version: this.store.saveGraph(projectId, g, note), issues };
  }
  defaultGraph(projectId: string): WorkGraph {
    if (this.store.listAgents(projectId).length === 0) this.loadAgentTemplates(projectId);
    return defaultGraph(this.store.listAgents(projectId), this.store.getProject(projectId).plan);
  }

  // ───── 실행 ─────
  async startRun(projectId: string, graphVersionId: string) {
    const gv = this.store.getGraphVersion(graphVersionId);
    const issues = this.validate(projectId, gv.graph).filter((i) => i.level === 'error');
    if (issues.length) throw new Error(`흐름 검사 오류 ${issues.length}건: ${issues[0].message}`);
    if (this.settings().executor === 'claude') {
      const st = await this.cliStatus(!this.cli?.ready);
      if (!st.ready) throw new Error(`Claude CLI 준비 안 됨: ${st.problem ?? ''} ${st.fix ?? ''}`.trim());
    }
    return this.engine.startRun(projectId, graphVersionId);
  }
  submitReview(runId: string, nodeId: string, verdict: ReviewRecord['verdict'], comments: string, target: string | null, subject: string) {
    return this.engine.submitReview(runId, nodeId, verdict, comments, target, subject);
  }

  /** 앱이 열어도 되는 경로인지: 프로젝트 폴더·참고 자료·산출물·앱 문서 아래만 허용 */
  // ───── 프로젝트 완성 문서 세트 ─────
  private docTemplates() { return this.d.promptsDir ? loadTemplates(this.d.promptsDir) : []; }
  private docItems(pid: string): DocItem[] {
    this.store.db.exec('CREATE TABLE IF NOT EXISTS project_docs (project_id TEXT PRIMARY KEY, data TEXT)');
    const r = this.store.db.prepare('SELECT data FROM project_docs WHERE project_id=?').get(pid) as { data: string } | undefined;
    if (r) { try { return JSON.parse(r.data) as DocItem[]; } catch { /* 기본값 */ } }
    return defaultDocSet(this.docTemplates());
  }
  private putDocItems(pid: string, items: DocItem[]) {
    this.store.db.exec('CREATE TABLE IF NOT EXISTS project_docs (project_id TEXT PRIMARY KEY, data TEXT)');
    this.store.db.prepare('INSERT OR REPLACE INTO project_docs VALUES(?,?)').run(pid, JSON.stringify(items));
  }
  projectDocs(pid: string): ProjectDoc[] {
    const p = this.store.getProject(pid);
    return computeDocs(p.plan.folder, this.docItems(pid), this.docTemplates());
  }
  saveProjectDocs(pid: string, items: DocItem[]): ProjectDoc[] {
    this.store.getProject(pid);
    const ids = new Set<string>(); const paths = new Set<string>();
    const prev = new Map(this.docItems(pid).map((d) => [d.id, d]));
    const clean = items.map((d) => {
      const title = String(d.title ?? '').trim(); const path = safeRel(String(d.path ?? ''));
      if (!title) throw new Error('문서 이름을 입력하세요.');
      if (!path) throw new Error(`'${title}' 경로는 프로젝트 폴더 기준 상대 경로여야 합니다(예: docs/requirements.md).`);
      const id = String(d.id || randomUUID().slice(0, 8));
      if (ids.has(id)) throw new Error('같은 문서가 두 번 들어 있습니다.');
      if (paths.has(path)) throw new Error(`같은 경로를 두 문서가 쓰고 있습니다: ${path}`);
      ids.add(id); paths.add(path);
      const old = prev.get(id);
      // 경로가 바뀌면 이전 검토 표시는 무효
      const keep = old && old.path === path;
      return { id, title: title.slice(0, 120), path, templateId: d.templateId ?? null, instruction: String(d.instruction ?? '').slice(0, 20000), excluded: !!d.excluded,
        reviewedSha: keep ? old!.reviewedSha : null, reviewedAt: keep ? old!.reviewedAt : null } satisfies DocItem;
    });
    this.putDocItems(pid, clean);
    return this.projectDocs(pid);
  }
  reviewProjectDoc(pid: string, docId: string, reviewed: boolean): ProjectDoc[] {
    const items = this.docItems(pid);
    const cur = this.projectDocs(pid).find((d) => d.id === docId);
    const it = items.find((d) => d.id === docId);
    if (!it || !cur) throw new Error('문서를 찾을 수 없습니다.');
    if (reviewed && !cur.exists) throw new Error('파일이 없어 검토 완료로 표시할 수 없습니다.');
    it.reviewedSha = reviewed ? fileSha(cur.absPath) : null; it.reviewedAt = reviewed ? new Date().toISOString() : null;
    this.putDocItems(pid, items);
    return this.projectDocs(pid);
  }
  /** 고른 파일을 프로젝트 폴더의 문서 경로로 복사한다. 확장자가 다르면 문서 경로의 확장자를 올린 파일에 맞춘다. */
  uploadProjectDoc(pid: string, docId: string, src: string): ProjectDoc[] {
    const p = this.store.getProject(pid);
    if (!p.plan.folder || !existsSync(p.plan.folder)) throw new Error('먼저 프로젝트 폴더를 연결하세요.');
    const items = this.docItems(pid);
    const it = items.find((d) => d.id === docId);
    if (!it) throw new Error('문서를 찾을 수 없습니다.');
    const ext = extname(src).toLowerCase();
    if (!['.md', '.markdown', '.txt', '.pdf', '.csv', '.json'].includes(ext)) throw new Error('Markdown·텍스트·PDF·CSV·JSON 파일만 올릴 수 있습니다. Word 등은 Markdown이나 PDF로 바꿔 올려 주세요.');
    const st = statSync(src);
    if (!st.isFile()) throw new Error('파일을 골라 주세요.');
    if (st.size > 20_000_000) throw new Error('20MB보다 큰 파일은 올릴 수 없습니다.');
    let rel = it.path;
    if (extname(rel).toLowerCase() !== ext) rel = rel.slice(0, rel.length - extname(rel).length) + ext;
    const safe = safeRel(rel);
    if (!safe) throw new Error('문서 경로가 올바르지 않습니다.');
    const dest = join(p.plan.folder, ...safe.split('/'));
    // 프로젝트 폴더 밖으로 나가는 경로(심볼릭 링크 포함)는 거부
    mkdirSync(dirname(dest), { recursive: true });
    const realRoot = realpathSync(p.plan.folder); const realDir = realpathSync(dirname(dest));
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) throw new Error('프로젝트 폴더 밖으로는 복사할 수 없습니다.');
    if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error('문서 경로가 링크 파일이라 복사하지 않았습니다.');
    copyFileSync(src, dest);
    if (safe !== it.path) { it.path = safe; it.reviewedSha = null; it.reviewedAt = null; this.putDocItems(pid, items); }
    return this.projectDocs(pid);
  }

  resetProjectDocs(pid: string): ProjectDoc[] {
    this.store.db.exec('CREATE TABLE IF NOT EXISTS project_docs (project_id TEXT PRIMARY KEY, data TEXT)');
    this.store.db.prepare('DELETE FROM project_docs WHERE project_id=?').run(pid);
    return this.projectDocs(pid);
  }

  allowedPath(p: string, extraRoots: string[] = []): boolean {
    // 실제 경로(링크를 따라간 경로)로 비교한다: 링크로 밖을 가리키는 경로는 막고, 링크를 거쳐 고른 프로젝트 폴더는 통과
    const real = (x: string) => { // 아직 없는 경로는 있는 가장 가까운 상위 폴더까지 실제 경로로 바꿔 붙인다
      let cur = resolve(x); const rest: string[] = [];
      for (;;) { try { return join(realpathSync(cur), ...rest.reverse()); } catch { const up = dirname(cur); if (up === cur) return resolve(x); rest.push(cur.slice(up.length).replace(/^[\\/]+/, '')); cur = up; } }
    };
    const abs = real(p);
    const roots = [...extraRoots];
    for (const pr of this.store.listProjects()) roots.push(pr.plan.folder, ...pr.plan.referenceDocs, ...pr.plan.priorOutputs);
    for (const pr of this.store.listProjects()) for (const a of this.store.listAgents(pr.id)) roots.push(...a.references);
    return roots.filter(Boolean).some((r) => { const rr = real(r); return abs === rr || abs.startsWith(rr.endsWith(sep) ? rr : rr + sep); });
  }

  // ───── 시연 ─────
  private demoService(projectId: string, serviceId: string) {
    const plan = this.store.getProject(projectId).plan;
    const man = readManifest(plan);
    const s = man.services.find((x) => x.id === serviceId);
    if (!s) throw new Error(`시연 목록에 없는 서비스입니다: ${serviceId}${man.errors.length ? ` (목록 오류: ${man.errors[0]})` : ''}`);
    return { plan, man, s };
  }
  /** 확인함에서 고른 시연 실행: 보여 준 내용(확인값)과 지금 목록이 같을 때만 승인·실행한다 */
  private async demoFromInbox(missionId: string, projectId: string, a: DemoAsk, via: string): Promise<void> {
    const note = (t: string) => { try { this.missions.note(missionId, t); } catch { /* 미션 없음 */ } };
    try {
      const { man, plan, s } = this.demoService(projectId, a.serviceId);
      if (serviceHash(s) !== a.hash) { note(`시연 '${a.name}': 확인함에서 본 뒤 시연 목록이 바뀌어 켜지 않았습니다. 다음 확인에서 다시 묻습니다.`); return; }
      if (a.kind === 'approve') this.demo.approve(projectId, s, a.hash);
      else if (this.demo.ours(projectId, s.id)) { this.demo.stop(projectId, s.id); await new Promise((r) => setTimeout(r, 1500)); }
      await this.demo.start(projectId, man.services, s.id, new Set(), () => readManifest(plan).services);
      const code = s.port ? await this.demo.probe(s) : 200;
      note(`시연 '${a.name}'을(를) ${a.kind === 'approve' ? '승인하고 켰습니다' : '다시 켰습니다'}(${via})${s.port ? ` — 상태 확인 ${s.health || '/'}: ${code ?? '응답 없음'}` : ''}.`);
    } catch (e) { note(`시연 '${a.name}'을(를) 켜지 못했습니다: ${redact((e as Error).message).slice(0, 200)}`); }
  }
  demoInfo(projectId: string) { return demoInfo(this.demo, projectId, this.store.getProject(projectId).plan); }
  /** 사용자가 시연 명령 실행을 승인함(명령·폴더·환경값이 바뀌면 다시 승인) */
  demoApprove(projectId: string, serviceId: string, shownHash: string) { const { s } = this.demoService(projectId, serviceId); this.demo.approve(projectId, s, String(shownHash ?? '')); return this.demoInfo(projectId); }
  async demoStart(projectId: string, serviceId: string) { const { man, plan } = this.demoService(projectId, serviceId); await this.demo.start(projectId, man.services, serviceId, new Set(), () => readManifest(plan).services); return this.demoInfo(projectId); }
  demoStop(projectId: string, serviceId: string) { this.demo.stop(projectId, serviceId); return this.demoInfo(projectId); }
  demoLog(projectId: string, serviceId: string) { return this.demo.logTail(projectId, serviceId); }
  demoRequest(projectId: string, serviceId: string, req: { method: string; path: string; headers: Record<string, string>; body: string; capture?: Record<string, string> }) {
    const { s } = this.demoService(projectId, serviceId);
    if (!this.demo.approved(projectId, s)) throw new Error(`'${s.name}' 실행 승인이 필요합니다.`);
    return this.demo.request(projectId, s, req);
  }
  demoReset(projectId: string, serviceId: string) { this.demo.resetSession(projectId, serviceId); }

  // ───── 매일 dev 반영 ─────
  private devSyncing = false;
  private devSyncTimer: ReturnType<typeof setInterval> | null = null;
  private devState(): { lastDay: string | null; lastAt: string | null; results: DevSyncRepoResult[] } { return this.store.getSetting('devSyncState', { lastDay: null, lastAt: null, results: [] }); }
  devSyncStatus(): DevSyncView {
    const s = this.settings(); const st = this.devState();
    return { enabled: s.devSync !== false, hour: s.devSyncHour ?? 22, running: this.devSyncing, ...st };
  }
  /** 프로젝트들의 자동 수정 허용 경로에 든 저장소(실제 경로로 중복 제거) */
  private async devSyncRepos(): Promise<{ abs: string; label: string }[]> {
    const out = new Map<string, { abs: string; label: string }>();
    for (const p of this.store.listProjects()) {
      const f = p.plan.folder; if (!f || !existsSync(f)) continue;
      const ws = await workspaceRepos(f).catch(() => null); if (!ws) continue;
      const roots = (p.plan.writablePaths ?? []).map((w) => w.replace(/^\.\/?/, '').replace(/\/+$/, ''));
      for (const r of ws.repos) {
        if (!r.hasCommit) continue;
        const rel = r.rel.replace(/\/+$/, '');
        const writable = ws.mode === 'single' ? roots.length > 0 : roots.some((w) => w === rel || w.startsWith(`${rel}/`) || w === '' || w === '.');
        if (!writable) continue;
        let key = r.abs; try { key = realpathSync(r.abs); } catch { /* 그대로 */ }
        if (!out.has(key)) out.set(key, { abs: r.abs, label: rel || p.plan.name });
      }
    }
    return [...out.values()];
  }
  /** 하루 한 번: 비밀값을 뺀 변경을 커밋해 dev에 합치고 push(묻지 않음). main 병합은 하지 않는다 */
  async devSyncNow(): Promise<DevSyncView> {
    if (this.devSyncing) return this.devSyncStatus();
    this.devSyncing = true; this.d.emit({ type: 'devSync' });
    try {
      const d = new Date(); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const results: DevSyncRepoResult[] = [];
      for (const r of await this.devSyncRepos()) results.push(await syncRepoToDev(r.abs, r.label, day));
      this.store.setSetting('devSyncState', { lastDay: day, lastAt: new Date().toISOString(), results });
    } finally { this.devSyncing = false; this.d.emit({ type: 'devSync' }); }
    return this.devSyncStatus();
  }
  /** 승인한 main 병합: 먼저 오늘 변경을 dev에 반영한 뒤, 저장소마다 dev를 main에 합쳐 push한다 */
  async mergeMain(missionId: string, via = '앱'): Promise<void> {
    const m = this.missions.get(missionId); if (m.mergeRequest?.status !== 'pending') return;
    this.missions.setMergeRequest(missionId, { status: 'merging', via });
    try {
      await this.devSyncNow();
      const d = new Date(); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const results: DevSyncRepoResult[] = [];
      for (const r of await this.devSyncRepos()) results.push(await mergeDevToMain(r.abs, r.label, day));
      this.missions.setMergeRequest(missionId, { status: results.some((r) => r.status === 'failed') ? 'failed' : 'done', results });
    } catch (e) { this.missions.setMergeRequest(missionId, { status: 'failed', results: [{ repo: '(전체)', status: 'failed', note: String((e as Error).message ?? e).slice(0, 200), committed: 0, excluded: [], sha: null }] }); }
  }
  /** 정해진 시각이 지났고 오늘 아직 안 했으면 실행(앱이 꺼져 있었으면 켜진 뒤 실행). 앱 시작 때 main에서 켠다 */
  startDevSyncTimer() {
    const tick = () => {
      const s = this.settings(); if (s.devSync === false || this.devSyncing) return;
      const d = new Date(); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (d.getHours() >= (s.devSyncHour ?? 22) && this.devState().lastDay !== day) void this.devSyncNow().catch(() => {});
    };
    this.devSyncTimer = setInterval(tick, 10 * 60 * 1000); setTimeout(tick, 60 * 1000);
  }

  /** 사용량 속도 조절 판단(꺼져 있으면 null) */
  paceNow() {
    const s = this.settings();
    if (s.paceEnabled === false) return null;
    return paceDecision(usageSnapshot(), Date.now(), { ...DEFAULT_PACE, reserve: (s.paceReservePct ?? 10) / 100 });
  }
  usagePace(): UsagePaceView {
    const s = this.settings(); const snap = usageSnapshot(); const d = this.paceNow();
    const iso = (ms: number) => new Date(ms).toISOString();
    const w = (x: { utilization: number; resetsAt: number } | null) => (x ? { utilization: x.utilization, resetsAt: iso(x.resetsAt) } : null);
    const all = paceDecision(snap, Date.now(), { ...DEFAULT_PACE, reserve: (s.paceReservePct ?? 10) / 100 });
    return { enabled: s.paceEnabled !== false, reservePct: s.paceReservePct ?? 10, sevenDay: w(snap?.sevenDay ?? null), fiveHour: w(snap?.fiveHour ?? null), reportedAt: snap ? iso(snap.at) : null,
      waiting: !!d?.wait, until: d?.wait ? iso(d.until) : null, text: all.wait ? all.reason : all.note };
  }
  close() { if (this.devSyncTimer) clearInterval(this.devSyncTimer); this.offUsage(); this.demo.stopAll(); void this.missions.shutdown(0); this.engine.shutdown(); this.store.close(); }
  /** 앱 종료용: 프로세스 종료를 기다린 뒤 DB를 닫는다. */
  async closeGracefully() { if (this.devSyncTimer) clearInterval(this.devSyncTimer); this.offUsage(); this.demo.stopAll(); await this.missions.shutdown(); await this.engine.shutdownAndWait(); await gitShutdown(); this.store.close(); }
}
