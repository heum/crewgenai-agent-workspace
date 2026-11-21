// 문서 정리: 사이클마다 쌓이는 보고 문서·화면 사진·앱 기록 파일을 줄여 디스크와 토큰을 아낀다.
// 원칙
// - 앱이 만든 기록 파일(RESULT-<실행>.md, reviews/codex-…-<실행>-v<n>.md)은 내용이 앱 기록(DB)에 그대로 있으므로, 최근 실행 몇 개만 파일로 남긴다.
// - 직원이 만든 사이클별 문서(C100_FRONT.md, DEMO_C10_*.md, cycle-3.md, c98-screens/ 등)는 정해진 사이클마다
//   (2026-11-21 사용자 결정으로 md 문서는 지우지 않는다. 사이클 문서 찾기는 시험·참고용으로만 남음)
// - 지우는 것은 git에 커밋돼 있고 바뀐 것이 없는 경로뿐이다(git 기록으로 되살릴 수 있음). 커밋되지 않은 파일은 지우지 않는다.
// - 기획의 자동 수정 허용 경로 안, 이름에 'docs' 폴더가 들어간 곳(또는 산출물 폴더)만 본다. 최근 사이클 문서는 남긴다.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

/** 실제 경로가 연결 폴더 안인가(중간 경로가 링크로 밖을 가리키면 거짓) */
export function realInside(folder: string, abs: string): boolean {
  try {
    if (lstatSync(abs).isSymbolicLink()) return false;
    const root = realpathSync(folder); const real = realpathSync(abs); const r = relative(root, real);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  } catch { return false; }
}

export const KEEP_RUN_FILES = 5; // 앱 기록 파일을 남길 최근 실행 수
export const TIDY_EVERY = 10; // 사이클별 문서를 요약·정리하는 간격(사이클)
export const KEEP_RECENT_CYCLES = 3; // 이보다 최근 사이클 문서는 정리하지 않는다
export const TIDY_MAX_FOLDERS = 4; // 한 번에 요약할 폴더 수
export const TIDY_MAX_FILES = 40; // 폴더마다 한 번에 요약할 문서 수(남으면 3사이클 뒤 이어서)
const MIN_AGE_MS = 24 * 3600 * 1000;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'venv', '.venv', '__pycache__', '.claude', 'release', 'coverage']);

/** 이름에서 사이클 번호를 읽는다: C100_FRONT.md, DEMO_C10_FRONT.md, C106A_x.md, c98-screens, cycle-3.md */
export function cycleOf(name: string): number | null {
  const m = /(?:^|[_\-.\s])(?:[Cc]|[Cc]ycle[-_]?)(\d{1,4})[A-Za-z]?(?=[_\-.\s]|$)/.exec(name);
  return m ? Number(m[1]) : null;
}

export interface CycleDoc { rel: string; cycle: number; dir: boolean; bytes: number; folder: string }

const REPORT_EXT = /\.(png|jpe?g|gif|webp|svg|html?|md|txt|log)$/i;
/** 폴더 안이 사진·보고 파일뿐인가(하위 폴더 포함, 최대 2000개까지 봄) */
function onlyReportFiles(abs: string): boolean {
  let n = 0; const stack = [abs];
  while (stack.length) {
    const p = stack.pop()!; let ents; try { ents = readdirSync(p, { withFileTypes: true }); } catch { return false; }
    for (const e of ents) { if (++n > 2000 || e.isSymbolicLink()) return false; if (e.isDirectory()) stack.push(join(p, e.name)); else if (!REPORT_EXT.test(e.name)) return false; }
  }
  return n > 0;
}
/** 지우기 직전 확인: 연결 폴더 기준 경로가 링크 없이 그대로 그 자리에 있는가 */
export function samePlace(folder: string, rel: string): boolean {
  try { return realpathSync(join(folder, ...rel.split('/'))) === join(realpathSync(folder), ...rel.split('/')); } catch { return false; }
}
/** 폴더 안 파일 크기 합과 가장 최근에 바뀐 시각 */
function sizeOf(abs: string, cap = 5000): { bytes: number; newest: number } {
  let total = 0; let newest = 0; let n = 0; const stack = [abs];
  while (stack.length && n < cap) {
    const p = stack.pop()!; n++;
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { try { for (const e of readdirSync(p)) stack.push(join(p, e)); } catch { /* 무시 */ } } else { total += st.size; newest = Math.max(newest, st.mtimeMs); }
  }
  return { bytes: total, newest };
}

