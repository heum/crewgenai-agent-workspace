// 시연 환경: 직원이 프로젝트 안 시연 목록 파일(<결과물 폴더>/demo/demo-services.json)에 등록한 웹·API·관리 화면 서비스를
// 앱이 직접 켜고 끄며 상태(실행 중·시작 중·중지됨·준비 필요)를 보여 준다. 사용자는 결과물 카드의 '시연 열기'로 바로 써 본다.
// 보안: 시연 명령은 격리(샌드박스) 밖에서 이 PC 권한으로 돈다. 그래서 서비스마다 처음 한 번(명령·폴더·환경값이 바뀌면 다시) 사용자 승인을 받는다.
// 명령은 저장소 안의 실행 파일(링크 아님) 또는 정해진 실행기(npm·node 등)만, 주소는 이 컴퓨터(127.0.0.1)만, 환경값에 비밀값 이름은 받지 않는다.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DemoApi, DemoData, DemoInfo, DemoResponse, DemoService, DemoState, PlanFields } from '../shared/types';
import { cleanEnv, redact } from './cli/claudeCli';

export const DEMO_FILE = 'demo/demo-services.json';
export function demoManifestPath(plan: PlanFields): string { return join(plan.folder, plan.outputDir || 'crewgenai-output', DEMO_FILE); }

const RUNNERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'node', 'java', 'python3', 'deno', 'bun']);
const SECRET_KEY = /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL)/i;
const DATA: DemoData[] = ['api+db', 'screen-only', 'mock'];

function real(p: string) { try { return realpathSync(p); } catch { return resolve(p); } }
function inside(root: string, p: string) { const r = relative(real(root), real(p)); return !!r && !r.startsWith('..') && !isAbsolute(r); }
function str(v: unknown, max = 400) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

