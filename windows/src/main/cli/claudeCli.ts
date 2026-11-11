// Claude CLI 연결 계층.
// - 설치 위치·버전·인증 상태 확인
// - 비대화 실행(-p, stream-json)의 인자 구성: 셸을 거치지 않고 argv 배열로 전달
// - 도구·파일 접근 범위는 CLI의 권한 엔진(--restricted, dontAsk, allow 규칙, Bash 샌드박스)으로 집행
// - 이벤트 해석, 세션 ID, 프로세스 트리 단위 취소
// Windows판: CLI 찾기(where·npm 전역 설치), .cmd 실행 파일 해석, 프로세스 트리 종료(taskkill), 시작 시각 조회(PowerShell)를 Windows 방식으로 한다.
//   Claude의 Bash OS 격리(샌드박스)는 Windows에서 쓸 수 없으므로 Bash 도구는 실행할 때 끈다(검사 명령은 앱이 직접 실행).
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, join } from 'node:path';
import type { CliStatus, ToolName } from '../../shared/types';

export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const inheritedFromHost = !!env.CLAUDECODE || !!env.CLAUDE_CODE_ENTRYPOINT;
  for (const k of Object.keys(env)) {
    // 이 앱을 다른 Claude 세션 안에서 띄웠을 때 상위 세션의 내부 변수가 하위 실행에 섞이지 않게 한다.
    if (/^(CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PLUGIN|USE_STAGING_OAUTH|USE_LOCAL_OAUTH|ELECTRON_RUN_AS_NODE$|BAGGAGE$|AI_AGENT$|CODEX_)/.test(k)) delete env[k];
    if (inheritedFromHost && k === 'ANTHROPIC_BASE_URL') delete env[k];
  }
  // Windows는 PATH 변수 이름이 Path일 수 있다. 하나로 합쳐 쓴다.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[pathKey] ?? '';
  if (pathKey !== 'PATH') delete env[pathKey];
  env.PATH = [...new Set([...current.split(delimiter).filter(Boolean), ...winExtraPath()])].join(delimiter);
  env.NO_COLOR = '1';
  return { ...env, ...extra };
}

/** Windows 기본 도구는 전체 경로로 실행한다(현재 폴더의 같은 이름 파일이 먼저 실행되지 않게) */
const SYS32 = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
export const WHERE_EXE = join(SYS32, 'where.exe');
const TASKKILL_EXE = join(SYS32, 'taskkill.exe');
const POWERSHELL_EXE = join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SYS_OPTS = { windowsHide: true, cwd: SYS32 };

