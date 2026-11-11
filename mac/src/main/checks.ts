// 검사 명령 안전 규칙(오퍼레이터가 계획한 검사에 적용). 시험할 수 있게 별도 모듈로 둔다.
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { escapes } from './engine/validate';

/** 내장 검사로 허용하는 명령(정확히 이 이름일 때만). macOS판은 시스템 경로의 명령으로 고정해 실행한다. */
export const BUILTIN_CHECK = new Map<string, string>([['test', '/bin/test'], ['/bin/test', '/bin/test'], ['/usr/bin/test', '/usr/bin/test'], ['grep', '/usr/bin/grep'], ['/usr/bin/grep', '/usr/bin/grep'], ['/bin/grep', '/usr/bin/grep']]);

const SHELLS = ['sh', 'bash', 'zsh', 'fish', 'env', 'osascript', 'eval', 'xargs', 'sudo', 'cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'start'];

/** 프로젝트 안 파일인지(경로 문자열과 실제 경로 모두). 없는 파일은 경로 문자열만 본다. */
function insideProject(folder: string, p: string): boolean {
  if (!p || isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\') || escapes(p)) return false;
  const abs = join(folder, p);
  if (!existsSync(abs)) return true;
  try { const root = realpathSync(folder); const real = realpathSync(abs); return real === root || real.startsWith(root + sep); } catch { return false; }
}

/** test·grep의 파일 인자(옵션·grep 패턴 제외) */
function fileArgs(args: string[], grep: boolean): string[] {
  const out: string[] = []; let pattern = !grep; let opts = true;
  for (const x of args) {
    if (opts && x === '--') { opts = false; continue; }
    if (opts && (x.startsWith('-') || x === '!')) continue;
    if (!pattern) { pattern = true; opts = !grep ? opts : false; continue; }
    out.push(x);
  }
  return out;
}

/**
 * 오퍼레이터가 계획한 검사 명령을 실행해도 되는지 판단한다. 허용이면 실행할 argv, 아니면 null.
 * - 셸·인터프리터 코드 실행(sh -c, node -e 등)은 금지
 * - 내장 test·grep: 정확한 이름만, 파일 인자는 프로젝트 폴더 안만(프로젝트 밖 파일을 읽어 다음 프롬프트로 흘리지 않게)
 * - 그 밖: 담당 직원의 허용 명령과 같거나, 허용 명령 뒤에 옵션(-)·대입(=)이 없는 평범한 인자만 붙은 경우
 *   (예: 허용 'npm test'에 'npm test --script-shell=…' 같은 동작 변경 옵션은 거부)
 */
export function checkArgv(argv: string[], allowed: string[], folder: string): string[] | null {
  const a = argv.map((x) => x.trim()).filter(Boolean);
  if (!a.length) return null;
  const bin = (a[0].split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (SHELLS.includes(bin)) return null;
  if (/^(node|python\d*|ruby|perl|php|deno|bun)$/.test(bin) && a.some((x) => ['-e', '-c', '--eval', '-p', '--print'].includes(x))) return null;
  if (BUILTIN_CHECK.has(a[0])) {
    const files = fileArgs(a.slice(1), bin === 'grep');
    if (!files.length || !files.every((f) => insideProject(folder, f))) return null;
    return [BUILTIN_CHECK.get(a[0])!, ...a.slice(1)];
  }
  for (const c of allowed.map((x) => x.trim()).filter(Boolean)) {
    const pre = c.split(/\s+/);
    if (a.length < pre.length || pre.some((t, i) => a[i] !== t)) continue;
    const extra = a.slice(pre.length);
    if (extra.every((x) => /^[A-Za-z0-9_.@:+,][A-Za-z0-9_./@:+,-]*$/.test(x) && (!/[\\/]/.test(x) || insideProject(folder, x)))) return a;
  }
  return null;
}

/** 검사 실행용 환경 변수: 키·토큰·비밀번호 성격의 변수를 빼서 프로젝트의 시험 코드가 읽지 못하게 한다. */
export function checkEnvFilter(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|^AWS_|^AZURE_|^GOOGLE_APPLICATION|^GITHUB_|^GH_|^NPM_TOKEN|ANTHROPIC|OPENAI|LANGSMITH|LANGCHAIN|^CLAUDE|^CODEX|SSH_AUTH_SOCK)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