/** 시연 목록 파일을 읽고 검사한다. 잘못된 항목은 버리고 이유를 errors에 남긴다. */
export function readManifest(plan: PlanFields): { services: DemoService[]; apis: DemoApi[]; errors: string[]; path: string; exists: boolean } {
  const path = demoManifestPath(plan);
  const out = { services: [] as DemoService[], apis: [] as DemoApi[], errors: [] as string[], path, exists: existsSync(path) };
  if (!out.exists) return out;
  let raw: { services?: unknown[]; apis?: unknown[] };
  try {
    if (lstatSync(path).isSymbolicLink() || statSync(path).size > 512_000) throw new Error('링크이거나 너무 큰 파일');
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) { out.errors.push(`시연 목록 파일을 읽지 못했습니다: ${(e as Error).message}`); return out; }
  for (const s of (Array.isArray(raw.services) ? raw.services : []).slice(0, 12) as Record<string, unknown>[]) {
    const id = str(s.id, 40); const name = str(s.name, 60) || id;
    const bad = (why: string) => out.errors.push(`서비스 ${id || '(이름 없음)'}: ${why}`);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) { bad('id는 영문 소문자·숫자·-만'); continue; }
    if (out.services.some((x) => x.id === id)) { bad('같은 id가 두 번 있음'); continue; }
    const repo = str(s.repo, 200);
    const cwd = resolve(plan.folder, repo || '.');
    if (repo && (isAbsolute(repo) || !inside(plan.folder, cwd))) { bad('repo는 프로젝트 폴더 안의 상대 경로여야 함'); continue; }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) { bad(`폴더가 없음: ${repo}`); continue; }
    const start = (Array.isArray(s.start) ? s.start : []).map((x) => String(x)).slice(0, 20);
    if (!start.length || start.some((a) => a.length > 300 || /[\n\r\0]/.test(a))) { bad('start는 실행 파일과 인자 배열이어야 함'); continue; }
    const exe = start[0];
    if (!RUNNERS.has(exe)) {
      const p = resolve(cwd, exe);
      let ok = false; try { const st = lstatSync(p); ok = st.isFile() && !st.isSymbolicLink() && inside(cwd, p); } catch { ok = false; }
      if (!(exe.startsWith('./') || exe.startsWith('.\\')) || !ok) { bad(`실행 파일은 저장소 안의 ./스크립트(링크 아님) 또는 ${[...RUNNERS].join('·')}만 가능: ${exe}`); continue; }
    }
    const port = Number(s.port ?? 0);
    if (port && (!Number.isInteger(port) || port < 1024 || port > 65535)) { bad('port는 1024~65535'); continue; }
    const health = str(s.health, 200) || '/';
    if (!health.startsWith('/')) { bad('health는 /로 시작하는 경로'); continue; }
    const env: Record<string, string> = {};
    let envBad = '';
    for (const [k, v] of Object.entries((s.env && typeof s.env === 'object' ? s.env : {}) as Record<string, unknown>).slice(0, 20)) {
      if (!/^[A-Z_][A-Z0-9_]{0,60}$/.test(k)) { envBad = `환경값 이름이 올바르지 않음: ${k}`; break; }
      if (SECRET_KEY.test(k)) { envBad = `비밀값으로 보이는 환경값은 목록에 넣지 않음(시연용 설정 파일·프로필로): ${k}`; break; }
      env[k] = String(v).slice(0, 300);
    }
    if (envBad) { bad(envBad); continue; }
    const kind = (['web', 'api', 'admin', 'app'] as const).find((k) => k === s.kind) ?? (port ? 'web' : 'app');
    const data = DATA.find((d) => d === s.data) ?? 'screen-only';
    const needs = (Array.isArray(s.needs) ? s.needs : []).map((x) => String(x)).slice(0, 6);
    out.services.push({ id, name, kind, repo, cwd, start, port: port || null, health, env, data, needs, note: str(s.note, 300), startupSec: Math.min(600, Math.max(10, Number(s.startupSec) || 180)) });
  }
  for (const a of (Array.isArray(raw.apis) ? raw.apis : []).slice(0, 80) as Record<string, unknown>[]) {
    const service = str(a.service, 40); const id = str(a.id, 60);
    const method = str(a.method, 8).toUpperCase() || 'GET';
    const path2 = str(a.path, 400);
    if (!out.services.some((x) => x.id === service && x.port)) { out.errors.push(`API ${id}: 포트가 있는 서비스(${service})가 목록에 없음`); continue; }
    if (!id || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method) || !path2.startsWith('/')) { out.errors.push(`API ${id || '(이름 없음)'}: id·method·path(/로 시작) 확인`); continue; }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((a.headers && typeof a.headers === 'object' ? a.headers : {}) as Record<string, unknown>).slice(0, 12)) headers[String(k).slice(0, 60)] = String(v).slice(0, 400);
    const capture: Record<string, string> = {};
    for (const [k, v] of Object.entries((a.capture && typeof a.capture === 'object' ? a.capture : {}) as Record<string, unknown>).slice(0, 6)) if (/^[a-zA-Z_]\w{0,30}$/.test(k)) capture[k] = String(v).slice(0, 120);
    out.apis.push({ service, id, group: str(a.group, 60) || '기타', title: str(a.title, 100) || `${method} ${path2}`, method, path: path2, headers, body: a.body === undefined || a.body === null ? '' : typeof a.body === 'string' ? a.body.slice(0, 20000) : JSON.stringify(a.body, null, 2).slice(0, 20000), description: str(a.description, 800), expect: str(a.expect, 400), capture });
  }
  return out;
}

/** 승인 기준: 명령·폴더·환경값·포트가 같아야 이전 승인이 유효하다 */
export function serviceHash(s: DemoService) { return createHash('sha256').update(JSON.stringify([real(s.cwd), s.start, s.env, s.port])).digest('hex').slice(0, 24); }

/** 프로세스와 그 하위 프로세스를 함께 끈다(Windows) */
function killTree(pid: number) { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 이미 끝남 */ } }

