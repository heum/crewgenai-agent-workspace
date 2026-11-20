// 문서 정리: 사이클마다 쌓이는 보고 문서·화면 사진·앱 기록 파일을 줄여 디스크와 토큰을 아낀다.
// 원칙
// - 앱이 만든 기록 파일(RESULT-<실행>.md, reviews/codex-…-<실행>-v<n>.md)은 내용이 앱 기록(DB)에 그대로 있으므로, 최근 실행 몇 개만 파일로 남긴다.
// - 직원이 만든 사이클별 문서(C100_FRONT.md, DEMO_C10_*.md, cycle-3.md, c98-screens/ 등)는 정해진 사이클마다
//   문서 담당이 폴더별 HISTORY.md로 요약한 뒤에만 앱이 원본을 지운다.
// - 지우는 것은 git에 커밋돼 있고 바뀐 것이 없는 경로뿐이다(git 기록으로 되살릴 수 있음). 커밋되지 않은 파일은 지우지 않는다.
// - 기획의 자동 수정 허용 경로 안, 이름에 'docs' 폴더가 들어간 곳(또는 산출물 폴더)만 본다. 최근 사이클 문서는 남긴다.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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
      if (docsHere && c !== null && c < currentCycle - KEEP_RECENT_CYCLES && (isDoc || e.isDirectory())) {
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
    walk(join(folder, ...r.split('/').filter(Boolean)), r === '.' ? '' : r, 0, r.split('/').includes('docs') || r === outRoot || r.startsWith(`${outRoot}/`));
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder) || a.cycle - b.cycle);
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