/** 허용 경로 안 docs 폴더(또는 산출물 폴더)에서 정리할 만한 사이클별 문서·폴더를 찾는다 */
export function findCycleDocs(folder: string, roots: string[], outputDir: string, currentCycle: number, now = Date.now()): CycleDoc[] {
  const out: CycleDoc[] = []; let seen = 0;
  const outRoot = outputDir.replace(/\/+$/, '');
  const walk = (abs: string, rel: string, depth: number, inDocs: boolean) => {
    if (depth > 7 || seen > 30000) return;
    let ents; try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      seen++;
      if (e.isSymbolicLink() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name; const a = join(abs, e.name);
      const docsHere = inDocs || e.name === 'docs' || r === outRoot || r.startsWith(`${outRoot}/`);
      if (r === `${outRoot}/reviews`) continue; // 앱 기록은 따로 정리
      const c = cycleOf(e.name);
      const isDoc = e.isFile() && /\.(md|html?)$/i.test(e.name) && e.name !== 'HISTORY.md';
      // 폴더는 화면 사진·보고 폴더로 보일 때만(이름에 screen·shot, 또는 안에 사진·문서만) — 사이클 번호가 붙은 일반 자료 폴더는 건드리지 않는다
      const reportDir = e.isDirectory() && (/screen|shot/i.test(e.name) || onlyReportFiles(a));
      if (docsHere && c !== null && c < currentCycle - KEEP_RECENT_CYCLES && (isDoc || reportDir)) {
        let st; try { st = statSync(a); } catch { continue; }
        const sz = e.isDirectory() ? sizeOf(a) : { bytes: st.size, newest: st.mtimeMs };
        if (now - sz.newest < MIN_AGE_MS) continue;
        const parts = r.split('/'); parts.pop();
        out.push({ rel: r, cycle: c, dir: e.isDirectory(), bytes: sz.bytes, folder: parts.join('/') || '.' });
        continue; // 정리 대상 폴더 안은 더 보지 않는다
      }
      if (e.isDirectory()) walk(a, r, depth + 1, docsHere);
    }
  };
  for (const root of roots) {
    const r = root.replace(/^\.\/+/, '').replace(/\/+$/, '');
    const start = join(folder, ...r.split('/').filter(Boolean));
    if (!realInside(folder, start)) continue; // 링크로 연결 폴더 밖을 가리키는 시작 경로는 보지 않는다
    walk(start, r === '.' ? '' : r, 0, r.split('/').includes('docs') || r === outRoot || r.startsWith(`${outRoot}/`));
  }
  const uniq = new Map(out.map((d) => [d.rel, d])); // 허용 경로가 겹치면 같은 문서를 두 번 넣지 않는다
  return [...uniq.values()].sort((a, b) => a.folder.localeCompare(b.folder) || a.cycle - b.cycle);
}

/** 앱이 만든 실행 기록 파일 중 남길 실행에 속하지 않는 것(산출물 폴더 기준 상대 경로) */
export function staleRunFiles(folder: string, outputDir: string, projectRuns8: Set<string>, keep8: Set<string>): string[] {
  const base = join(folder, ...outputDir.split('/').filter(Boolean)); const out: string[] = [];
  const pick = (dir: string, re: RegExp) => {
    let names: string[] = []; try { names = readdirSync(dir); } catch { return; }
    for (const n of names) { const m = re.exec(n); if (m && projectRuns8.has(m[1]) && !keep8.has(m[1])) out.push(relative(folder, join(dir, n)).split(sep).join('/')); }
  };
  pick(base, /^RESULT-([0-9a-f]{8})\.md$/);
  pick(join(base, 'reviews'), /^codex-.*-([0-9a-f]{8})-v\d+\.md$/);
  return out;
}

export const fmtBytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;

/** 폴더별로 묶는다 */
export function groupByFolder(docs: CycleDoc[]): { folder: string; items: CycleDoc[]; bytes: number }[] {
  const m = new Map<string, CycleDoc[]>();
  for (const d of docs) m.set(d.folder, [...(m.get(d.folder) ?? []), d]);
  return [...m.entries()].map(([folder, items]) => ({ folder, items, bytes: items.reduce((s, x) => s + x.bytes, 0) }));
}

// ───── 사이클별 시연 빌드(.next-demo-c98, .demo-data-c31 같은 숨김 폴더) ─────
// 시연할 때마다 사이클 번호를 붙여 새로 만든 빌드·데이터 폴더. 다시 만들 수 있지만 크다(폴더마다 100~300MB).
// 지우는 대상: 시연 목록(demo/*.json, 지난 사본 포함)에 이름이 한 번이라도 등록된 폴더만(앱 시연용으로 만든 빌드라는 근거). 이름 모양만 같은 다른 폴더(백업 등)는 건드리지 않는다.
// 남기는 것: 같은 종류(저장소·이름 앞부분)에서 가장 최근 사이클, 지금 시연 목록이 가리키는 것, 하루 안에 바뀐 것, 실행 중인 서버가 연 것.
// 지우는 것은 git이 무시하는(추적하지 않는) 폴더뿐이다 — 이 검사는 부르는 쪽에서 한다.
export const BUILD_DIR = /^(\.[A-Za-z][\w.-]*?)-c(\d{1,4})$/;
export interface BuildDir { rel: string; abs: string; group: string; cycle: number; bytes: number }