type Proc = { child: ChildProcess; startedAt: number; log: string; exited: number | null };

export class DemoManager {
  private procs = new Map<string, Proc>();
  private jars = new Map<string, Map<string, string>>(); // 서비스별 쿠키(시연 로그인 유지)
  private vars = new Map<string, Record<string, string>>(); // 응답에서 잡아 둔 값(예: 시연 토큰)
  constructor(private db: DatabaseSync, private logDir: string) {
    db.exec('CREATE TABLE IF NOT EXISTS demo_approvals (project_id TEXT, service_id TEXT, hash TEXT, approved_at TEXT, PRIMARY KEY(project_id, service_id))');
  }
  private key(projectId: string, id: string) { return `${projectId}:${id}`; }
  approved(projectId: string, s: DemoService) {
    const r = this.db.prepare('SELECT hash FROM demo_approvals WHERE project_id=? AND service_id=?').get(projectId, s.id) as { hash?: string } | undefined;
    return r?.hash === serviceHash(s);
  }
  /** shownHash: 사용자가 승인 창에서 본 명령의 확인값. 그 사이 목록이 바뀌었으면 승인하지 않는다. */
  approve(projectId: string, s: DemoService, shownHash?: string) {
    if (shownHash !== undefined && shownHash !== serviceHash(s)) throw new Error('승인 창을 연 뒤 시연 목록의 명령·폴더·환경값이 바뀌었습니다. 다시 열어 바뀐 내용을 확인하세요.');
    this.db.prepare('INSERT OR REPLACE INTO demo_approvals VALUES(?,?,?,?)').run(projectId, s.id, serviceHash(s), new Date().toISOString());
  }

  async health(s: DemoService): Promise<boolean> {
    if (!s.port) return false;
    try {
      const ctl = AbortSignal.timeout(1500);
      const r = await fetch(`http://127.0.0.1:${s.port}${s.health}`, { signal: ctl, redirect: 'manual' });
      return r.status < 500;
    } catch { return false; }
  }

  async state(projectId: string, s: DemoService): Promise<DemoState> {
    const p = this.procs.get(this.key(projectId, s.id));
    const alive = !!p && p.exited === null;
    const up = await this.health(s);
    const ours = alive;
    const approved = this.approved(projectId, s);
    let status: DemoState['status'];
    if (up || (alive && !s.port)) status = 'running';
    else if (alive) status = 'starting';
    else if (!approved) status = 'needs_approval';
    else status = 'stopped';
    return { service: s, hash: serviceHash(s), status, approved, ours, url: s.port ? `http://127.0.0.1:${s.port}` : null, exitCode: p?.exited ?? null, startedAt: p ? new Date(p.startedAt).toISOString() : null };
  }

