// Claude CLI 연결 계층.
// - 설치 위치·버전·인증 상태 확인
// - 비대화 실행(-p, stream-json)의 인자 구성: 셸을 거치지 않고 argv 배열로 전달
// - 도구·파일 접근 범위는 CLI의 권한 엔진(--restricted, dontAsk, allow 규칙, Bash 샌드박스)으로 집행
// - 이벤트 해석, 세션 ID, 프로세스 그룹 단위 취소
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliStatus, ToolName } from '../../shared/types';

export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const inheritedFromHost = !!env.CLAUDECODE || !!env.CLAUDE_CODE_ENTRYPOINT;
  for (const k of Object.keys(env)) {
    // 이 앱을 다른 Claude 세션 안에서 띄웠을 때 상위 세션의 내부 변수가 하위 실행에 섞이지 않게 한다.
    if (/^(CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PLUGIN|USE_STAGING_OAUTH|USE_LOCAL_OAUTH|ELECTRON_RUN_AS_NODE$|BAGGAGE$|AI_AGENT$|CODEX_)/.test(k)) delete env[k];
    if (inheritedFromHost && k === 'ANTHROPIC_BASE_URL') delete env[k];
  }
  const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  env.PATH = [...new Set([...(env.PATH ?? '').split(':').filter(Boolean), ...extraPath])].join(':');
  env.NO_COLOR = '1';
  return { ...env, ...extra };
}

