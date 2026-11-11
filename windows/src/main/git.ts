// git 연결 — 직원별 커밋·스냅샷(태그)·되돌리기(revert).
// 원칙
// - 직원이 바꾼 경로만 커밋한다. 경로는 문자 그대로 해석한다(GIT_LITERAL_PATHSPECS). 사용자가 미리 바꿔 둔 파일은 자동 커밋하지 않는다.
// - push하지 않는다. 되돌리기는 기록을 지우지 않는 git revert로만 한다.
// - 되돌리기 중 충돌하면 진행분을 취소하되, 그 사이 다른 커밋이 생겼으면 되감지 않고 실제 상태를 그대로 알린다.
// - 같은 작업 트리(git dir)를 쓰는 작업은 한 줄로 세워 실행하고, 앱 종료 때 진행 중인 git 작업을 기다린다.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { cleanEnv } from './cli/claudeCli';

export interface GitResult { ok: boolean; out: string; err: string; raw: string }

function git(cwd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 60000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs, env: cleanEnv({ GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', ...env }), maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      resolve({ ok: !e, out: String(stdout).trim(), raw: String(stdout), err: String(stderr).trim() || (e ? e.message : '') });
    });
  });
}

// ───── 저장소(작업 트리)별 순차 실행·종료 대기 ─────
const locks = new Map<string, Promise<unknown>>();
const pending = new Set<Promise<unknown>>();
let closing = false;

async function gitDirKey(folder: string): Promise<string> {
  const r = await git(folder, ['rev-parse', '--git-dir']);
  if (!r.ok) return `nogit:${folder}`;
  const gd = isAbsolute(r.out) ? r.out : join(folder, r.out);
  try { return realpathSync(gd); } catch { return gd; }
}

/** 같은 git dir(작업 트리의 index)를 쓰는 작업은 순서대로 실행한다. 앱 종료가 시작되면 새 작업을 받지 않는다. */
export async function withRepoLock<T>(folder: string, fn: () => Promise<T>): Promise<T> {
  if (closing) throw new Error('앱 종료 중이라 git 작업을 시작하지 않았습니다.');
  const key = await gitDirKey(folder);
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => undefined));
  pending.add(next); void next.finally(() => pending.delete(next)).catch(() => undefined);
  return next;
}

/** 앱 종료: 새 git 작업을 막고 진행 중인 작업이 끝날 때까지(최대 timeoutMs) 기다린다. */
export async function gitShutdown(timeoutMs = 15000) {
  closing = true;
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs))]);
}

// ───── 조회 ─────
export async function gitRoot(folder: string): Promise<string | null> {
  const r = await git(folder, ['rev-parse', '--show-toplevel']);
  return r.ok && r.out ? r.out : null;
}
export async function gitHasCommit(folder: string): Promise<boolean> {
  return (await git(folder, ['rev-parse', '--verify', '-q', 'HEAD'])).ok;
}

/** 병합·리베이스·체리픽·되돌리기 진행 중이면 커밋하지 않는다. */
export async function gitBusy(folder: string): Promise<string | null> {
  const r = await git(folder, ['rev-parse', '--git-dir']);
  if (!r.ok) return 'git 저장소가 아닙니다.';
  const gd = isAbsolute(r.out) ? r.out : join(folder, r.out);
  for (const [f, label] of [['MERGE_HEAD', '병합'], ['rebase-merge', '리베이스'], ['rebase-apply', '리베이스'], ['CHERRY_PICK_HEAD', '체리픽'], ['REVERT_HEAD', '되돌리기']] as const) {
    if (existsSync(join(gd, f))) return `git ${label}가 진행 중이라 커밋하지 않았습니다.`;
  }
  return null;
}

/** 지금 변경·스테이징·미추적 상태인 경로(작업 시작 전 사용자 변경 판별용, folder 기준 상대 경로) */
export async function dirtyPaths(folder: string): Promise<Set<string>> {
  const r = await git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  const out = new Set<string>();
  if (!r.ok) return out;
  const prefix = (await git(folder, ['rev-parse', '--show-prefix'])).out;
  const parts = r.raw.split('\0').filter(Boolean); // 앞 공백(상태 코드)이 의미가 있으므로 다듬지 않은 원문을 쓴다
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]; const code = e.slice(0, 2); let p = e.slice(3);
    if (code.includes('R') || code.includes('C')) i++; // 이름 바꾸기는 다음 항목이 원래 이름
    if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
    out.add(p);
  }
  return out;
}

