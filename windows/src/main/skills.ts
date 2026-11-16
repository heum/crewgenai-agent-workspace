// 이 PC에 설치된 스킬을 직원 실행에 넘긴다.
// 직원은 --restricted로 실행돼 ~/.claude/skills 같은 사용자 설정을 읽지 않는다. 그래서 사용자가 고른 스킬 폴더에서
// '스킬 파일만' 읽기 전용 사본(임시 폴더)으로 묶어 --plugin-dir로 넘긴다.
// 플러그인의 훅·MCP 서버·명령·에이전트는 옮기지 않는다(앱의 권한 통제 밖에서 실행될 수 있으므로).
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants as fsc, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import type { SkillSource } from '../shared/types';

const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILE = 4 * 1024 * 1024;
const SKIP_DIR = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.DS_Store']);
const SECRET = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_rsa.*|id_ed25519.*|\.npmrc|\.netrc|credentials(\..*)?)$/i;

/** 기본 스킬 폴더: 이 PC에 있는 것만 */
/** 기본 스킬 폴더: 이 PC의 기본 위치 중 실제로 스킬이 하나 이상 있는 곳만(빈 폴더·다른 앱이 동기화용으로 만든 폴더는 보여 주지 않음) */
export function defaultSkillDirs(home: string = homedir()): string[] {
  return [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')].filter((p) => isDir(p) && skillDirsIn(p).dirs.length > 0);
}

function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
function isFile(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }
function real(p: string): string | null { try { return realpathSync(p); } catch { return null; } }
function children(p: string): string[] { try { return readdirSync(p).filter((n) => !n.startsWith('.') && !SKIP_DIR.has(n)).sort(); } catch { return []; } }
function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'skills'; }

/** 스킬 폴더 하나에서 스킬 디렉터리(SKILL.md가 있는 폴더) 목록을 찾는다. 플러그인이면 skills/만 본다. */
function skillDirsIn(src: string): { name: string; dirs: string[] } {
  const r = real(src);
  if (!r || !isDir(r)) return { name: slug(basename(src)), dirs: [] };
  const pluginName = (p: string) => { try { const j = JSON.parse(readFileSync(join(p, '.claude-plugin', 'plugin.json'), 'utf8')); return typeof j.name === 'string' ? slug(j.name) : null; } catch { return null; } };
  const inSkills = (base: string) => children(base).map((n) => join(base, n)).filter((d) => isFile(join(d, 'SKILL.md')));
  if (isFile(join(r, 'SKILL.md'))) return { name: slug(basename(r)), dirs: [r] }; // 스킬 하나
  if (existsSync(join(r, '.claude-plugin'))) return { name: pluginName(r) ?? slug(basename(r)), dirs: inSkills(join(r, 'skills')) }; // 플러그인 하나
  const direct = inSkills(r);
  const plugins = children(r).map((n) => join(r, n)).filter((d) => existsSync(join(d, '.claude-plugin')));
  const name = src.endsWith(join('.claude', 'skills')) ? 'user' : src.endsWith(join('.agents', 'skills')) ? 'agents' : slug(basename(r));
  return { name, dirs: [...direct, ...plugins.flatMap((p) => inSkills(join(p, 'skills')))] };
}

/** 설정 화면용: 폴더마다 찾은 스킬 이름 */
export function describeSkillSources(dirs: string[]): SkillSource[] {
  return dirs.map((path) => {
    if (!isDir(path)) return { path, ok: false, skills: [], note: '폴더가 없습니다' };
    const { dirs: found } = skillDirsIn(path);
    return { path, ok: found.length > 0, skills: found.map((d) => basename(d)), note: found.length ? null : 'SKILL.md가 있는 스킬을 찾지 못했습니다' };
  });
}

interface FileItem { rel: string; abs: string; size: number; mtime: number; ino: number; dev: number }