function run(file: string, args: string[], timeoutMs = 15000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, env: cleanEnv(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code?: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function cmpVer(a: string, b: string) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** 설치된 Claude CLI 후보를 찾는다. 사용자 설정 → 로그인 셸 PATH → 일반 설치 위치 → Claude 데스크톱 앱에 포함된 CLI */
export async function findCandidates(settingPath: string | null): Promise<{ path: string; source: string }[]> {
  const out: { path: string; source: string }[] = [];
  const add = (p: string | null | undefined, source: string) => { if (p && existsSync(p) && !out.some((o) => o.path === p)) out.push({ path: p, source }); };
  add(settingPath, '사용자 지정');
  const shell = await run('/bin/zsh', ['-lc', 'command -v claude'], 8000);
  if (shell.code === 0) add(shell.stdout.trim().split('\n').pop(), '로그인 셸 PATH');
  for (const p of [join(homedir(), '.local/bin/claude'), join(homedir(), '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(homedir(), '.npm-global/bin/claude')]) add(p, '일반 설치 위치');
  const base = join(homedir(), 'Library/Application Support/Claude/claude-code');
  try {
    const vers = readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(cmpVer).reverse();
    for (const v of vers) {
      for (const h of readdirSync(join(base, v))) {
        const p = join(base, v, h, 'claude.app/Contents/MacOS/claude');
        if (existsSync(p) && statSync(p).isFile()) add(p, `Claude 데스크톱 앱 포함(${v})`);
      }
      const flat = join(base, v, 'claude');
      if (existsSync(flat)) add(flat, `Claude 데스크톱 앱 포함(${v})`);
    }
  } catch { /* 데스크톱 앱 없음 */ }
  return out;
}

export async function cliVersion(path: string): Promise<string | null> {
  const r = await run(path, ['--version'], 15000);
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
  return r.code === 0 && m ? m[1] : null;
}

export async function checkCli(settingPath: string | null): Promise<CliStatus> {
  const checkedAt = new Date().toISOString();
  const cands = await findCandidates(settingPath);
  const candidates: CliStatus['candidates'] = [];
  for (const c of cands) candidates.push({ ...c, version: await cliVersion(c.path) });
  const pick = candidates.find((c) => c.version);
  if (!pick) {
    return { checkedAt, path: null, source: '', version: null, loggedIn: null, authMethod: null, ready: false, candidates,
      problem: candidates.length ? '찾은 Claude CLI가 실행되지 않습니다.' : 'Claude CLI를 찾지 못했습니다.',
      fix: 'Claude Code를 설치한 뒤(https://code.claude.com/docs) "다시 확인"을 누르거나 "CLI 직접 선택"으로 실행 파일을 지정하세요.' };
  }
  const auth = await run(pick.path, ['auth', 'status', '--json'], 20000);
  let loggedIn: boolean | null = null, authMethod: string | null = null;
  try { const j = JSON.parse(auth.stdout); loggedIn = !!j.loggedIn; authMethod = j.authMethod ?? null; } catch { /* 해석 불가 */ }
  const base = { checkedAt, path: pick.path, source: pick.source, version: pick.version, loggedIn, authMethod, candidates };
  if (loggedIn === null) return { ...base, ready: false, problem: '인증 상태를 확인하지 못했습니다.', fix: '터미널에서 "claude auth status"를 실행해 오류를 확인하세요.' };
  if (!loggedIn) return { ...base, ready: false, problem: 'Claude CLI는 설치돼 있지만 로그인되지 않았습니다.', fix: '"터미널에서 로그인"을 눌러 claude auth login을 완료한 뒤 "다시 확인"을 누르세요. 앱은 계정 정보나 토큰을 저장하지 않습니다.' };
  return { ...base, ready: true, problem: null, fix: null };
}

// ───────── 실행 인자 구성 ─────────
export interface ClaudeRunSpec {
  prompt: string;
  appendSystemPrompt: string;
  cwd: string;
  tools: ToolName[];
  editScopes: string[]; // cwd 기준 상대 경로. '' 또는 '.'은 프로젝트 전체
  allowedCommands: string[];
  readDirs: string[]; // 프로젝트 밖 참고 자료 폴더(읽기)
  sessionId: string | null; // 새 세션 ID
  resumeSessionId: string | null; // 이어서 작업할 세션
  jsonSchema: object | null;
  model: string;
  maxBudgetUsd: number | null;
}

export function scopeRule(scope: string): string {
  const s = scope.trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
  return s === '' || s === '.' ? 'Edit(./**)' : `Edit(./${s}/**)`;
}

export function buildClaudeArgs(spec: ClaudeRunSpec): string[] {
  const writer = spec.tools.includes('Edit') || spec.tools.includes('Write');
  const tools = [...new Set(spec.tools)];
  const allow: string[] = ['Read', 'Grep', 'Glob'];
  if (writer) allow.push(...spec.editScopes.map(scopeRule));
  if (tools.includes('Bash')) for (const c of spec.allowedCommands.map((x) => x.trim()).filter(Boolean)) allow.push(`Bash(${c})`, `Bash(${c} *)`);
  const deny = ['Edit(./.git/**)', 'Edit(./.claude/**)', 'Read(./.env)', 'Read(./.env.*)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.claude/**)'];
  const settings = {
    permissions: { allow, deny, defaultMode: 'dontAsk' },
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, network: { allowedDomains: [] as string[] },
      // 참고 자료 폴더(--add-dir)는 읽기 전용: Bash 하위 프로그램의 쓰기도 막는다
      filesystem: { denyWrite: spec.readDirs.filter((d) => !(spec.cwd === d || spec.cwd.startsWith(d.replace(/\/+$/, '') + '/'))) } }, // 프로젝트를 포함하는 상위 폴더는 제외
  };
  const args = [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--restricted', // 사용자·프로젝트 설정 파일을 무시하고 --settings만 적용, 파일 도구를 작업 폴더로 제한, 권한 우회 거부
    '--permission-mode', 'dontAsk', // 미리 허용하지 않은 행위는 자동 거부
    '--strict-mcp-config',
    '--tools', tools.length ? tools.join(',') : '',
    '--settings', JSON.stringify(settings),
    '--append-system-prompt', spec.appendSystemPrompt,
  ];
  for (const d of spec.readDirs) args.push('--add-dir', d);
  if (spec.resumeSessionId) args.push('--resume', spec.resumeSessionId);
  else if (spec.sessionId) args.push('--session-id', spec.sessionId);
  if (spec.jsonSchema) args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.model.trim()) args.push('--model', spec.model.trim());
  if (spec.maxBudgetUsd && spec.maxBudgetUsd > 0) args.push('--max-budget-usd', String(spec.maxBudgetUsd));
  // 프롬프트는 표준 입력으로 전달한다(가변 인자 옵션이 프롬프트를 삼키지 않게).
  return args;
}

// ───────── 비밀값 마스킹 ─────────
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g,
  /sk-ant-[A-Za-z0-9_\-]{8,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /lsv2_[A-Za-z0-9_]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi,
  /((?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];
export function redact(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, (_m, pre?: string) => (typeof pre === 'string' && pre.length < 60 ? `${pre}[숨김]` : '[숨김]'));
  return out;
}
export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x)) as unknown as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}
export function redactArgs(args: string[]): string[] {
  return args.map((a, i) => (args[i - 1] === '--append-system-prompt' ? `[역할 지시 ${a.length}자]` : redact(a.length > 400 ? `${a.slice(0, 400)}…(${a.length}자)` : a)));
}

// ───────── 스트림 해석 ─────────
export interface ParsedEvent { kind: 'init' | 'text' | 'tool' | 'tool_result' | 'result' | 'system' | 'denied' | 'stderr'; summary: string; raw: string }
export interface ResultInfo {
  subtype: string | null; isError: boolean | null; text: string; sessionId: string | null; costUsd: number | null;
  usage: Record<string, number> | null; permissionDenials: string[]; structured: unknown;
}

function brief(v: unknown, n = 160): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 사용 한도(플랜 사용량·속도 제한) 도달 정보. resetsAt은 ms 단위 시각(모르면 null). */
export interface LimitInfo { resetsAt: number | null; text: string }
export interface StreamSink { sessionId: string | null; result: ResultInfo | null; limit?: LimitInfo | null }

const LIMIT_TEXT_RE = /hit your (?:[\w' -]{0,30})?limit|usage limit|rate[ _-]?limit|reached your (?:[\w' -]{0,30})?limit|out of usage|too many requests|\b429\b/i;

/** 초 또는 ms 시각을 ms로 맞춘다. */
function toMs(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Claude 실행이 사용 한도 때문에 끝났는지 판단한다.
 * 결과가 성공이면 한도 경고가 있었더라도 한도 도달로 보지 않는다(초과 사용·대체 모델로 계속된 경우).
 */
export function claudeLimit(sink: StreamSink, exitCode: number | null): LimitInfo | null {
  const r = sink.result;
  if (r && r.isError === false && exitCode === 0) return null;
  if (sink.limit) return sink.limit;
  if (r && r.isError && LIMIT_TEXT_RE.test(r.text)) return { resetsAt: null, text: r.text.slice(0, 300) };
  return null;
}

/** Codex: 실패 종료 + 오류 출력에 한도 문구가 있을 때만 한도로 본다(리뷰 본문의 'rate limit' 언급은 보지 않는다). */
export function codexLimit(stderr: string, exitCode: number | null): LimitInfo | null {
  if (exitCode === 0 || !LIMIT_TEXT_RE.test(stderr)) return null;
  const line = stderr.split('\n').find((l) => LIMIT_TEXT_RE.test(l)) ?? '';
  return { resetsAt: null, text: line.trim().slice(0, 300) };
}

export function interpretLine(line: string, sink: StreamSink): ParsedEvent | null {
  let m: Record<string, unknown>;
  try { m = JSON.parse(line); } catch { return line.trim() ? { kind: 'system', summary: brief(line), raw: redact(line) } : null; }
  const raw = redact(line.length > 20000 ? `${line.slice(0, 20000)}…` : line);
  if (typeof m.session_id === 'string') sink.sessionId = m.session_id;
  if (m.type === 'system' && m.subtype === 'init') {
    const tools = Array.isArray(m.tools) ? m.tools.length : '?';
    return { kind: 'init', summary: `세션 시작 · 모델 ${String(m.model ?? '기본')} · 도구 ${tools}개 · 권한 ${String(m.permissionMode ?? '')}`, raw };
  }
  if (m.type === 'rate_limit_event') {
    const info = (m.rate_limit_info ?? {}) as Record<string, unknown>;
    const status = String(info.status ?? '');
    const at = toMs(info.resetsAt);
    if (status === 'rejected') sink.limit = { resetsAt: at, text: `사용 한도 도달(${String(info.rateLimitType ?? '종류 미상')})` };
    const when = at ? new Date(at).toLocaleString('ko-KR') : '시각 미보고';
    return { kind: 'system', summary: `사용 한도 상태: ${status || '?'} · 해제 ${when}`, raw };
  }
  if (m.type === 'assistant') {
    if (m.error === 'rate_limit' && !sink.limit) {
      const c = ((m.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
      sink.limit = { resetsAt: null, text: c.map((x) => (typeof x.text === 'string' ? x.text : '')).join(' ').slice(0, 300) || '사용 한도 도달' };
    }
    const content = ((m.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
    const parts: string[] = []; let kind: ParsedEvent['kind'] = 'text';
    for (const c of content) {
      if (c.type === 'text' && typeof c.text === 'string') parts.push(brief(c.text, 200));
      if (c.type === 'tool_use') {
        kind = 'tool';
        const inp = (c.input ?? {}) as Record<string, unknown>;
        const target = inp.file_path ?? inp.path ?? inp.command ?? inp.pattern ?? inp.url ?? '';
        parts.push(`${String(c.name)} ${brief(target, 120)}`);
      }
    }
    return parts.length ? { kind, summary: parts.join(' · '), raw } : null;
  }
  if (m.type === 'user') {
    const content = ((m.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
    const tr = content.find((c) => c.type === 'tool_result');
    if (!tr) return null;
    const txt = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? '');
    if (tr.is_error) {
      const denied = /permission|권한|denied|not allowed|is outside|--restricted/i.test(txt);
      return { kind: denied ? 'denied' : 'tool_result', summary: `${denied ? '권한 거부' : '도구 오류'}: ${brief(txt, 160)}`, raw };
    }
    return { kind: 'tool_result', summary: `도구 결과 ${txt.length}자`, raw };
  }
  if (m.type === 'result') {
    const denials = Array.isArray(m.permission_denials) ? (m.permission_denials as Record<string, unknown>[]).map((d) => `${String(d.tool_name ?? '')} ${brief(d.tool_input ?? '', 400)}`) : [];
    const cost = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
    const usage = m.usage && typeof m.usage === 'object' ? Object.fromEntries(Object.entries(m.usage as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as Record<string, number> : null;
    sink.result = {
      subtype: typeof m.subtype === 'string' ? m.subtype : null,
      isError: typeof m.is_error === 'boolean' ? m.is_error : null,
      text: typeof m.result === 'string' ? m.result : '',
      sessionId: typeof m.session_id === 'string' ? m.session_id : sink.sessionId,
      costUsd: cost, usage, permissionDenials: denials,
      structured: m.structured_output ?? null,
    };
    return { kind: 'result', summary: `종료 결과: ${String(m.subtype ?? '?')}${m.is_error ? ' (오류)' : ''}${denials.length ? ` · 거부 ${denials.length}건` : ''}${cost !== null ? ` · 보고 비용 $${cost.toFixed(4)}` : ' · 비용 미보고'}`, raw };
  }
  if (m.type === 'system') return { kind: m.subtype === 'permission_denied' ? 'denied' : 'system', summary: `${String(m.subtype ?? 'system')} ${brief(m.error ?? m.message ?? '', 120)}`, raw };
  return null;
}

// ───────── 프로세스 실행 ─────────
export interface ProcessHandle { child: ChildProcess; pid: number; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; cancelled: boolean }>; cancel: () => void }

export function startProcess(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutSec: number; onStdoutLine: (l: string) => void; onStderrLine: (l: string) => void }): ProcessHandle {
  // detached: 새 프로세스 그룹. 취소 시 그룹 전체(하위 Bash 포함)를 종료한다.
  const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let timedOut = false, cancelled = false;
  const killGroup = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* 이미 종료 */ } };
  const terminate = () => { killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 5000).unref(); };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, Math.max(1, opts.timeoutSec) * 1000);
  const lines = (stream: NodeJS.ReadableStream, cb: (l: string) => void) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { cb(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    stream.on('end', () => { if (buf) cb(buf); });
  };
  lines(child.stdout!, opts.onStdoutLine);
  lines(child.stderr!, opts.onStderrLine);
  child.stdin!.on('error', () => { /* 조기 종료 시 무시 */ });
  child.stdin!.end(opts.stdin);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; cancelled: boolean }>((resolve) => {
    child.on('error', (e) => { clearTimeout(timer); opts.onStderrLine(`프로세스 시작 실패: ${e.message}`); resolve({ code: null, signal: null, timedOut, cancelled }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, cancelled }); });
  });
  return { child, pid: child.pid ?? -1, done, cancel: () => { cancelled = true; terminate(); } };
}

export async function processStart(pid: number): Promise<string | null> {
  if (!pid || pid < 0) return null;
  const r = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], 5000);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
/** 앱이 시작한 프로세스인지 확인: 기록한 시작 시각이 같고 명령줄에 표식(세션 ID 등)이 있어야 한다. */
export async function isOurProcess(pid: number, marker: string, startedAt: string | null): Promise<boolean> {
  if (!pid || pid < 0 || !startedAt) return false;
  const st = await processStart(pid);
  if (!st || st !== startedAt) return false;
  const r = await run('/bin/ps', ['-o', 'command=', '-p', String(pid)], 5000);
  return r.code === 0 && r.stdout.includes(marker);
}
export function killGroup(pid: number) {
  try { process.kill(-pid, 'SIGTERM'); } catch { /* 없음 */ }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* 없음 */ } }, 3000).unref();
}
/** 프로세스 그룹을 종료하고 실제로 끝날 때까지 기다린다(3초 뒤 SIGKILL, 최대 timeoutMs). */
export async function killGroupAndWait(pid: number, timeoutMs = 6000): Promise<boolean> {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try { process.kill(-pid, 'SIGTERM'); } catch { /* 없음 */ }
  const t0 = Date.now(); let killed = false;
  while (alive() && Date.now() - t0 < timeoutMs) {
    if (!killed && Date.now() - t0 > 3000) { try { process.kill(-pid, 'SIGKILL'); } catch { /* 없음 */ } killed = true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive();
}