/** 커미터: 사용자 git 설정을 쓰고, 없으면 CREWGENAI. 커밋과 되돌리기에 같은 규칙을 쓴다. */
async function committerEnv(folder: string): Promise<Record<string, string>> {
  const e = await git(folder, ['config', 'user.email']);
  const n = await git(folder, ['config', 'user.name']);
  return e.ok && e.out && n.ok && n.out ? {} : { GIT_COMMITTER_NAME: 'CREWGENAI', GIT_COMMITTER_EMAIL: 'crewgenai@localhost' };
}

export interface CommitInfo { sha: string | null; skipped: string | null; error: string | null }

/**
 * 지정한 경로만 커밋한다(문자 그대로의 경로). 작성자 = 직원, 커미터 = 사용자 git 설정(없으면 CREWGENAI).
 * exclude: 작업 시작 전에 이미 사용자 변경이 있던 경로 — 사용자 변경이 섞이지 않도록 자동 커밋하지 않는다.
 */
export function commitPaths(folder: string, paths: string[], author: { name: string; email: string }, subject: string, trailers: Record<string, string>, exclude: Set<string> = new Set()): Promise<CommitInfo> {
  return withRepoLock(folder, () => commitNow(folder, paths, author, subject, trailers, exclude)).catch((e) => ({ sha: null, skipped: null, error: (e as Error).message }));
}
async function commitNow(folder: string, paths: string[], author: { name: string; email: string }, subject: string, trailers: Record<string, string>, exclude: Set<string>): Promise<CommitInfo> {
  const all = [...new Set(paths.filter((p) => p && !p.startsWith('..') && !isAbsolute(p)))];
  const held = all.filter((p) => exclude.has(p));
  const rel = all.filter((p) => !exclude.has(p));
  const heldNote = held.length ? ` (사용자 미커밋 변경이 있던 파일은 자동 커밋하지 않음: ${held.slice(0, 5).join(', ')}${held.length > 5 ? ' 외' : ''})` : '';
  if (!rel.length) return { sha: null, skipped: `커밋할 파일 없음${heldNote}`, error: null };
  if (!(await gitRoot(folder))) return { sha: null, skipped: 'git 저장소가 아님', error: null };
  const busy = await gitBusy(folder);
  if (busy) return { sha: null, skipped: busy, error: null };
  const add = await git(folder, ['add', '-A', '--', ...rel]);
  if (!add.ok) return { sha: null, skipped: null, error: `git add 실패: ${add.err.slice(0, 300)}` };
  const staged = await git(folder, ['diff', '--cached', '--name-only', '--', ...rel]);
  if (!staged.out) return { sha: null, skipped: `커밋할 변경 없음(이미 같은 내용)${heldNote}`, error: null };
  const msg = `${subject}\n\n${Object.entries(trailers).filter(([, v]) => v).map(([k, v]) => `${k}: ${v.replace(/\n/g, ' ')}`).join('\n')}\n`;
  // 경로 지정 커밋: 사용자가 미리 스테이징해 둔 다른 경로는 이 커밋에 들어가지 않는다
  const c = await git(folder, ['commit', '-m', msg, '--', ...rel], { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, ...(await committerEnv(folder)) });
  if (!c.ok) return { sha: null, skipped: null, error: `git commit 실패: ${(c.err || c.out).slice(0, 400)}` };
  const head = await git(folder, ['rev-parse', 'HEAD']);
  return { sha: head.out || null, skipped: heldNote ? heldNote.trim() : null, error: null };
}