export function findStaleBuilds(folder: string, roots: string[], manifestText: string, now = Date.now(), registered: Set<string> = new Set()): BuildDir[] {
  const all: (BuildDir & { newest: number })[] = [];
  const look = (abs: string, rel: string) => {
    let ents; try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const m = BUILD_DIR.exec(e.name); if (!m) continue;
      const repo = abs.split(/[\\/]/).filter(Boolean).pop() ?? ''; if (!registered.has(`${repo}/${e.name}`)) continue; // 그 저장소의 시연용으로 등록된 폴더만
      const a = join(abs, e.name); const sz = sizeOf(a, 20000);
      all.push({ rel: rel ? `${rel}/${e.name}` : e.name, abs: a, group: `${rel}|${m[1]}`, cycle: Number(m[2]), bytes: sz.bytes, newest: sz.newest });
    }
  };
  const seen = new Set<string>();
  for (const root of roots) {
    const r = root.replace(/^\.\/+/, '').replace(/\/+$/, ''); const rr = r === '.' ? '' : r;
    const abs = join(folder, ...rr.split('/').filter(Boolean));
    if (!realInside(folder, abs)) continue;
    // 허용 경로 자체와 바로 아래 폴더(여러 저장소를 담은 상위 폴더를 연결한 경우)까지 본다
    for (const [a, rel] of [[abs, rr] as const, ...(() => { try { return readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)).map((e) => [join(abs, e.name), rr ? `${rr}/${e.name}` : e.name] as const); } catch { return []; } })()]) {
      if (seen.has(a)) continue; seen.add(a); look(a, rel);
    }
  }
  const newestCycle = new Map<string, number>();
  for (const b of all) newestCycle.set(b.group, Math.max(newestCycle.get(b.group) ?? -1, b.cycle));
  return all.filter((b) => b.cycle < (newestCycle.get(b.group) ?? 0) && !manifestText.includes(b.rel.split('/').pop()!) && now - b.newest >= MIN_AGE_MS)
    .map(({ newest: _n, ...b }) => b).sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 실행 중인 node·java 프로세스가 연 파일이 들어 있는 폴더(확인할 수 없으면 모두 쓰는 중으로 본다) */
export function dirsInUse(dirs: string[]): Promise<Set<string>> {
  if (!dirs.length) return Promise.resolve(new Set());
  if (process.platform === 'win32') return Promise.resolve(new Set(dirs)); // Windows: 열린 파일을 확인할 수 없어 지우지 않는다(실행 중인 시연을 반쯤 지우지 않게)
  return new Promise((resolve) => {
    execFile('lsof', ['-n', '-P', '-F', 'n', '-c', 'node', '-c', 'java', '-c', 'next-server'], { timeout: 20000, maxBuffer: 64 * 1024 * 1024 }, (e, stdout) => {
      const text = String(stdout ?? '');
      if (e && !text) { resolve(new Set(dirs)); return; }
      const paths = text.split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
      resolve(new Set(dirs.filter((d) => paths.some((p) => p === d || p.startsWith(d + sep)))));
    });
  });
}

export function manifestText(path: string): string { try { return readFileSync(path, 'utf8').slice(0, 600_000); } catch { return ''; } }
/**
 * 시연 목록 폴더의 모든 json(지난 사본 포함)에서 시연용으로 등록된 적 있는 빌드 폴더를 '저장소/폴더' 쌍으로 모은다.
 * - 서비스 항목(repo가 있는 객체) 안의 값이 폴더 이름과 정확히 같으면 그 저장소의 폴더
 * - 어느 값이든 '…/<저장소>/<폴더>…' 경로를 담고 있으면 그 저장소의 폴더
 */
export function registeredBuilds(manifestPath: string): Set<string> {
  const dir = join(manifestPath, '..'); const out = new Set<string>();
  const strings = (v: unknown, acc: string[]) => { if (typeof v === 'string') acc.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, acc)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, acc)); return acc; };
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.repo === 'string' && o.repo.trim()) { const repo = o.repo.trim().replace(/\/+$/, '').split('/').pop()!; for (const s of strings(o, [])) if (BUILD_DIR.test(s.trim())) out.add(`${repo}/${s.trim()}`); }
    Object.values(o).forEach(visit);
  };
  let names: string[] = []; try { names = readdirSync(dir).filter((n) => /\.json$/i.test(n)); } catch { return out; }
  for (const n of names) {
    let text = ''; try { text = readFileSync(join(dir, n), 'utf8').slice(0, 600_000); } catch { continue; }
    try { visit(JSON.parse(text)); } catch { /* 형식이 깨진 사본은 경로 문자열만 본다 */ }
    for (const m of text.matchAll(/([A-Za-z0-9_.-]+)\/(\.[A-Za-z][\w.-]*?-c\d{1,4})(?=[\/"'\s]|$)/g)) out.add(`${m[1]}/${m[2]}`);
  }
  return out;
}
