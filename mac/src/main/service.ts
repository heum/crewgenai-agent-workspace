// 앱 기능 계층 — Electron과 분리돼 있어 시험에서 직접 구동할 수 있다.
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeDocs, defaultDocSet, loadTemplates, safeRel } from './docset';
import { fileSha } from './engine/fsutil';
import type { DocItem, ProjectDoc } from '../shared/types';
import type { Agent, AgentFields, AppSettings, CliStatus, CodexStatus, LiveEvent, MissionReadiness, PlanFields, ReadinessItem, ReviewRecord, WorkGraph } from '../shared/types';
import { checkCodex } from './cli/codexCli';
import { gitRoot, gitShutdown, workspaceRepos } from './git';
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
  cliPath: null, executor: 'claude', maxConcurrent: 3, codexPath: null, codexModel: 'gpt-6.1-sol', codexEffort: 'high', missionMaxCycles: 5, gitCommits: true, langsmithEnabled: false, langsmithProject: 'crewgenai-agent-workspace', langsmithEndpoint: 'https://api.smith.langchain.com',
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

export class Service {
  readonly store: Store;
  readonly engine: Engine;
  readonly missions: MissionRunner;
  private cli: CliStatus | null = null;
  private codex: CodexStatus | null = null;
  private memSecret: string | null = null;

  constructor(private d: ServiceDeps) {
    this.store = new Store(d.dbFile);
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
    });
    this.missions = new MissionRunner({
      store: this.store, engine: this.engine, emit: d.emit, mockScript: d.mockScript,
      executor: () => ({ executor: this.settings().executor, cliPath: this.cli?.path ?? this.settings().cliPath }),
      maxCycles: () => this.settings().missionMaxCycles || 5,
      gitCommits: () => this.settings().gitCommits !== false,
      ensureAgents: (pid) => (this.store.listAgents(pid).length ? this.store.listAgents(pid) : this.loadAgentTemplates(pid)),
      projectDocs: (pid) => this.projectDocs(pid),
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
    const b = this.missions.blocking(projectId);
    const activeMission = b ? { id: b.id, projectId: b.projectId, projectName: this.store.getProject(b.projectId).plan.name, status: b.status, sameProject: b.projectId === projectId } : null;
    if (b) items.push({ key: 'single', label: '작동 중인 미션 없음', ok: false, detail: b.projectId === projectId ? '이 프로젝트에 열려 있는 미션이 있습니다. 그 미션에 추가 지시하거나 종료하세요.' : `다른 프로젝트(${activeMission!.projectName})에서 미션이 작동 중입니다. 미션은 한 번에 하나만 작동합니다.`, tab: null });
    return { ready: items.every((i) => i.ok), items, activeMission };
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
    const { langsmithKeySet: _k, ...persist } = next;
    this.store.setSetting('app', persist);
    if (key !== undefined) { if (this.d.secretStore) this.d.secretStore.set(key); else this.memSecret = key; }
    return this.settings();
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
    const p = normalizePlan(plan);
    if (!p.name) throw new Error('프로젝트 이름을 입력하세요.');
    if (!p.folder || !existsSync(p.folder)) throw new Error('연결한 프로젝트 폴더가 없습니다.');
    return this.store.updatePlan(id, p);
  }

  // ───── 직원 ─────
  saveAgent(projectId: string, agentId: string | null, f: AgentFields): Agent {
    if (!f.name.trim()) throw new Error('직원 이름을 입력하세요.');
    if (f.reviewerAgentId && f.reviewerAgentId === agentId) throw new Error('자기 자신을 독립 검토 담당으로 지정할 수 없습니다.');
    for (const w of f.workPaths ?? []) if (escapes(w)) throw new Error(`프로젝트 밖을 가리키는 작업 폴더는 쓸 수 없습니다: ${w}`);
    return this.store.saveAgent(projectId, agentId, { ...f, timeoutSec: Math.max(10, Number(f.timeoutSec) || 1800), maxRetries: Math.max(0, Math.min(10, Number(f.maxRetries) || 0)) });
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
    const abs = resolve(p);
    const roots = [...extraRoots];
    for (const pr of this.store.listProjects()) roots.push(pr.plan.folder, ...pr.plan.referenceDocs, ...pr.plan.priorOutputs);
    for (const pr of this.store.listProjects()) for (const a of this.store.listAgents(pr.id)) roots.push(...a.references);
    return roots.filter(Boolean).some((r) => { const rr = resolve(r); return abs === rr || abs.startsWith(rr.endsWith(sep) ? rr : rr + sep); });
  }

  close() { void this.missions.shutdown(0); this.engine.shutdown(); this.store.close(); }
  /** 앱 종료용: 프로세스 종료를 기다린 뒤 DB를 닫는다. */
  async closeGracefully() { await this.missions.shutdown(); await this.engine.shutdownAndWait(); await gitShutdown(); this.store.close(); }
}