export function tagSnapshot(folder: string, tag: string): Promise<{ sha: string | null; error: string | null }> {
  return withRepoLock(folder, async () => {
    if (!(await gitRoot(folder))) return { sha: null, error: 'git 저장소가 아님' };
    const head = await git(folder, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (!head.ok) return { sha: null, error: '아직 커밋이 없는 저장소라 스냅샷을 남기지 못했습니다.' };
    const t = await git(folder, ['tag', '-f', tag, head.out]);
    return t.ok ? { sha: head.out, error: null } : { sha: null, error: t.err };
  }).catch((e) => ({ sha: null, error: (e as Error).message }));
}

/** 스냅샷 이후 이 미션이 만든 커밋(최신 → 과거) */
export async function missionCommitsSince(folder: string, sinceSha: string, missionId: string): Promise<{ sha: string; subject: string; author: string }[]> {
  const r = await git(folder, ['log', '--format=%H%x1f%s%x1f%an', '--fixed-strings', `--grep=Crewgenai-Mission: ${missionId}`, `${sinceSha}..HEAD`]);
  if (!r.ok || !r.out) return [];
  return r.out.split('\n').map((l) => { const [sha, subject, author] = l.split('\x1f'); return { sha, subject, author }; });
}

const REVERT_AUTHOR = { GIT_AUTHOR_NAME: 'CREWGENAI 되돌리기', GIT_AUTHOR_EMAIL: 'revert@crewgenai.local' };

/**
 * 커밋들을 최신부터 revert한다. 충돌하면 진행 중 revert를 취소하고, 이번에 만든 되돌리기 커밋만 있었을 때에 한해
 * 되돌리기 전 HEAD로 되감는다(그 사이 다른 커밋이 생겼으면 되감지 않고 실제 상태를 알린다).
 */
export function revertCommits(folder: string, shas: string[]): Promise<{ ok: boolean; reverted: string[]; error: string | null }> {
  return withRepoLock(folder, () => revertNow(folder, shas)).catch((e) => ({ ok: false, reverted: [], error: (e as Error).message }));
}
async function revertNow(folder: string, shas: string[]): Promise<{ ok: boolean; reverted: string[]; error: string | null }> {
  if (!shas.length) return { ok: true, reverted: [], error: null };
  const busy = await gitBusy(folder);
  if (busy) return { ok: false, reverted: [], error: busy };
  const before = (await git(folder, ['rev-parse', 'HEAD'])).out;
  const env = { ...REVERT_AUTHOR, ...(await committerEnv(folder)) };
  const done: string[] = []; const mine: string[] = [];
  for (const sha of shas) {
    const r = await git(folder, ['revert', '--no-edit', sha], env);
    if (!r.ok) {
      const abort = await git(folder, ['revert', '--abort']);
      const stillBusy = await gitBusy(folder);
      let rewound = false; let note = '';
      if (mine.length) {
        // 되감기 전 확인: before 이후 커밋이 정확히 이번에 만든 되돌리기 커밋들뿐인지
        const between = (await git(folder, ['rev-list', `${before}..HEAD`])).out.split('\n').filter(Boolean);
        if (between.length === mine.length && between.every((c) => mine.includes(c))) {
          const reset = await git(folder, ['reset', '--keep', before]);
          rewound = reset.ok;
          if (!reset.ok) note = ` 진행분 되감기 실패: ${reset.err.slice(0, 200)}.`;
        } else note = ' 되돌리는 사이 다른 커밋이 생겨 진행분을 되감지 않았습니다.';
      }
      const state = stillBusy ? ' 저장소에 진행 중인 revert가 남아 있어 직접 확인이 필요합니다(`git revert --abort`).' : '';
      const applied = rewound || !mine.length ? [] : done;
      return { ok: false, reverted: applied,
        error: `되돌리기 충돌로 중단했습니다(${sha.slice(0, 8)}): ${(r.err || r.out).slice(0, 300)}.${abort.ok || !stillBusy ? '' : ' 진행 중 revert 취소 실패.'}${note}${state}${applied.length ? ` 적용된 되돌리기 커밋 ${applied.length}개가 남아 있습니다.` : ' 저장소는 되돌리기 전 커밋 상태입니다.'}` };
    }
    done.push(sha);
    mine.push((await git(folder, ['rev-parse', 'HEAD'])).out);
  }
  return { ok: true, reverted: done, error: null };
}

export function agentIdentity(code: string, name: string): { name: string; email: string } {
  return { name: `CREWGENAI ${code} ${name}`.trim(), email: `agent-${code || 'xx'}@crewgenai.local` };
}

// ───── 여러 저장소(상위 폴더) 지원 ─────
// 연결 폴더가 git 저장소가 아니어도, 바로 아래 폴더들이 각자 git 저장소이면 저장소별로 커밋·스냅샷·되돌리기를 한다.
// 경로는 항상 연결 폴더 기준 상대 경로로 주고받고, 저장소 안에서는 그 저장소 기준 경로로 바꾼다.
export interface RepoInfo { rel: string; abs: string; hasCommit: boolean }
export interface Workspace { mode: 'single' | 'multi' | 'none'; repos: RepoInfo[] }

export async function workspaceRepos(folder: string): Promise<Workspace> {
  if (!folder || !existsSync(folder)) return { mode: 'none', repos: [] };
  if (await gitRoot(folder)) return { mode: 'single', repos: [{ rel: '', abs: folder, hasCommit: await gitHasCommit(folder) }] };
  let names: string[] = [];
  try { names = readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { /* 읽지 못함 */ }
  const repos: RepoInfo[] = [];
  for (const n of names) {
    const abs = join(folder, n);
    if (!existsSync(join(abs, '.git'))) continue;
    const root = await gitRoot(abs);
    let same = false;
    // Windows: git은 /로 된 긴 경로를, 임시 폴더 등은 8.3 짧은 이름(RUNNER~1)을 줄 수 있어 실제 경로로 바꿔 대소문자 없이 비교한다
    try { same = !!root && realpathSync.native(root).toLowerCase() === realpathSync.native(abs).toLowerCase(); } catch { /* 무시 */ }
    if (same) repos.push({ rel: n, abs, hasCommit: await gitHasCommit(abs) });
  }
  return repos.length ? { mode: 'multi', repos } : { mode: 'none', repos: [] };
}

/** 연결 폴더 기준 경로 → 그 경로가 속한 저장소와 저장소 기준 경로. 어느 저장소에도 속하지 않으면 null. */
export function repoOf(ws: Workspace, p: string): { repo: RepoInfo; inner: string } | null {
  for (const r of ws.repos) {
    if (r.rel === '') return { repo: r, inner: p };
    if (p.startsWith(r.rel + '/')) return { repo: r, inner: p.slice(r.rel.length + 1) };
  }
  return null;
}

/** 모든 저장소의 사용자 변경 경로(연결 폴더 기준). */
export async function workspaceDirtyPaths(folder: string, ws?: Workspace): Promise<Set<string>> {
  const w = ws ?? await workspaceRepos(folder);
  const out = new Set<string>();
  for (const r of w.repos) for (const p of await dirtyPaths(r.abs)) out.add(r.rel ? `${r.rel}/${p}` : p);
  return out;
}

export interface MultiCommit { sha: string | null; skipped: string | null; error: string | null; commits: { repo: string; sha: string }[] }

/** 경로를 저장소별로 나눠 각 저장소에 따로 커밋한다. 저장소 밖 경로와 커밋이 없는 저장소는 커밋하지 않고 이유를 남긴다. */
export async function commitWorkspace(folder: string, paths: string[], author: { name: string; email: string }, subject: string, trailers: Record<string, string>, exclude: Set<string> = new Set()): Promise<MultiCommit> {
  const w = await workspaceRepos(folder);
  if (w.mode === 'single') {
    const r = await commitPaths(folder, paths, author, subject, trailers, exclude);
    return { ...r, commits: r.sha ? [{ repo: '', sha: r.sha }] : [] };
  }
  if (w.mode === 'none') return { sha: null, skipped: 'git 저장소가 아님', error: null, commits: [] };
  const groups = new Map<RepoInfo, { paths: string[]; exclude: Set<string> }>();
  const outside: string[] = [];
  for (const p of paths) {
    const hit = repoOf(w, p);
    if (!hit) { outside.push(p); continue; }
    const g = groups.get(hit.repo) ?? { paths: [], exclude: new Set<string>() };
    g.paths.push(hit.inner);
    if (exclude.has(p)) g.exclude.add(hit.inner);
    groups.set(hit.repo, g);
  }
  const commits: { repo: string; sha: string }[] = []; const notes: string[] = []; const errors: string[] = [];
  for (const [repo, g] of groups) {
    if (!repo.hasCommit) { notes.push(`${repo.rel}: 커밋이 없는 저장소라 자동 커밋하지 않음`); continue; }
    const r = await commitPaths(repo.abs, g.paths, author, subject, trailers, g.exclude);
    if (r.sha) commits.push({ repo: repo.rel, sha: r.sha });
    if (r.error) errors.push(`${repo.rel}: ${r.error}`);
    else if (r.skipped) notes.push(`${repo.rel}: ${r.skipped}`);
  }
  if (outside.length) notes.push(`저장소 밖 파일은 커밋하지 않음: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ' 외' : ''}`);
  return {
    sha: commits.length ? commits.map((c) => `${c.repo}@${c.sha.slice(0, 8)}`).join(' ') : null,
    skipped: notes.length ? notes.join(' / ') : null, error: errors.length ? errors.join(' / ') : null, commits,
  };
}

/** 저장소별 현재 HEAD(스냅샷 기준점). 여러 저장소 모드에서는 태그를 만들지 않고 앱 기록에만 남긴다(건드리지 않은 저장소에 태그를 늘리지 않음). */
export async function workspaceHeads(folder: string): Promise<{ repo: string; abs: string; sha: string }[]> {
  const w = await workspaceRepos(folder);
  const out: { repo: string; abs: string; sha: string }[] = [];
  for (const r of w.repos) {
    const h = await git(r.abs, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (h.ok && h.out) out.push({ repo: r.rel, abs: r.abs, sha: h.out });
  }
  return out;
}
