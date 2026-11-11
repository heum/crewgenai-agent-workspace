// 파일 변경 탐지·산출물 분류·형식 검사
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname as _dirname, extname, join, relative, sep } from 'node:path';
import type { ArtifactKind, OutputSpec } from '../../shared/types';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'DerivedData', '.gradle', '.idea', '.DS_Store', '.crewgenai']);
export type Snapshot = Map<string, string>; // rel → "mtimeMs:size"

export const SNAPSHOT_LIMIT = 200000;
const truncated = new WeakSet<Snapshot>();
/** 파일 수 상한에 닿아 일부만 기록한 스냅샷인지 */
export function snapshotTruncated(s: Snapshot | null): boolean { return !!s && truncated.has(s); }
/** Claude 데스크톱·CLI가 만드는 git 작업 트리 사본(.claude/worktrees)은 프로젝트 내용이 아니므로 비교·복사하지 않는다. */
function worktreeCopies(dir: string, name: string) { return name === 'worktrees' && (dir.endsWith(`${sep}.claude`) || dir === '.claude'); }

export function snapshot(root: string, limit = SNAPSHOT_LIMIT): Snapshot {
  const snap: Snapshot = new Map();
  const walk = (dir: string) => {
    if (snap.size >= limit) { truncated.add(snap); return; }
    let ents: import('node:fs').Dirent[];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP_DIRS.has(e.name) || worktreeCopies(dir, e.name)) continue;
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) { try { snap.set(relative(root, p).split(sep).join('/'), `link:${readlinkSync(p)}`); } catch { /* 무시 */ } continue; } // 링크 자체의 변경도 탐지
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { const s = statSync(p); snap.set(relative(root, p).split(sep).join('/'), `${s.mtimeMs}:${s.size}`); } catch { /* 사라짐 */ } }
    }
  };
  walk(root);
  return snap;
}

export function diffSnapshots(a: Snapshot, b: Snapshot): string[] {
  const out = new Set<string>();
  for (const [k, v] of b) if (a.get(k) !== v) out.add(k);
  for (const k of a.keys()) if (!b.has(k)) out.add(k);
  return [...out].sort();
}

export function fileSha(p: string): string {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return ''; }
}

export function classify(rel: string): ArtifactKind {
  const e = extname(rel).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(e)) return 'image';
  if (['.md', '.txt', '.pdf', '.docx', '.html', '.htm', '.rtf'].includes(e)) return /report|result|검증|보고/i.test(rel) ? 'report' : 'document';
  if (['.json', '.csv', '.yaml', '.yml', '.xml', '.sql'].includes(e)) return 'data';
  if (['.app', '.dmg', '.sh', '.command'].includes(e)) return 'executable';
  if (['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.java', '.kt', '.go', '.rs', '.swift', '.css', '.scss', '.c', '.cpp', '.h', '.rb', '.php'].includes(e)) return 'code';
  return 'other';
}

