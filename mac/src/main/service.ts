// 앱 기능 계층 — Electron과 분리돼 있어 시험에서 직접 구동할 수 있다.
import { closeSync, constants as fsc, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeDocs, defaultDocSet, loadTemplates, safeRel } from './docset';
import { fileSha, isAppTempPath } from './engine/fsutil';
import { DemoManager, demoInfo, readManifest, verifyDemo } from './demo';
import { isCharacterId } from '../shared/characterIds';
import type { Attention, AttentionItem, CommitPreview, Learning, LearningFields, DocItem, MissionChoice, MissionCommitRequest, PendingDecision, ProjectDoc, RefSnippet, SkillSource } from '../shared/types';
import { COMMAND_LEVELS, projectSkillDirs, workBranchName, type CommandLevel } from './autopilot';
import { defaultSkillDirs, describeSkillSources } from './skills';
import { redactKeepLines } from './cli/claudeCli';
import type { Agent, AgentFields, AppSettings, CliStatus, CodexStatus, LiveEvent, MissionReadiness, PlanFields, ReadinessItem, ReviewRecord, WorkGraph } from '../shared/types';
import { checkCodex } from './cli/codexCli';
import { APPROVED_FLAG_LABEL, commitApproved, gitRoot, gitShutdown, previewApprovedCommit, workspaceRepos } from './git';
import { LearningStore } from './learning';
import { MissionRunner } from './mission';
import { autoLayout, needsLayout } from '../shared/layout';
import { checkCli } from './cli/claudeCli';
import { Store } from './db';
import { NodeSqliteSaver } from './engine/checkpointer';
import { Engine, type Tracer } from './engine/engine';
import { DEFAULT_TEMPLATE_SET, TEMPLATE_SETS, defaultGraph, type TemplateSetId } from './engine/templates';
import { escapes, normRel, validateGraph } from './engine/validate';

