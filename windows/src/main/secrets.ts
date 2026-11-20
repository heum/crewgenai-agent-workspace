// API 키 파일 저장: 확인함에서 사람이 입력한 비밀값을 프로젝트의 .env 파일에 넣는다.
// 원칙
// - 값은 이 PC의 .env 파일에만 쓴다. 미션 기록·로그·텔레그램·화면 응답에 값을 남기지 않는다(변수 이름과 파일 위치만).
// - .env·.env.<이름> 파일만 쓴다(.env.example 같은 공유용 견본은 제외). 연결 폴더 밖, 심볼릭 링크는 거부한다.
// - git 저장소 안이면 .gitignore에 비밀값 규칙을 넣고, 그 파일이 실제로 무시되는지 확인한 뒤에만 쓴다(커밋 방지).
// - 파일 권한은 소유자만 읽고 쓰게(0600) 맞춘다.
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export const ENV_FILE = /^\.env(\.[A-Za-z0-9_-]{1,40})?$/;
const SHARED_ENV = /^\.env\.(example|sample|template|dist|defaults?)$/i;
export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
export const MAX_SECRET = 8192;

/** 연결 폴더 기준 .env 경로가 쓸 수 있는 모양인지(없으면 이유) */
export function envFileProblem(rel: string): string | null {
  const r = String(rel ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!r) return '파일 위치가 비어 있습니다.';
  if (isAbsolute(r) || /^[A-Za-z]:/.test(r)) return '연결 폴더 기준 경로로 적어야 합니다.';
  if (r.split('/').some((p) => p === '..' || p === '')) return '연결 폴더 밖이나 잘못된 경로입니다.';
  const b = basename(r);
  if (!ENV_FILE.test(b)) return '.env 또는 .env.<이름> 파일에만 저장할 수 있습니다.';
  if (SHARED_ENV.test(b)) return `${b}는 공유용 견본이라 실제 값을 넣지 않습니다.`;
  return null;
}
export const normEnvRel = (rel: string) => String(rel ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');

export function secretValueProblem(v: string): string | null {
  if (typeof v !== 'string' || !v.trim()) return '값이 비어 있습니다.';
  if (v.length > MAX_SECRET) return '값이 너무 깁니다.';
  if (/[\r\n\0]/.test(v)) return '값에 줄바꿈을 넣을 수 없습니다(한 줄로 붙여 넣으세요).';
  if (v.includes("'") && v.includes('"')) return '작은따옴표와 큰따옴표가 함께 든 값은 .env 한 줄로 안전하게 적을 수 없습니다.';
  return null;
}

const lineOf = (name: string) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
/** 값을 .env 한 줄로: 흔한 키 모양은 그대로, 그 밖은 작은따옴표(안 되면 큰따옴표)로 감싼다. 이스케이프는 하지 않는다(도구마다 해석이 달라 값이 바뀜) */
export function envLine(name: string, value: string): string {
  const v = value.trim();
  if (/^[A-Za-z0-9_\-.:/+=@,~]+$/.test(v)) return `${name}=${v}`;
  return v.includes("'") ? `${name}="${v}"` : `${name}='${v}'`;
}
/** 이미 있는 줄은 바꾸고, 없으면 끝에 더한다 */
export function setEnvVar(content: string, name: string, value: string): string {
  const lines = content ? content.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const re = lineOf(name); const line = envLine(name, value);
  const at = lines.findIndex((l) => re.test(l));
  if (at >= 0) { lines[at] = line; for (let i = lines.length - 1; i > at; i--) if (re.test(lines[i])) lines.splice(i, 1); }
  else lines.push(line);
  return `${lines.join('\n')}\n`;
}
/** 값이 채워진 변수가 있는가(값 자체는 돌려주지 않는다) */
export function hasEnvVar(content: string, name: string): boolean {
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`);
  return content.split(/\r?\n/).some((l) => { const m = re.exec(l); return !!m && !!m[1].replace(/^["']|["']$/g, '').trim(); });
}

/** 연결 폴더 안의 실제 경로로 바꾼다. 폴더 밖·심볼릭 링크·없는 상위 폴더면 이유를 돌려준다 */
export function resolveEnvPath(folder: string, rel: string): { abs: string } | { error: string } {
  const bad = envFileProblem(rel); if (bad) return { error: bad };
  let root: string; try { root = realpathSync(folder); } catch { return { error: '연결 폴더를 찾을 수 없습니다.' }; }
  const r = normEnvRel(rel); const abs = join(root, ...r.split('/'));
  let dir: string; try { dir = realpathSync(dirname(abs)); } catch { return { error: `상위 폴더(${dirname(r) || '.'})가 없습니다.` }; }
  const back = relative(root, dir);
  if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) return { error: '연결 폴더 밖입니다.' };
  if (existsSync(abs)) { const st = lstatSync(abs); if (st.isSymbolicLink() || !st.isFile()) return { error: '일반 파일이 아니라 쓰지 않습니다.' }; }
  return { abs: join(dir, basename(abs)) };
}
export function envHas(abs: string, name: string): boolean {
  try { return hasEnvVar(readFileSync(abs, 'utf8'), name); } catch { return false; }
}
/** 실제 쓰기(검사는 부르는 쪽에서 끝낸 뒤) */
export function writeEnvVar(abs: string, name: string, value: string): void {
  let cur = ''; try { cur = readFileSync(abs, 'utf8'); } catch { cur = ''; }
  writeFileSync(abs, setEnvVar(cur, name, value), { mode: 0o600 });
  try { chmodSync(abs, 0o600); } catch { /* 권한을 못 바꾸는 파일 시스템 */ }
}