/** 산출물 존재·형식 검사 */
export function checkOutput(root: string, spec: OutputSpec): { ok: boolean; detail: string } {
  const p = join(root, spec.path);
  if (!existsSync(p)) return { ok: !spec.required, detail: spec.required ? '필수 산출물이 없습니다.' : '선택 산출물 없음' };
  const st = statSync(p);
  if (st.isDirectory()) {
    // 폴더 산출물: 형식이 any면 폴더가 있으면 되고, 그 밖에는 폴더 안(하위 포함)에 그 형식의 파일이 하나 이상 있어야 한다
    if (spec.format === 'any') return { ok: true, detail: '폴더 존재' };
    // 일반 파일만 본다(링크는 따라가지 않음 — 자기 자신을 가리키는 링크로 검사가 멈추지 않게)
    const files = [...snapshot(p, 5000).entries()].filter(([r, v]) => !v.startsWith('link:') && !r.split('/').pop()!.startsWith('.')).map(([r]) => r);
    const hits = files.filter((r) => checkOutput(p, { ...spec, path: r, required: true }).ok);
    return hits.length ? { ok: true, detail: `폴더 안 ${spec.format} 파일 ${hits.length}개` } : { ok: false, detail: `폴더 안에 ${spec.format} 형식 파일이 없습니다(파일 ${files.length}개).` };
  }
  if (st.size === 0) return { ok: false, detail: '빈 파일입니다.' };
  const buf = readFileSync(p);
  const text = () => buf.toString('utf8');
  switch (spec.format) {
    case 'json': try { JSON.parse(text()); return { ok: true, detail: 'JSON 형식 확인' }; } catch (e) { return { ok: false, detail: `JSON 형식 오류: ${(e as Error).message}` }; }
    case 'html': return /<(html|body|div|p|h1|!doctype)/i.test(text()) ? { ok: true, detail: 'HTML 확인' } : { ok: false, detail: 'HTML 태그가 없습니다.' };
    case 'markdown': case 'text': case 'code': return text().trim() ? { ok: true, detail: `${spec.format} 내용 확인` } : { ok: false, detail: '내용이 비어 있습니다.' };
    case 'image': {
      const sig = buf.subarray(0, 12).toString('hex');
      const ok = sig.startsWith('89504e47') || sig.startsWith('ffd8ff') || sig.startsWith('47494638') || buf.subarray(8, 12).toString() === 'WEBP' || /<svg/i.test(buf.subarray(0, 512).toString());
      return ok ? { ok: true, detail: '이미지 형식 확인' } : { ok: false, detail: '이미지 형식이 아닙니다.' };
    }
    default: return { ok: true, detail: '존재 확인' };
  }
}

export function relUnder(root: string, abs: string): string | null {
  const r = relative(root, abs);
  return r.startsWith('..') || r === '' ? null : r.split(sep).join('/');
}

// ───────── 격리 실행(Bash 작성자) ─────────
// 프로젝트 복사본에서 실행해 Bash 하위 프로그램이 실제 프로젝트에 직접 쓰지 못하게 한다.
// 실행 후 수정 범위 안의 변경만 실제 프로젝트에 반영하고, 범위 밖 변경은 반영하지 않는다(사전 차단).

const ISO_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'DerivedData', '.gradle', '.DS_Store']);
const ISO_LINK = ['node_modules']; // 의존성 폴더는 링크(읽기용). 변경 탐지 대상이 아니다.

export function isolatedDir(key: string): string {
  return join(tmpdir(), 'crewgenai-iso', createHash('sha256').update(key).digest('hex').slice(0, 16));
}

export interface IsoState { base: Record<string, string>; before: [string, string][] }
const stateFile = (dir: string) => `${dir}.state.json`;

/**
 * 프로젝트를 격리 폴더로 복사한다. 충돌 판단 기준(base)은 복사본의 내용으로 잡는다 — 복사 도중 원본이 바뀌면 반영 때 충돌로 잡힌다.
 * reuse=true(세션 이어서 작업)이면 기존 복사본과 상태를 그대로 쓴다(중단 전 작업 보존).
 */