/** Windows에서 CLI가 자주 설치되는 폴더(사용자 bin, npm 전역, Node.js) */
function winExtraPath(): string[] {
  const home = homedir();
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  return [join(home, '.local', 'bin'), join(appData, 'npm'), join(local, 'Programs', 'nodejs'), join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs')];
}

/**
 * 실행 방법 해석: Windows의 .cmd/.bat(npm 전역 설치 실행 파일)은 셸 없이 바로 실행할 수 없으므로
 * 그 안에 적힌 Node 스크립트를 찾아 node로 직접 실행한다(인자를 셸에 넘기지 않는다).
 */
export function launchSpec(file0: string, args: string[]): { file: string; args: string[]; env?: Record<string, string> } {
  // 경로 없이 이름만 적은 명령(npm, npm.cmd 등)은 PATH에서 찾는다: 확장자가 없으면 .exe → .cmd/.bat 순
  let file = file0;
  if (!/[\\/]/.test(file0)) {
    const all = whereAll(file0);
    file = extname(file0) ? (all[0] ?? file0) : (all.find((p) => /\.exe$/i.test(p)) ?? all.find((p) => /\.(cmd|bat)$/i.test(p)) ?? file0);
  }
  const ext = extname(file).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { file, args };
  let script: string | null = null;
  try {
    const body = readFileSync(file, 'utf8');
    // npm 실행 파일 형식: "%dp0%\…\cli.js" 또는 SET "X=%~dp0\node_modules\npm\bin\npm-cli.js"
    // 실제 npm.cmd에는 보조 스크립트(npm-prefix.js)가 먼저 나오므로, *-cli.js·cli.js를 우선하고 없으면 마지막 스크립트를 쓴다
    const refs = [...body.matchAll(/%~?dp0%?\\?([^"%\r\n]+?\.(?:c?js|mjs))/gi)].map((x) => x[1]);
    const pick = refs.find((r) => /(^|[\\/-])cli\.(c?js|mjs)$/i.test(r)) ?? refs[refs.length - 1];
    if (pick) script = join(dirname(file), ...pick.split(/[\\/]/).filter(Boolean));
  } catch { /* 읽지 못함 */ }
  if (!script || !existsSync(script)) throw new Error(`실행 파일(${file})을 해석하지 못했습니다. 설정에서 .exe 실행 파일을 직접 지정하세요.`);
  const nodeExe = [join(dirname(file), 'node.exe'), whereFirst('node')].find((p) => !!p && existsSync(p));
  // Node가 없으면 이 앱(Electron)을 Node 모드로 써서 실행한다
  return nodeExe ? { file: nodeExe, args: [script, ...args] } : { file: process.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } };
}
function whereAll(name: string): string[] {
  try { return execFileSync(WHERE_EXE, [name], { ...SYS_OPTS, encoding: 'utf8', timeout: 5000, env: cleanEnv() }).split(/\r?\n/).map((x) => x.trim()).filter(Boolean); } catch { return []; }
}
function whereFirst(name: string): string | null {
  return whereAll(name).find((p) => /\.exe$/i.test(p)) ?? null;
}

function run(file0: string, args0: string[], timeoutMs = 15000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let spec: ReturnType<typeof launchSpec>;
  try { spec = launchSpec(file0, args0); } catch (e) { return Promise.resolve({ code: 1, stdout: '', stderr: (e as Error).message }); }
  const { file, args } = spec;
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, env: cleanEnv(spec.env), maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
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

/** 설치된 Claude CLI 후보를 찾는다. 사용자 설정 → PATH(where) → 일반 설치 위치(네이티브 설치 .exe, npm 전역 .cmd) */
export async function findCandidates(settingPath: string | null): Promise<{ path: string; source: string }[]> {
  const out: { path: string; source: string }[] = [];
  const add = (p: string | null | undefined, source: string) => { if (p && existsSync(p) && !out.some((o) => o.path === p)) out.push({ path: p, source }); };
  add(settingPath, '사용자 지정');
  try {
    const w = execFileSync(WHERE_EXE, ['claude'], { ...SYS_OPTS, encoding: 'utf8', timeout: 8000, env: cleanEnv() });
    // .exe를 먼저, 그다음 .cmd(npm 전역 설치)
    const found = w.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).sort((x, y) => Number(/\.exe$/i.test(y)) - Number(/\.exe$/i.test(x)));
    for (const p of found) if (/\.(exe|cmd|bat)$/i.test(p)) add(p, 'PATH');
  } catch { /* PATH에 없음 */ }
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  for (const p of [join(homedir(), '.local', 'bin', 'claude.exe'), join(homedir(), '.claude', 'local', 'claude.exe'), join(appData, 'npm', 'claude.cmd')]) add(p, '일반 설치 위치');
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
  // Windows: Claude의 Bash OS 격리(샌드박스)를 쓸 수 없으므로 Bash 도구를 주지 않는다(격리 없는 셸 실행을 막는다)
  const tools = [...new Set(spec.tools)].filter((t) => t !== 'Bash');
  const allow: string[] = ['Read', 'Grep', 'Glob'];
  if (writer) allow.push(...spec.editScopes.map(scopeRule));
  // Bash 허용 명령 규칙은 넣지 않는다(Windows판은 Bash 도구를 주지 않음)
  const deny = ['Edit(./.git/**)', 'Edit(./.claude/**)', 'Read(./.env)', 'Read(./.env.*)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.claude/**)'];
  // Bash 도구를 주지 않으므로 Bash 샌드박스 설정은 넣지 않는다(Windows에서는 샌드박스를 지원하지 않음)
  const settings = { permissions: { allow, deny, defaultMode: 'dontAsk' } };
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
  // Windows: 콘솔 창 없이 실행하고, 취소 시 taskkill /T로 하위 프로세스까지 종료한다. .cmd는 Node 스크립트로 해석해 셸 없이 실행한다.
  let spec: ReturnType<typeof launchSpec>;
  try { spec = launchSpec(file, args); } catch (e) { spec = { file, args }; opts.onStderrLine(`프로세스 시작 실패: ${(e as Error).message}`); }
  const child = spawn(spec.file, spec.args, { cwd: opts.cwd, env: spec.env ? { ...opts.env, ...spec.env } : opts.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let timedOut = false, cancelled = false;
  // 창 없는 프로세스는 정상 종료 요청을 받지 못하므로 바로 강제 종료한다: 직접 자식은 즉시 종료하고, 하위 프로세스는 taskkill /T /F
  // 하위 프로세스를 먼저 찾아 끝낸 뒤(동기) 직접 자식을 끝낸다 — 부모가 먼저 끝나면 하위 목록을 찾지 못한다
  const terminate = () => { if (child.pid) killTree(child.pid, true); try { child.kill(); } catch { /* 이미 종료 */ } };
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

/** taskkill로 프로세스 트리를 종료한다(force=false면 정상 종료 요청, true면 강제 종료). */
function killTree(pid: number, force: boolean) {
  // 끝날 때까지 기다린다(동기). 이미 끝난 프로세스면 오류 코드로 끝나므로 무시한다
  try { execFileSync(TASKKILL_EXE, ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { ...SYS_OPTS, stdio: 'ignore', timeout: 10000 }); } catch { /* 없음·이미 종료 */ }
}
/** PowerShell(CIM)로 프로세스의 시작 시각·명령줄을 읽는다. */
async function procInfo(pid: number): Promise<{ start: string; command: string } | null> {
  if (!pid || pid < 0) return null;
  const r = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Math.floor(pid)}"; if ($p) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $p.CreationDate.ToUniversalTime().ToString('o'); $p.CommandLine }`],
      { ...SYS_OPTS, timeout: 10000 }, (e, stdout) => resolve({ code: e ? 1 : 0, out: String(stdout) }));
  });
  const lines = r.out.split(/\r?\n/);
  const start = (lines[0] ?? '').trim();
  return r.code === 0 && start ? { start, command: lines.slice(1).join('\n') } : null;
}
export async function processStart(pid: number): Promise<string | null> {
  return (await procInfo(pid))?.start ?? null;
}
/** 앱이 시작한 프로세스인지 확인: 기록한 시작 시각이 같고 명령줄에 표식(세션 ID 등)이 있어야 한다. */
export async function isOurProcess(pid: number, marker: string, startedAt: string | null): Promise<boolean> {
  if (!pid || pid < 0 || !startedAt) return false;
  const info = await procInfo(pid);
  return !!info && info.start === startedAt && info.command.includes(marker);
}
export function killGroup(pid: number) {
  killTree(pid, true);
  try { process.kill(pid); } catch { /* 없음 */ }
}
/** 프로세스 트리를 강제 종료하고 실제로 끝날 때까지 기다린다(최대 timeoutMs). */
export async function killGroupAndWait(pid: number, timeoutMs = 6000): Promise<boolean> {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  killTree(pid, true);
  try { process.kill(pid); } catch { /* 없음 */ }
  const t0 = Date.now();
  while (alive() && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 100));
  return !alive();
}