/** 스킬 디렉터리 안의 일반 파일만(심볼릭 링크·비밀 파일·큰 파일 제외) */
function listFiles(root: string, budget: { files: number; bytes: number }): FileItem[] {
  const out: FileItem[] = [];
  const walk = (dir: string, rel: string) => {
    let names: string[] = [];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (SKIP_DIR.has(n) || SECRET.test(n)) continue;
      const abs = join(dir, n);
      let st; try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${n}` : n;
      if (st.isDirectory()) { if (process.platform === 'win32' || typeof process.getuid !== 'function' || (st.uid === process.getuid() && !(st.mode & 0o022))) walk(abs, r); }
      else if (st.isFile() && st.size <= MAX_FILE && budget.files > 0 && budget.bytes >= st.size) {
        budget.files -= 1; budget.bytes -= st.size;
        out.push({ rel: r, abs, size: st.size, mtime: st.mtimeMs, ino: st.ino, dev: st.dev });
      }
    }
  };
  walk(root, '');
  return out;
}

/** 목록을 만든 뒤 바꿔치기(링크로 교체)된 파일은 읽지 않는다: 링크를 따라가지 않고 열어 같은 파일인지 확인한다 */
function safeRead(f: FileItem, rootReal: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(f.abs, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== f.ino || st.dev !== f.dev || st.size > MAX_FILE) return null;
    const r = realpathSync(f.abs);
    if (r !== rootReal && !r.startsWith(rootReal + sep)) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; }
    return buf.subarray(0, off);
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* 무시 */ } }
}

// SKILL.md 머리말에서 남기는 항목. hooks·allowed-tools·model·context·agent 등은 직원 권한·실행 통제를 바꿀 수 있어 뺀다.
const KEEP_KEYS = new Set(['name', 'description', 'when_to_use', 'when-to-use', 'argument-hint', 'license', 'version']);

/** 머리말은 허용 항목만 남기고, 본문의 !`명령` 미리 실행 구문은 실행되지 않게 바꾼다 */
export function sanitizeSkillMd(text: string): string {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++; // 앞쪽 빈 줄
  const front: string[] = [];
  let bodyLines = lines.slice(i);
  if (i < lines.length && /^---/.test(lines[i])) {
    // 끝 표시는 '---' 또는 '...'로 시작하는 줄이면 모두 인정한다(뒤에 주석이 붙는 등 변형 포함). 끝이 없으면 머리말 전체를 버린다.
    const end = lines.findIndex((l, j) => j > i && /^(---|\.\.\.)/.test(l));
    const head = end < 0 ? lines.slice(i + 1) : lines.slice(i + 1, end);
    bodyLines = end < 0 ? [] : lines.slice(end + 1);
    let keep = false;
    for (const line of head) {
      const k = /^([A-Za-z0-9_-]+)[ \t]*:/.exec(line);
      if (k) keep = KEEP_KEYS.has(k[1].toLowerCase());
      else if (!/^[ \t]/.test(line) && line.trim()) keep = false; // 들여쓰지 않은 다른 줄(따옴표 키·목록·복합 키 등)
      if (keep) front.push(line);
    }
  }
  const body = bodyLines.join('\n').replace(/!`/g, '! `').replace(/^([ \t]*)(`{3,}|~{3,})!/gm, '$1$2 !'); // 2중 방어(CLI 설정 disableSkillShellExecution도 켬)
  return `---\n${front.join('\n')}${front.length ? '\n' : ''}---\n${body}`;
}

/** 다른 사용자가 바꿔치기할 수 없는 경로인지(POSIX): 경로와 모든 상위 폴더가 현재 사용자·root 소유이고, 다른 사용자가 쓸 수 없어야 한다(스티키 폴더 제외) */
function ownedChain(p: string): boolean {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return true; // Windows는 ACL 모델이라 이 검사를 하지 않는다
  const uid = process.getuid();
  let cur = p;
  for (;;) {
    let st; try { st = lstatSync(cur); } catch { return false; }
    if (st.uid !== uid && st.uid !== 0) return false;
    if ((st.mode & 0o022) && !(st.mode & 0o1000)) return false;
    const up = dirname(cur);
    if (up === cur) return true;
    cur = up;
  }
}

/** 이 사용자만 쓰는 폴더인지 확인하고 권한을 좁힌다 */
function privateDir(p: string): void {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('스킬 사본 폴더가 일반 폴더가 아닙니다');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('스킬 사본 폴더의 소유자가 현재 사용자가 아닙니다');
  if (process.platform !== 'win32') chmodSync(p, 0o700);
}

export interface SkillBundle { pluginRoot: string; skills: string[] }

// 실행 중인 시도가 쓰는 사본은 정리하지 않는다(pin → 시도가 끝나면 unpin)
const leases = new Map<string, number>();
function pin(root: string): void { leases.set(root, (leases.get(root) ?? 0) + 1); }
export function unpinSkillBundle(root: string): void { const n = (leases.get(root) ?? 0) - 1; if (n > 0) leases.set(root, n); else leases.delete(root); }

/**
 * 고른 스킬 폴더에서 스킬 파일만 사본으로 묶는다. 같은 내용이면 같은 폴더를 다시 쓴다(동시 실행에도 안전).
 * 반환한 pluginRoot를 --plugin-dir(플러그인 여러 개를 담은 폴더)와 읽기 전용 --add-dir로 넘긴다.
 */
export function prepareSkillBundle(sources: string[], outBase: string): SkillBundle | null {
  const budget = { files: MAX_FILES, bytes: MAX_BYTES };
  const plugins: { name: string; skills: { name: string; root: string; files: FileItem[] }[] }[] = [];
  const used = new Set<string>();
  const seenSkill = new Set<string>();
  for (const src of [...new Set(sources)]) {
    const { name, dirs } = skillDirsIn(src);
    if (!dirs.length) continue;
    let pname = name; let i = 2;
    while (used.has(pname)) pname = `${name}-${i++}`;
    const skills: { name: string; root: string; files: FileItem[] }[] = [];
    for (const d of dirs) {
      const rd = real(d); if (!rd || seenSkill.has(rd) || !ownedChain(rd)) continue; // 같은 스킬이 두 폴더에 링크돼 있으면 한 번만
      seenSkill.add(rd);
      const files = listFiles(rd, budget);
      const sname = slug(basename(d));
      if (files.some((f) => f.rel === 'SKILL.md') && !skills.some((x) => x.name === sname)) skills.push({ name: sname, root: rd, files });
    }
    if (!skills.length) continue;
    used.add(pname);
    plugins.push({ name: pname, skills });
  }
  if (!plugins.length) return null;
  const sig = createHash('sha256');
  for (const p of plugins) for (const s of p.skills) for (const f of s.files) sig.update(`${p.name}\0${s.name}\0${f.rel}\0${f.size}\0${f.mtime}\0${f.abs}\n`);
  const key = sig.digest('hex').slice(0, 16);
  privateDir(outBase);
  const root = join(outBase, key);
  const skillsList = plugins.flatMap((p) => p.skills.map((s) => `${p.name}:${s.name}`));
  if (isFile(join(root, '.complete'))) { try { const t = new Date(); utimesSync(root, t, t); } catch { /* 무시 */ } pin(root); cleanupOld(outBase); return { pluginRoot: root, skills: skillsList }; }
  const tmp = `${root}.tmp-${process.pid}-${Date.now()}`;
  try {
    for (const p of plugins) {
      const pdir = join(tmp, p.name);
      mkdirSync(join(pdir, '.claude-plugin'), { recursive: true });
      writeFileSync(join(pdir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: p.name, version: '0.0.0', description: 'CREWGENAI가 이 PC의 스킬 폴더에서 스킬 파일만 옮긴 읽기 전용 사본' }));
      for (const s of p.skills) for (const f of s.files) {
        const buf = safeRead(f, s.root);
        if (!buf) continue;
        const dst = join(pdir, 'skills', s.name, ...f.rel.split('/'));
        mkdirSync(join(dst, '..'), { recursive: true });
        writeFileSync(dst, f.rel === 'SKILL.md' ? sanitizeSkillMd(buf.toString('utf8')) : buf);
      }
    }
    writeFileSync(join(tmp, '.complete'), skillsList.join('\n'));
    try { renameSync(tmp, root); } catch { rmSync(tmp, { recursive: true, force: true }); } // 다른 실행이 먼저 만들었으면 그것을 쓴다
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  if (!isFile(join(root, '.complete'))) return null;
  pin(root);
  cleanupOld(outBase);
  return { pluginRoot: root, skills: skillsList };
}

/** 7일 동안 쓰지 않은 사본(다시 쓸 때마다 시각을 갱신)과 하루 지난 미완성 사본은 지운다 */
function cleanupOld(base: string): void {
  const now = Date.now();
  for (const n of children(base)) {
    const p = join(base, n);
    if (leases.has(p) || !p.startsWith(base + sep)) continue;
    const age = n.includes('.tmp-') ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
    try { if (statSync(p).mtimeMs < now - age) rmSync(p, { recursive: true, force: true }); } catch { /* 무시 */ }
  }
}