  /** 서비스를 켠다(필요한 서비스 먼저). 승인되지 않은 서비스는 켜지 않는다. 이미 떠 있으면 그대로 둔다. */
  async start(projectId: string, all: DemoService[], id: string, seen = new Set<string>(), recheck?: () => DemoService[]): Promise<void> {
    const s = all.find((x) => x.id === id); if (!s) throw new Error(`시연 서비스가 없습니다: ${id}`);
    if (seen.has(id)) return; seen.add(id);
    for (const n of s.needs) await this.start(projectId, all, n, seen, recheck);
    if (!this.approved(projectId, s)) throw new Error(`'${s.name}' 실행 승인이 필요합니다.`);
    if (await this.health(s)) {
      // 이미 응답하는 서버가 직원 임시 복사본에서 띄운 것이면 실제 저장소 코드가 아니므로 끄고 새로 켠다(사용자가 띄운 서버는 그대로)
      const ours = this.procs.get(this.key(projectId, s.id)); const own = s.port && !(ours && ours.exited === null) ? portOwner(s.port) : null;
      if (!own || !staleCopyServer(own.cwd) || !s.port) return;
      const port = s.port;
      try { process.kill(own.pid, 'SIGTERM'); } catch { /* 이미 끝남 */ }
      for (let i = 0; i < 20 && portOwner(port); i++) await new Promise((r) => setTimeout(r, 500));
      if (portOwner(port)) { try { process.kill(own.pid, 'SIGKILL'); } catch { /* 끝남 */ } await new Promise((r) => setTimeout(r, 800)); }
    }
    const k = this.key(projectId, s.id);
    const cur = this.procs.get(k); if (cur && cur.exited === null) return;
    // 실행 직전에 목록을 다시 읽어 검사한다(기다리는 사이 명령·스크립트가 바뀌었으면 실행하지 않음)
    if (recheck) { const now = recheck().find((x) => x.id === s.id); if (!now || serviceHash(now) !== serviceHash(s) || !this.approved(projectId, now)) throw new Error(`'${s.name}' 시연 목록이 바뀌었거나 검사를 통과하지 못했습니다. 다시 확인한 뒤 시작하세요.`); }
    mkdirSync(this.logDir, { recursive: true });
    const log = join(this.logDir, `${projectId.slice(0, 8)}-${s.id}.log`);
    const fd = openSync(log, 'w', 0o600);
    writeSync(fd, `# ${new Date().toISOString()} ${s.start.join(' ')} (폴더 ${s.repo || '.'})\n`);
    const env = cleanEnv({ ...s.env, ...(s.port ? { PORT: String(s.port) } : {}) });
    // Windows: npm·npx·pnpm·yarn은 .cmd 실행 파일이다. 프로세스 묶음 정리는 taskkill /T로 한다.
    const exe = ['npm', 'npx', 'pnpm', 'yarn'].includes(s.start[0]) ? `${s.start[0]}.cmd` : s.start[0];
    const child = spawn(exe, s.start.slice(1), { cwd: s.cwd, env, detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // 서비스 출력은 비밀값을 가린 뒤 기록에 쓴다(시작 때 찍힌 비밀번호·토큰이 파일에 남지 않게)
    const write = (b: Buffer) => { try { writeSync(fd, redact(b.toString('utf8'))); } catch { /* 기록 실패는 실행에 영향 없음 */ } };
    child.stdout?.on('data', write); child.stderr?.on('data', write);
    const p: Proc = { child, startedAt: Date.now(), log, exited: null };
    child.on('close', () => { try { closeSync(fd); } catch { /* 닫힘 */ } });
    child.on('exit', (code) => { p.exited = code ?? -1; });
    child.on('error', () => { p.exited = -1; });
    this.procs.set(k, p);
    if (!s.port) return;
    const until = Date.now() + s.startupSec * 1000;
    while (Date.now() < until) {
      if (p.exited !== null) throw new Error(`'${s.name}'이(가) 시작 중에 끝났습니다(종료 코드 ${p.exited}). 시연 기록을 확인하세요.`);
      if (await this.health(s)) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`'${s.name}'이(가) ${s.startupSec}초 안에 응답하지 않았습니다. 시연 기록을 확인하세요.`);
  }

  /** 앱이 켠 서비스만 끈다(사용자가 따로 띄운 서비스는 건드리지 않는다) */
  stop(projectId: string, id: string): boolean {
    const p = this.procs.get(this.key(projectId, id));
    if (!p || !p.child.pid) return false;
    killTree(p.child.pid);
    this.procs.delete(this.key(projectId, id));
    return true;
  }
  stopAll() { for (const [k, p] of this.procs) { if (p.child.pid) killTree(p.child.pid); this.procs.delete(k); } }

  logTail(projectId: string, id: string, max = 12000): string {
    const p = this.procs.get(this.key(projectId, id)); if (!p) return '';
    try { const t = readFileSync(p.log, 'utf8'); return redact(t.slice(-max)); } catch { return ''; }
  }

  /** API 시연 요청: 그 서비스의 127.0.0.1 포트로만 보낸다. 쿠키와 잡아 둔 값({{이름}})을 서비스별로 유지한다. */
  async request(projectId: string, s: DemoService, req: { method: string; path: string; headers: Record<string, string>; body: string; capture?: Record<string, string> }): Promise<DemoResponse> {
    if (!s.port) throw new Error('포트가 없는 서비스에는 요청할 수 없습니다.');
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(req.method)) throw new Error('지원하지 않는 요청 방식입니다.');
    if (!req.path.startsWith('/') || req.path.startsWith('//') || req.path.includes('\\')) throw new Error('경로는 /로 시작해야 합니다.');
    const k = this.key(projectId, s.id);
    const vars = this.vars.get(k) ?? {}; const fill = (t: string) => t.replace(/\{\{(\w+)\}\}/g, (_, n) => vars[n] ?? `{{${n}}}`);
    const jar = this.jars.get(k) ?? new Map<string, string>(); this.jars.set(k, jar);
    const headers: Record<string, string> = {};
    for (const [h, v] of Object.entries(req.headers ?? {})) if (/^[A-Za-z0-9-]{1,60}$/.test(h) && !/^(host|cookie|content-length)$/i.test(h)) headers[h] = fill(String(v));
    if (jar.size) headers.Cookie = [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
    const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : fill(req.body ?? '');
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    const t0 = Date.now();
    const filled = fill(req.path);
    if (!filled.startsWith('/') || filled.startsWith('//') || filled.includes('\\')) throw new Error('경로는 /로 시작하는 이 서비스 안의 경로여야 합니다.');
    const url = new URL(filled, `http://127.0.0.1:${s.port}`);
    if (url.protocol !== 'http:' || url.host !== `127.0.0.1:${s.port}`) throw new Error('시연 요청은 이 서비스(127.0.0.1)로만 보낼 수 있습니다.');
    const r = await fetch(url, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    for (const c of r.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); const i = pair.indexOf('='); if (i > 0) { const n = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (v) jar.set(n, v); else jar.delete(n); } }
    const text = (await r.text()).slice(0, 200_000);
    if (req.capture && Object.keys(req.capture).length) {
      try { const j = JSON.parse(text) as Record<string, unknown>; for (const [n, path] of Object.entries(req.capture)) { const v = path.split('.').reduce<unknown>((o, key) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined), j); if (typeof v === 'string' || typeof v === 'number') vars[n] = String(v); } this.vars.set(k, vars); } catch { /* JSON 아님 */ }
    }
    const keep = ['content-type', 'location', 'www-authenticate'];
    return { status: r.status, ms: Date.now() - t0, headers: Object.fromEntries([...r.headers].filter(([h]) => keep.includes(h.toLowerCase()))), body: redact(text), cookies: [...jar.keys()], vars: Object.keys(vars) };
  }
  resetSession(projectId: string, id: string) { this.jars.delete(this.key(projectId, id)); this.vars.delete(this.key(projectId, id)); }
}

/** 화면 표시용: 저장된 시연 목록 + 상태 */
export async function demoInfo(m: DemoManager, projectId: string, plan: PlanFields): Promise<DemoInfo> {
  const man = readManifest(plan);
  const states = await Promise.all(man.services.map((s) => m.state(projectId, s)));
  return { manifestPath: man.path, exists: man.exists, relPath: relative(plan.folder, man.path).split(sep).join('/'), services: states, apis: man.apis, errors: man.errors };
}

/**
 * 앱이 직접 하는 시연 확인(사이클 판단 전): 사용자가 이미 실행을 승인한 시연 서비스만 켜고(승인 안 된 것은 켜지 않음),
 * 상태 확인 경로와 데이터를 바꾸지 않는 요청(GET, 로그인처럼 값을 잡아 두는 POST)을 목록 순서대로 보내 결과를 남긴다.
 * 직원 세션에서 서버를 오래 띄워 기다리다 시간 제한에 걸리는 일을 없애고, 판단·검토 지점에 실제 확인 근거를 준다.
 */
export async function verifyDemo(mgr: DemoManager, projectId: string, plan: PlanFields): Promise<string[]> {
  const man = readManifest(plan);
  if (!man.exists || !man.services.length) return [];
  const out: string[] = [];
  const up = new Set<string>();
  for (const s of man.services) {
    // 직원 세션이 임시 복사본에서 띄워 둔 서버가 포트를 잡고 있으면 실제 저장소 코드가 아니므로 start()가 끄고 다시 켠다(사용자가 띄운 서버는 건드리지 않음)
    if (s.port && mgr.approved(projectId, s) && !(await mgr.state(projectId, s)).ours) {
      const own = portOwner(s.port);
      if (own && staleCopyServer(own.cwd)) out.push(`- ${s.name}(${s.id}): 직원 임시 복사본에서 띄운 이전 서버를 끄고 실제 저장소 코드로 다시 켭니다`);
      else if (own) out.push(`- ${s.name}(${s.id}): 다른 프로세스가 이미 포트 ${s.port}를 쓰고 있어 그대로 둡니다(최신 코드인지 확인하지 못함)`);
    }
    if (!mgr.approved(projectId, s)) { out.push(`- ${s.name}(${s.id}): 실행 승인 필요 — 사용자가 시연 열기에서 처음 한 번 승인해야 앱이 켤 수 있음(켜지 않음)`); continue; }
    try { await mgr.start(projectId, man.services, s.id, new Set(), () => readManifest(plan).services); up.add(s.id); out.push(`- ${s.name}(${s.id}): 실행 중 · 상태 확인 ${s.health || '/'} 응답 정상`); }
    catch (e) { out.push(`- ${s.name}(${s.id}): 켜지 못함 — ${redact((e as Error).message).slice(0, 200)}`); }
  }
  for (const a of man.apis) {
    const s = man.services.find((x) => x.id === a.service);
    if (!s || !up.has(s.id)) continue;
    const safe = a.method === 'GET' || (a.method === 'POST' && Object.keys(a.capture).length > 0);
    if (!safe) { out.push(`- API ${a.id} ${a.method} ${a.path}: 데이터를 바꾸는 요청이라 앱이 자동으로 보내지 않음(시연 화면에서 확인)`); continue; }
    try {
      const r = await mgr.request(projectId, s, { method: a.method, path: a.path, headers: a.headers, body: a.body, capture: a.capture });
      out.push(`- API ${a.id} ${a.method} ${a.path}: ${r.status}${a.expect ? ` (기대: ${a.expect.slice(0, 80)})` : ''}`);
    } catch (e) { out.push(`- API ${a.id} ${a.method} ${a.path}: 요청 실패 — ${redact((e as Error).message).slice(0, 160)}`); }
  }
  return out.slice(0, 40);
}

/** 포트를 듣는 프로세스와 그 작업 폴더(맥·리눅스). 못 찾으면 null */
export function portOwner(port: number): { pid: number; cwd: string } | null {
  if (process.platform === 'win32') return null;
  try {
    const pid = Number(execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 3000 }).split('\n')[0]);
    if (!pid) return null;
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 3000 });
    return { pid, cwd: out.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '' };
  } catch { return null; }
}
/** 임시 폴더(앱 격리 복사본·직원 세션 임시 폴더)에서 실행 중인 서버인가: 실제 저장소 코드가 아니다 */
export function staleCopyServer(cwd: string): boolean {
  if (!cwd) return false;
  const real = (x: string) => { try { return realpathSync(x); } catch { return resolve(x); } };
  const cs = [real(cwd), resolve(cwd)];
  const roots = [real(tmpdir()), resolve(tmpdir()), real('/tmp'), '/tmp', '/private/tmp'];
  return cs.some((c) => roots.some((r) => c === r || c.startsWith(r + sep)));
}