export interface ServiceDeps {
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
  constructor(private d: ServiceDeps) {
    this.store = new Store(d.dbFile);
    this.demo = new DemoManager(this.store.db, join(dirname(d.dbFile), 'demo-logs'));
    this.learnings = new LearningStore(this.store.db);
    const saver = new NodeSqliteSaver(this.store.db);
    // 실행 이벤트를 화면으로 보내면서 미션 루프 다이어그램의 현재 단계도 갱신한다
    const emit = (e: LiveEvent) => { d.emit(e); try { this.missions?.onLive(e); } catch { /* 미션 갱신 실패는 실행에 영향 없음 */ } };
    this.engine = new Engine({
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
      demoVerify: (projectId) => verifyDemo(this.demo, projectId, this.store.getProject(projectId).plan),
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
  async startMission(projectId: string, prompt: string) {
    const r = await this.missionReadiness(projectId);
    const single = r.items.find((i) => i.key === 'single' && !i.ok);
    if (single) throw new Error(`${single.detail}${r.activeMission && !r.activeMission.sameProject ? ' 미션은 한 번에 하나만 작동합니다.' : ''}`);
    if (!r.ready) throw new Error(`지시하려면 먼저 설정하세요: ${r.items.filter((i) => !i.ok).map((i) => i.label).join(', ')}`);
    return this.missions.start(projectId, prompt);
  }

  // ───── 설정 ─────
  settings(): AppSettings {
    const s = { ...DEFAULT_SETTINGS, ...this.store.getSetting<Partial<AppSettings>>('app', {}) };
    return { ...s, langsmithKeySet: !!this.langsmithKey() } as AppSettings;
  }
  saveSettings(p: Partial<AppSettings>, key?: string | null): AppSettings {
    const cur = this.settings();
    const next = { ...cur, ...p, missionMaxCycles: Math.min(50, Math.max(1, Math.floor(Number(p.missionMaxCycles ?? cur.missionMaxCycles)) || 5)), maxConcurrent: Math.min(16, Math.max(1, Math.floor(Number(p.maxConcurrent ?? cur.maxConcurrent)) || 1)) };
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
        const kind: AttentionItem['kind'] = m.denials?.length ? 'denied' : m.blockers?.length ? 'blocked' : m.gaps?.length ? 'gaps' : 'question';
        items.push({ projectId: p.id, kind, label: (m.question ?? '').split('\n')[0].slice(0, 140) || '오퍼레이터가 확인을 요청했습니다', missionId: m.id });
      }
      const missionRuns = new Set(this.missions.list(p.id).map((m) => m.currentRunId).filter(Boolean));
      for (const r of this.store.listRuns(p.id)) {
        if (r.status === 'review_wait') items.push({ projectId: p.id, kind: 'review', label: '팀장 검토를 기다립니다', runId: r.id });
        else if (r.status === 'needs_resume' && !this.engine.limitOf(r.id) && !missionRuns.has(r.id)) items.push({ projectId: p.id, kind: 'resume', label: '중단된 실행 — 재개 방법을 골라야 합니다', runId: r.id });
      }
    }
    const order: AttentionItem['kind'][] = ['denied', 'blocked', 'gaps', 'question', 'staff', 'resume', 'review'];
    items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    return { items, learningsToReview: this.learnings.toReview() };
  }

  /** 사용자가 버튼으로 고를 결정 목록(오퍼레이터 질문의 선택지, 근거 부족 항목의 선택지). 추천은 안내만 하고 고르지 않는다. */
  pendingDecisions(): PendingDecision[] {
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
        if (['stopped', 'failed'].includes(m.status)) continue; // 완료 보고 미션도 남은 결정(근거 부족 항목)은 보여 준다
        // 미션이 기다리는 질문은 선택지가 없어도 보여 준다(직접 적어 답한다)
        // 검토 지점: 결과·시연·결정을 한곳(미션 화면 검토 카드)에서 보도록 팝업은 한 건으로 묶는다
        if (m.status === 'waiting_user' && m.checkpoint) {
          const c = m.checkpoint;
          out.push({ ...base, key: `${m.id}|cp|${c.cycle}|${c.at}`, kind: 'checkpoint', task: `검토 지점 · 사이클 ${c.cycle}`, question: c.title, explain: `${c.features.length}개 기능 결과와 시연이 준비됐습니다.${c.decisions.length ? ` 정할 것 ${c.decisions.length}건.` : ''}${c.assumptions.length ? ` 가정하고 진행한 세부 ${c.assumptions.length}건.` : ''} 미션 화면의 검토 카드에서 시연을 열어 보고 피드백·결정을 한 번에 보내세요.`, doc: '', issue: '', choices: [], waiting: true });
        }
        // 앱 재시작으로 잠시 멈춘 것은 사용자 결정이 아니므로 팝업으로 띄우지 않는다(미션 화면 알림)
        if (m.status === 'waiting_user' && m.question && !m.checkpoint && m.pauseKind !== 'restart' && !(m.gaps?.length && !(m.questionOptions?.length))) {
          out.push({ ...base, key: `${m.id}|q|${m.cycle}|${m.question.slice(0, 200)}`, kind: 'question', task: `오퍼레이터 질문 · 사이클 ${m.cycle}`, question: m.question, explain: '', doc: '', issue: '', choices: asChoices(m.questionChoices, m.questionOptions), waiting: true });
        }
        // 권한 때문에 보류한 업무: 허용하면 그 직원에게만 허용하고 다시 시도한다(허용 안 하면 보류 유지)
        // 권한 보류는 그 업무만 빼고 나머지가 계속 진행되므로 진행 중에는 팝업으로 띄우지 않고 검토 지점·확인 대기에 모아 보여 준다
        const showDenials = !['planning', 'running', 'evaluating'].includes(m.status) && m.pauseKind !== 'restart';
        for (const d of showDenials ? m.denials ?? [] : []) {
          const what = d.kind === 'command' ? `명령 '${d.suggestion ?? d.target}'` : d.kind === 'path' ? `경로 '${d.suggestion ?? d.target}' 읽기` : `${d.tool} 사용`;
          const allow: MissionChoice[] = d.suggestion && d.kind !== 'other' ? [{ label: d.kind === 'command' ? `${d.agent}에게 '${d.suggestion}' 허용` : `참고 자료로 '${d.suggestion}' 추가`, effect: d.kind === 'command' ? `이 직원만 이 명령을 쓸 수 있게 되고, 보류한 업무를 다시 시도합니다(격리 복사본 안에서 실행).` : `이 경로를 읽기 전용 참고 자료로 열고, 보류한 업무를 다시 시도합니다.`, recommended: false, why: '' }] : [];
          out.push({ ...base, key: `${m.id}|p|${d.sig}`, kind: 'permission', task: `보류한 업무 · ${d.agent} · ${d.tool}`, question: `${d.agent}이(가) ${what} 권한이 없어 이 업무를 보류했습니다. 허용할까요?`, explain: `거부된 요청: ${d.target}`, doc: '', issue: '', choices: [...allow, { label: '허용하지 않고 보류 유지', effect: '이 업무는 계속 보류하고 나머지 작업만 진행합니다. 나중에 미션 화면에서 다시 고를 수 있습니다.', recommended: false, why: '' }], waiting: m.status === 'waiting_user', denial: d });
        }
        for (const g of m.gaps ?? []) {
          if (!g.options?.length) continue;
          // 사람이 정할 결정은 검토 지점에 모아 보여 준다. 진행 중에는 그 결정 없이는 아무것도 못 할 때만 바로 묻는다.
          if (m.checkpoint || m.pauseKind === 'restart' || (['planning', 'running', 'evaluating'].includes(m.status) && !g.blocking)) continue;
          out.push({ ...base, key: `${m.id}|g|${g.doc}|${g.issue}`, kind: 'gap', task: g.doc || '문서 미지정', question: g.issue, explain: g.explain ?? g.need ?? '', doc: g.doc, issue: g.issue, choices: asChoices(g.choices, g.options), waiting: m.status === 'waiting_user' });
        }
      }
    }
    return out;
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
  /** 사용자가 팝업에서 승인한 커밋: 보여 준 내용(hash)과 지금이 같을 때만 그 파일만 커밋한다. push하지 않는다. */
  async commitApprove(missionId: string, requestId: string, shownHash: string): Promise<MissionCommitRequest> {
    const { req, folder, branch } = this.commitReq(missionId, requestId);
    if (req.status !== 'pending') throw new Error('이미 처리한 커밋 요청입니다.');
    try {
      const r = await commitApproved(folder, req.repo, req.files, req.message, String(shownHash ?? ''), { 'Crewgenai-Mission': missionId, 'Crewgenai-Approved': 'user' }, branch);
      return this.missions.markCommitRequest(missionId, requestId, { status: 'approved', sha: r.sha, branch: r.branch, error: r.note }, `커밋 승인: ${req.repo || '(연결 폴더)'} · "${req.message}" → ${r.branch ?? ''} ${r.sha.slice(0, 8)}${r.note ? ` (${r.note})` : ''}`);
    } catch (e) {
      const msg = (e as Error).message;
      // 보여 준 뒤 바뀐 경우는 요청을 그대로 두고 다시 확인하게 한다. 그 밖의 실패는 기록한다.
      if (!/바뀌었습니다|커밋할 수 없는 파일/.test(msg)) this.missions.markCommitRequest(missionId, requestId, { status: 'failed', error: msg.slice(0, 500) }, `커밋 실패: "${req.message}" — ${msg.slice(0, 300)}`);
      throw e;
    }
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

  close() { this.demo.stopAll(); void this.missions.shutdown(0); this.engine.shutdown(); this.store.close(); }
  /** 앱 종료용: 프로세스 종료를 기다린 뒤 DB를 닫는다. */
  async closeGracefully() { this.demo.stopAll(); await this.missions.shutdown(); await this.engine.shutdownAndWait(); await gitShutdown(); this.store.close(); }
}