export function prepareIsolated(project: string, dir: string, inScope: (rel: string) => boolean, reuse: boolean, topLimit?: Set<string>): IsoState {
  if (reuse && existsSync(dir) && existsSync(stateFile(dir))) {
    try { return JSON.parse(readFileSync(stateFile(dir), 'utf8')) as IsoState; } catch { /* 새로 만든다 */ }
  }
  cleanupIsolated(dir);
  mkdirSync(dir, { recursive: true });
  const projReal = realpathSync(project);
  cpSync(project, dir, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (src) => {
    const rel = relative(project, src).split(sep).join('/');
    if (rel !== '' && rel.split('/').some((seg) => ISO_SKIP.has(seg))) return false;
    if (rel.split('/').some((seg, i, a) => seg === 'worktrees' && a[i - 1] === '.claude')) return false;
    if (topLimit && rel.includes('/') === false && rel !== '' && lst(src)?.isDirectory() && !topLimit.has(rel)) return false; // 여러 저장소: 범위 밖 저장소는 복사하지 않음
    if (lst(src)?.isSymbolicLink()) { // 프로젝트 밖을 가리키는 링크는 복사하지 않는다(복사본을 통한 바깥 쓰기 차단)
      try { const t = realpathSync(src); return t === projReal || t.startsWith(projReal + sep); } catch { return false; }
    }
    return true;
  } });
  for (const l of ISO_LINK) { const p = join(project, l); if (existsSync(p)) { try { symlinkSync(p, join(dir, l)); } catch { /* 무시 */ } } }
  // 바로 아래 폴더(여러 저장소 모드의 각 저장소)의 의존성 폴더도 링크한다 — 복사본에서 그 저장소의 검사·시험 명령이 돌도록
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    for (const l of ISO_LINK) { const p = join(project, e.name, l); if (existsSync(p) && !existsSync(join(dir, e.name, l))) { try { symlinkSync(p, join(dir, e.name, l)); } catch { /* 무시 */ } } }
  }
  const snap = snapshot(dir);
  const base: Record<string, string> = {};
  for (const [rel, v] of snap) if (inScope(rel)) base[rel] = v.startsWith('link:') ? v : fileSha(join(dir, rel));
  const st: IsoState = { base, before: [...snap] };
  writeFileSync(stateFile(dir), JSON.stringify(st));
  return st;
}

function lst(p: string) { try { return lstatSync(p); } catch { return null; } }
function deepestExisting(p: string): string { let cur = p; while (!existsSync(cur)) { const parent = _dirname(cur); if (parent === cur) break; cur = parent; } return cur; }

/**
 * 격리 폴더의 범위 안 변경을 실제 프로젝트에 반영한다(전부 반영하거나 전혀 반영하지 않음).
 * - 링크는 반영하지 않는다. 반영 위치(상위 경로 포함)가 프로젝트 밖으로 해석되면 차단한다.
 * - 원본이 복사 시점 이후 바뀐 파일은 충돌로 돌려준다.
 */
export function applyIsolated(project: string, dir: string, changed: string[], base: Record<string, string>): { applied: string[]; conflicts: string[]; blocked: string[] } {
  const projReal = realpathSync(project);
  const conflicts: string[] = []; const blocked: string[] = [];
  const plan: { rel: string; write: boolean }[] = [];
  for (const rel of changed) {
    const src = join(dir, rel); const dst = join(project, rel);
    const anc = realpathSync(deepestExisting(_dirname(dst)));
    if (!(anc === projReal || anc.startsWith(projReal + sep))) { blocked.push(`${rel} (프로젝트 밖으로 해석되는 경로)`); continue; }
    const d = lst(dst); const sl = lst(src);
    if (d?.isSymbolicLink() || sl?.isSymbolicLink()) { blocked.push(`${rel} (링크는 반영하지 않음)`); continue; }
    const nowSha = d ? (d.isFile() ? fileSha(dst) : 'DIR') : '';
    if (nowSha !== (base[rel] ?? '')) { conflicts.push(rel); continue; }
    plan.push({ rel, write: !!sl?.isFile() });
  }
  if (conflicts.length || blocked.length) return { applied: [], conflicts, blocked };
  // 삭제 먼저(파일→폴더 전환 대비), 비워진 폴더도 복사본에 없으면 지운다
  for (const x of plan.filter((y) => !y.write)) {
    const dst = join(project, x.rel);
    if (lst(dst)?.isFile()) unlinkSync(dst);
    let parent = _dirname(dst);
    while (parent.startsWith(project + sep) && !existsSync(join(dir, relative(project, parent)))) {
      try { if (readdirSync(parent).length === 0) rmdirSync(parent); else break; } catch { break; }
      parent = _dirname(parent);
    }
  }
  for (const x of plan.filter((y) => y.write)) { const dst = join(project, x.rel); mkdirSync(_dirname(dst), { recursive: true }); copyFileSync(join(dir, x.rel), dst); }
  return { applied: plan.map((x) => x.rel), conflicts: [], blocked: [] };
}

export function cleanupIsolated(dir: string) { for (const p of [dir, stateFile(dir)]) { try { rmSync(p, { recursive: true, force: true }); } catch { /* 무시 */ } } }
