// git 연결 — 직원별 커밋·스냅샷(태그)·되돌리기(revert).
// 원칙
// - 직원이 바꾼 경로만 커밋한다. 경로는 문자 그대로 해석한다(GIT_LITERAL_PATHSPECS). 사용자가 미리 바꿔 둔 파일은 자동 커밋하지 않는다.
// - push하지 않는다. 되돌리기는 기록을 지우지 않는 git revert로만 한다.
// - 되돌리기 중 충돌하면 진행분을 취소하되, 그 사이 다른 커밋이 생겼으면 되감지 않고 실제 상태를 그대로 알린다.
// - 같은 작업 트리(git dir)를 쓰는 작업은 한 줄로 세워 실행하고, 앱 종료 때 진행 중인 git 작업을 기다린다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { PROTECTED_BRANCHES } from './autopilot';
import { cleanEnv } from './cli/claudeCli';

export interface GitResult { ok: boolean; out: string; err: string; raw: string; code: number }

function git(cwd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 60000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs, env: cleanEnv({ GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', ...env }), maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      const code = !e ? 0 : typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -1;
      resolve({ ok: !e, out: String(stdout).trim(), raw: String(stdout), err: String(stderr).trim() || (e ? e.message : ''), code });
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
/** 저장소 기준 경로가 .gitignore로 무시되는가 */
export async function gitIgnored(repo: string, rel: string): Promise<boolean> {
  // check-ignore는 GIT_LITERAL_PATHSPECS를 받지 않는다(그 환경에서는 오류) — 이 명령만 끈다. 경로는 앱이 검사한 .env 경로뿐이다
  return (await git(repo, ['check-ignore', '-q', '--no-index', '--', rel], { GIT_LITERAL_PATHSPECS: '0' })).ok;
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
export function commitPaths(folder: string, paths: string[], author: { name: string; email: string }, subject: string, trailers: Record<string, string>, exclude: Set<string> = new Set(), workBranch?: string): Promise<CommitInfo> {
  return withRepoLock(folder, () => commitNow(folder, paths, author, subject, trailers, exclude, workBranch)).catch((e) => ({ sha: null, skipped: null, error: (e as Error).message }));
}

/**
 * 보호 브랜치(dev·main 등)에 있으면 작업 브랜치로 옮긴다. 작업 트리의 변경(직원 변경·사용자 미커밋 변경)은 그대로 따라간다.
 * - 같은 이름이 없으면 지금 커밋에서 새로 만든다.
 * - 있고 그 브랜치의 커밋이 모두 지금 브랜치에 들어 있으면(병합됐거나 뒤처짐) 지금 커밋으로 다시 맞춘다.
 * - 있고 지금 브랜치에 없는 커밋이 있으면 섞지 않도록 뒤에 번호를 붙인 새 브랜치를 만든다.
 * 분리된 HEAD(detached)나 보호 브랜치가 아니면 그대로 둔다.
 */
async function ensureWorkBranch(folder: string, name: string, pre: string[] = []): Promise<{ note: string | null; error: string | null; target?: string }> {
  const cur = await git(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!cur.ok || !PROTECTED_BRANCHES.has(cur.out)) return { note: null, error: null };
  if (!(await git(folder, ['check-ref-format', '--branch', name])).ok) return { note: null, error: `작업 브랜치 이름이 올바르지 않습니다: ${name}` };
  let target = name; let args = ['switch', '-c', name];
  if ((await git(folder, ['rev-parse', '--verify', '-q', `refs/heads/${name}`])).ok) {
    if ((await git(folder, ['merge-base', '--is-ancestor', `refs/heads/${name}`, 'HEAD'])).ok) args = ['switch', '-C', name];
    else {
      let n = 2;
      while (n < 50 && (await git(folder, ['rev-parse', '--verify', '-q', `refs/heads/${name}-${n}`])).ok) n++;
      target = `${name}-${n}`; args = ['switch', '-c', target];
    }
  }
  const r = await git(folder, [...pre, ...args]);
  if (!r.ok) return { note: null, error: `${cur.out}에 바로 커밋하지 않으려고 작업 브랜치 ${target}로 바꾸려 했으나 실패해 커밋하지 않았습니다: ${(r.err || r.out).slice(0, 200)}` };
  return { note: `${cur.out}에 바로 커밋하지 않고 작업 브랜치 ${target}에 커밋`, error: null, target };
}

async function commitNow(folder: string, paths: string[], author: { name: string; email: string }, subject: string, trailers: Record<string, string>, exclude: Set<string>, workBranch?: string): Promise<CommitInfo> {
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
  // 커밋할 변경이 있을 때만 브랜치를 옮긴다(스테이징한 변경도 그대로 따라간다)
  let branchNote = '';
  if (workBranch && await gitHasCommit(folder)) {
    const b = await ensureWorkBranch(folder, workBranch);
    if (b.error) return { sha: null, skipped: null, error: b.error };
    if (b.note) branchNote = ` (${b.note})`;
  }
  const msg = `${subject}\n\n${Object.entries(trailers).filter(([, v]) => v).map(([k, v]) => `${k}: ${v.replace(/\n/g, ' ')}`).join('\n')}\n`;
  // 경로 지정 커밋: 사용자가 미리 스테이징해 둔 다른 경로는 이 커밋에 들어가지 않는다
  const c = await git(folder, ['commit', '-m', msg, '--', ...rel], { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, ...(await committerEnv(folder)) });
  if (!c.ok) return { sha: null, skipped: null, error: `git commit 실패: ${(c.err || c.out).slice(0, 400)}` };
  const head = await git(folder, ['rev-parse', 'HEAD']);
  const note = `${heldNote}${branchNote}`.trim();
  return { sha: head.out || null, skipped: note || null, error: null };
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
export async function commitWorkspace(folder: string, paths: string[], author: { name: string; email: string }, subject: string, trailers: Record<string, string>, exclude: Set<string> = new Set(), workBranch?: string): Promise<MultiCommit> {
  const w = await workspaceRepos(folder);
  if (w.mode === 'single') {
    const r = await commitPaths(folder, paths, author, subject, trailers, exclude, workBranch);
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
    const r = await commitPaths(repo.abs, g.paths, author, subject, trailers, g.exclude, workBranch);
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

/**
 * 문서 저장소 최신화: 보호 브랜치(dev·main 등)에 있고 추적 브랜치가 있을 때만 받아 와서 fast-forward한다.
 * 병합 커밋을 만들지 않고, 사용자 미커밋 변경과 겹치면 git이 거부하므로 그대로 둔다. 사용자 커밋이 앞서 있으면 건드리지 않는다.
 */
export function syncRepoFastForward(abs: string, timeoutMs = 30000): Promise<{ moved: boolean; note: string | null }> {
  return withRepoLock(abs, async () => {
    if (await gitBusy(abs)) return { moved: false, note: null };
    const cur = await git(abs, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!cur.ok || !PROTECTED_BRANCHES.has(cur.out)) return { moved: false, note: null };
    const remote = (await git(abs, ['config', `branch.${cur.out}.remote`])).out;
    const merge = (await git(abs, ['config', `branch.${cur.out}.merge`])).out;
    if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) return { moved: false, note: null };
    const env: Record<string, string> = process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }; // 암호를 묻지 않는다
    const f = await git(abs, ['fetch', '--quiet', '--no-tags', remote, merge], env, timeoutMs);
    if (!f.ok) return { moved: false, note: `받아 오지 못함(${f.err.split('\n')[0].slice(0, 120)})` };
    const before = (await git(abs, ['rev-parse', 'HEAD'])).out;
    const m = await git(abs, ['merge', '--ff-only', '--quiet', '--no-overwrite-ignore', '--no-autostash', 'FETCH_HEAD']); // git이 무시하는 로컬 파일도 덮어쓰지 않는다
    if (!m.ok) return { moved: false, note: `최신화하지 않음(사용자 변경과 겹치거나 fast-forward 불가)` };
    const after = (await git(abs, ['rev-parse', 'HEAD'])).out;
    return { moved: before !== after, note: before !== after ? `${before.slice(0, 8)} → ${after.slice(0, 8)}` : null };
  }).catch((e) => ({ moved: false, note: (e as Error).message }));
}

/** 연결 폴더 기준 경로 중 git이 무시하는 경로(빌드·시험 산출물 등). 저장소 밖 경로는 무시 대상으로 보지 않는다. */
export async function ignoredPaths(folder: string, paths: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!paths.length) return out;
  const w = await workspaceRepos(folder);
  const groups = new Map<RepoInfo, { inner: string; orig: string }[]>();
  for (const p of paths) {
    const hit = repoOf(w, p);
    if (!hit || !hit.inner) continue;
    const g = groups.get(hit.repo) ?? [];
    g.push({ inner: hit.inner, orig: p });
    groups.set(hit.repo, g);
  }
  for (const [repo, g] of groups) {
    for (let i = 0; i < g.length; i += 200) {
      const part = g.slice(i, i + 200);
      // check-ignore는 literal 경로 지정을 받지 않는다: 이 호출만 끄고, ':'로 시작하는 경로(경로 지정 문법)는 넘기지 않는다
      const names = part.map((x) => x.inner).filter((x) => !x.startsWith(':'));
      if (!names.length) continue;
      const r = await git(repo.abs, ['-c', 'core.quotePath=false', 'check-ignore', '--', ...names], { GIT_LITERAL_PATHSPECS: '0' });
      const hits = new Set(r.raw.split('\n').filter(Boolean));
      for (const x of part) if (hits.has(x.inner)) out.add(x.orig);
    }
  }
  return out;
}

// ───── 사용자 승인 커밋 ─────
// 오퍼레이터가 요청한 '이미 저장소에 있는 미커밋 변경'을 사용자가 파일·메시지를 보고 승인하면 그 파일만 커밋한다(push 없음).
// - 보여 준 내용(HEAD·브랜치·파일별 모드와 내용 해시)이 승인 순간과 다르면 커밋하지 않는다.
// - 커밋은 임시 인덱스에 '보여 준 그 내용(blob)'만 넣어 만들고(write-tree·commit-tree), 브랜치는 HEAD가 그대로일 때만 옮긴다.
//   작업 트리를 다시 읽어 커밋하지 않으므로 그 사이 바뀐 내용·다른 파일이 섞이지 않고, git hook도 실행하지 않는다.
// - 심볼릭 링크·폴더·검사할 수 없는 파일(큰 파일·이진 파일)·비밀값으로 보이는 것·.gitignore 대상은 막는다.
export interface ApprovedFile { path: string; status: string; added: number | null; removed: number | null; flags: string[] }
export interface ApprovedPreview { repo: string; branch: string | null; target: string | null; files: ApprovedFile[]; blocked: string[]; hash: string; error: string | null }
export const APPROVED_FLAG_LABEL: Record<string, string> = {
  invalid: '경로 형식 오류', outside: '저장소 밖', missing: '파일 없음', unchanged: '바뀐 내용 없음', ignored: '.gitignore 대상', symlink: '링크 파일', directory: '폴더',
  unscanned: '내용을 검사할 수 없음(큰 파일·이진 파일)', filtered: 'git 필터(LFS 등) 대상 — 앱이 커밋하지 않음', 'secret-name': '비밀값 파일로 보임', 'secret-content': '비밀값으로 보이는 내용',
};
const SECRET_NAME = /(^|\/)(\.env(\.[^/]*)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|[^/]*\.pem|[^/]*\.key|[^/]*\.p12|[^/]*\.pfx|[^/]*\.keystore|[^/]*\.jks|credentials(\.json)?|[^/]*secret[^/]*\.(json|ya?ml|properties|txt))$/i;
const SECRET_OK = /\.(example|sample|template|dist)$/i;
const SECRET_TEXT = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /sk-[A-Za-z0-9_-]{20,}/, /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?[^\s"'$<{}]{8,}/i];
const SCAN_MAX = 2 * 1024 * 1024;
// hook·fsmonitor를 실행하지 않는다(승인 흐름의 모든 git 호출에 붙임)
const NO_HOOKS = ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'core.fsmonitor=false'];
const ag = (cwd: string, args: string[], env: Record<string, string> = {}) => git(cwd, [...NO_HOOKS, ...args], env);
/** diff 출력에서 추가된 줄만(머리글 '+++'와 내용 '++…'를 구분: 첫 '@@' 뒤의 줄만 본다) */
function addedLines(diff: string): string {
  const out: string[] = []; let inHunk = false;
  for (const l of diff.split('\n')) { if (l.startsWith('@@')) { inHunk = true; continue; } if (l.startsWith('diff --git ')) { inHunk = false; continue; } if (inHunk && l.startsWith('+')) out.push(l.slice(1)); }
  return out.join('\n');
}
// 실제 경로 비교: Windows는 8.3 짧은 이름·대소문자 차이가 있어 native 경로를 소문자로 비교한다
const rp = (p: string) => (process.platform === 'win32' ? realpathSync.native(p).toLowerCase() : realpathSync(p));
export function looksSecretName(p: string): boolean { return SECRET_NAME.test(p) && !SECRET_OK.test(p); }
export function looksSecretText(t: string): boolean { return SECRET_TEXT.some((re) => re.test(t)); }

/** 연결 폴더 기준 저장소 경로를 실제 저장소 최상위로 확인한다(폴더 밖·하위 폴더·링크로 빠져나가기 거부). */
async function approvedRepo(folder: string, repo: string): Promise<{ abs: string; real: string } | string> {
  const r0 = (repo || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, ''); const r = r0 === '.' ? '' : r0;
  if (isAbsolute(r) || r.split('/').includes('..')) return `저장소 경로가 올바르지 않습니다: ${repo}`;
  const abs = r ? join(folder, r) : folder;
  let real: string; let base: string;
  try { real = rp(abs); base = rp(folder); } catch { return `저장소를 찾을 수 없습니다: ${repo || '(연결 폴더)'}`; }
  if (real !== base && !real.startsWith(base + sep)) return '저장소가 연결 폴더 밖에 있습니다.';
  const root = await gitRoot(abs);
  let rootReal = '';
  try { rootReal = root ? rp(root) : ''; } catch { /* 없음 */ }
  if (rootReal !== real) return `git 저장소의 최상위 폴더가 아닙니다: ${repo || '(연결 폴더)'}`;
  return { abs, real };
}

function cleanApprovedPath(p: string): string | null {
  const x = String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!x || isAbsolute(x) || /^[A-Za-z]:/.test(x) || x.startsWith(':') || x.split('/').some((s) => s === '..' || s === '' || s === '.git') || /[\u0000-\u001f\u007f"]/.test(x)) return null; // 제어 문자·따옴표: git이 이름을 바꿔 출력해 대조가 어긋날 수 있다
  return x;
}

/** 경로마다 지금 커밋될 내용: 'delete'(지울 것) 또는 모드·내용 해시. 막힘이면 flags에 이유. */
interface Entry { path: string; status: string; flags: string[]; added: number | null; removed: number | null; mode: string | null; oid: string | null; del: boolean }

async function approvedEntries(rr: { abs: string; real: string }, files: string[]): Promise<{ entries: Entry[]; head: string | null }> {
  const headR = await ag(rr.abs, ['rev-parse', '--verify', '-q', 'HEAD']);
  const head = headR.ok ? headR.out : null;
  const fileMode = (await ag(rr.abs, ['config', '--bool', 'core.fileMode'])).out !== 'false';
  const list = [...new Set(files.map(String))].slice(0, 200);
  const valid = list.map((f) => ({ raw: f, path: cleanApprovedPath(f) }));
  const all = valid.map((v) => v.path).filter((x): x is string => !!x);
  // git 필터(clean·process, 예: LFS)는 상태 확인·비교·해시 때 저장소에 설정된 명령을 실행한다: 속성만 읽어(실행 없음) 그런 경로는 아예 다루지 않는다
  const filtered = new Set<string>(); let attrFailed = false;
  if (all.length) {
    const r = await ag(rr.abs, ['-c', 'core.quotePath=false', 'check-attr', 'filter', '--', ...all]);
    if (!r.ok) attrFailed = true;
    for (const l of r.raw.split('\n').filter(Boolean)) { const m = /^(.*): filter: (.*)$/.exec(l); if (m && m[2] !== 'unspecified' && m[2] !== 'unset') filtered.add(m[1]); }
  }
  const paths = attrFailed ? [] : all.filter((p) => !filtered.has(p));
  const st = new Map<string, string>();
  if (paths.length) {
    const r = await ag(rr.abs, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths]);
    const parts = r.raw.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) { const code = parts[i].slice(0, 2); const p = parts[i].slice(3); if (code.includes('R') || code.includes('C')) i++; st.set(p, code); }
  }
  // .gitignore 대상: 이미 스테이징했어도(강제 추가) 막는다
  const ignored = new Set<string>();
  const names = paths.filter((p) => !p.startsWith(':'));
  let ignoreFailed = false;
  if (names.length) {
    const r = await ag(rr.abs, ['-c', 'core.quotePath=false', 'check-ignore', '--no-index', '--', ...names], { GIT_LITERAL_PATHSPECS: '0' });
    if (r.code !== 0 && r.code !== 1) ignoreFailed = true; // 종료 1은 '무시 대상 없음'
    for (const l of r.raw.split('\n').filter(Boolean)) ignored.add(l); // 제어 문자가 든 경로는 처음부터 받지 않으므로 줄 단위로 안전하다
  }
  const entries: Entry[] = [];
  for (const v of valid) {
    const f = v.path;
    if (!f) { entries.push({ path: v.raw, status: '', flags: ['invalid'], added: null, removed: null, mode: null, oid: null, del: false }); continue; }
    const flags: string[] = [];
    if (attrFailed || filtered.has(f)) { entries.push({ path: f, status: '', flags: [attrFailed ? 'unscanned' : 'filtered'], added: null, removed: null, mode: null, oid: null, del: false }); continue; }
    const abs = join(rr.abs, f);
    // 중간 폴더가 링크면 저장소 밖으로 나갈 수 있다: 부모 폴더의 실제 경로가 저장소 안인지 본다
    try { const parent = rp(join(abs, '..')); if (parent !== rr.real && !parent.startsWith(rr.real + sep)) flags.push('outside'); } catch { /* 부모 없음: 아래 lstat에서 없음 처리 */ }
    let ls: ReturnType<typeof lstatSync> | null = null;
    try { ls = lstatSync(abs); } catch { ls = null; }
    if (ls?.isSymbolicLink()) flags.push('symlink');
    else if (ls?.isDirectory()) flags.push('directory');
    const code = st.get(f) ?? '';
    const tracked = head ? (await ag(rr.abs, ['ls-tree', '-z', head, '--', f])).raw.split('\0').filter(Boolean)[0] ?? '' : '';
    const headMode = tracked ? tracked.split(' ')[0] : null;
    if (!code) flags.push(ignored.has(f) ? 'ignored' : ls ? 'unchanged' : 'missing');
    else if (ignored.has(f)) flags.push('ignored');
    if (looksSecretName(f)) flags.push('secret-name');
    if (ignoreFailed) flags.push('unscanned');
    let added: number | null = null; let removed: number | null = null; let mode: string | null = null; let oid: string | null = null;
    const del = !ls && !!tracked;
    if (code && ls?.isFile() && !flags.includes('outside')) {
      mode = fileMode ? ((ls.mode & 0o111) ? '100755' : '100644') : (headMode === '100755' ? '100755' : '100644');
      oid = (await ag(rr.abs, ['hash-object', `--path=${f}`, '--', f])).out || null;
      if (!oid) flags.push('unscanned');
      let text = '';
      if (!tracked) {
        let buf: Buffer | null = null;
        try { if (ls.size <= SCAN_MAX) buf = readFileSync(abs); } catch { buf = null; }
        if (!buf || buf.includes(0)) flags.push('unscanned');
        else { text = buf.toString('utf8'); added = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0; removed = 0; }
      } else {
        const ns = await ag(rr.abs, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD', '--', f]);
        if (!ns.ok) flags.push('unscanned');
        const m = ns.out.split('\n')[0]?.split('\t');
        if (m && m.length >= 2 && m[0] !== '-') { added = Number(m[0]); removed = Number(m[1]); } else if (m && m[0] === '-') flags.push('unscanned');
        if (ls.size > SCAN_MAX) flags.push('unscanned');
        else { const d = await ag(rr.abs, ['diff', '--no-ext-diff', '--no-textconv', '-U0', 'HEAD', '--', f]); if (!d.ok) flags.push('unscanned'); text = addedLines(d.raw); }
      }
      if (text && looksSecretText(text)) flags.push('secret-content');
    } else if (code && !ls && !tracked) flags.push('missing'); // 스테이징만 되어 있고 파일은 없음(HEAD에도 없음)
    entries.push({ path: f, status: code, flags: [...new Set(flags)], added, removed, mode, oid, del });
  }
  return { entries, head };
}

/** 승인 화면에 보여 줄 내용: 파일별 상태·변경 줄 수·막힘 표시, 받을 브랜치, 확인용 해시 */
export async function previewApprovedCommit(folder: string, repo: string, files: string[], message: string, workBranch?: string): Promise<ApprovedPreview> {
  return (await approvedState(folder, repo, files, message, workBranch)).preview;
}
/** 미리 보기와 그 근거(커밋할 정확한 내용). 승인 때는 해시를 확인한 바로 이 내용만 커밋한다. */
async function approvedState(folder: string, repo: string, files: string[], message: string, workBranch?: string): Promise<{ preview: ApprovedPreview; entries: Entry[]; head: string | null }> {
  const empty = (error: string) => ({ preview: { repo, branch: null, target: null, files: [], blocked: [], hash: '', error } as ApprovedPreview, entries: [] as Entry[], head: null });
  const rr = await approvedRepo(folder, repo);
  if (typeof rr === 'string') return empty(rr);
  if (!message.trim()) return empty('커밋 메시지가 비어 있습니다.');
  const busy = await gitBusy(rr.abs);
  if (busy) return empty(busy);
  const { entries, head } = await approvedEntries(rr, files);
  if (!entries.length) return empty('커밋할 파일 목록이 비어 있습니다.');
  const cur = await ag(rr.abs, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = cur.ok ? cur.out : null;
  const target = branch && PROTECTED_BRANCHES.has(branch) && workBranch && head ? workBranch : branch;
  const blocked = entries.flatMap((e) => e.flags.map((fl) => `${e.path}: ${APPROVED_FLAG_LABEL[fl] ?? fl}`));
  const hash = createHash('sha256').update(JSON.stringify([rr.real, message.trim(), head, branch, target, entries.map((e) => [e.path, e.status, e.mode, e.oid, e.del, e.flags])])).digest('hex');
  return { preview: { repo, branch, target, files: entries.map((e) => ({ path: e.path, status: e.status, added: e.added, removed: e.removed, flags: e.flags })), blocked, hash, error: branch ? null : '분리된 HEAD(브랜치 없음) 상태라 커밋하지 않습니다.' }, entries, head };
}

/** 사용자가 승인한 커밋: 보여 준 내용과 같을 때만, 그 파일의 그 내용만 커밋한다. 작성자는 사용자 git 설정(없으면 CREWGENAI). push하지 않는다. */
export async function commitApproved(folder: string, repo: string, files: string[], message: string, shownHash: string, trailers: Record<string, string>, workBranch?: string): Promise<{ sha: string; branch: string | null; note: string | null }> {
  const rr = await approvedRepo(folder, repo);
  if (typeof rr === 'string') throw new Error(rr);
  return withRepoLock(rr.abs, async () => {
    const st = await approvedState(folder, repo, files, message, workBranch);
    const p = st.preview;
    if (p.error) throw new Error(p.error);
    if (p.blocked.length) throw new Error(`커밋할 수 없는 파일이 있습니다: ${p.blocked.slice(0, 5).join(', ')}`);
    if (!shownHash || p.hash !== shownHash) throw new Error('승인 화면을 연 뒤 파일 내용이나 브랜치가 바뀌었습니다. 다시 확인한 뒤 승인하세요.');
    const { entries, head } = st; // 해시를 확인한 바로 그 내용(다시 읽지 않음)
    // dev·main이면 작업 브랜치로 옮긴다(작업 트리 변경은 그대로 따라감, hook 없이)
    let note: string | null = null; let branch = p.branch!;
    if (p.target && p.target !== p.branch && workBranch) {
      const b = await ensureWorkBranch(rr.abs, workBranch, NO_HOOKS);
      if (b.error) throw new Error(b.error);
      note = b.note; branch = b.target ?? workBranch;
    }
    const head2 = (await ag(rr.abs, ['rev-parse', '--verify', '-q', 'HEAD'])).out || null;
    if (head2 !== head) throw new Error('커밋 직전에 저장소 HEAD가 바뀌어 커밋하지 않았습니다.');
    const tmp = mkdtempSync(join(tmpdir(), 'crewgenai-approve-'));
    const env = { GIT_INDEX_FILE: join(tmp, 'index') };
    try {
      const rt = head ? await ag(rr.abs, ['read-tree', head], env) : await ag(rr.abs, ['read-tree', '--empty'], env);
      if (!rt.ok) throw new Error(`임시 인덱스를 만들지 못했습니다: ${rt.err.slice(0, 200)}`);
      for (const e of entries) {
        if (e.del) { const r = await ag(rr.abs, ['update-index', '--force-remove', '--', e.path], env); if (!r.ok) throw new Error(`삭제 반영 실패: ${e.path}`); continue; }
        // 보여 준 내용 그대로인지 다시 확인하며 저장(-w): 다르면 커밋하지 않는다
        const w = await ag(rr.abs, ['hash-object', '-w', `--path=${e.path}`, '--', e.path]);
        if (!w.ok || w.out !== e.oid) throw new Error(`승인한 뒤 파일 내용이 바뀌어 커밋하지 않았습니다: ${e.path}`);
        const u = await ag(rr.abs, ['update-index', '--add', '--cacheinfo', `${e.mode},${e.oid},${e.path}`], env);
        if (!u.ok) throw new Error(`임시 인덱스 반영 실패: ${e.path}: ${u.err.slice(0, 200)}`);
      }
      const tree = (await ag(rr.abs, ['write-tree'], env)).out;
      if (!tree) throw new Error('커밋할 트리를 만들지 못했습니다.');
      // 결과 확인: HEAD와 다른 경로가 정확히 승인한 경로뿐인지
      const changed = head ? (await ag(rr.abs, ['-c', 'core.quotePath=false', 'diff-tree', '-r', '--name-only', '-z', head, tree])).raw.split('\0').filter(Boolean) : entries.map((e) => e.path);
      const approved = new Set(entries.map((e) => e.path));
      if (!changed.length) throw new Error('커밋할 변경이 없습니다(이미 같은 내용).');
      if (changed.some((c) => !approved.has(c))) throw new Error('승인하지 않은 경로가 섞여 커밋하지 않았습니다.');
      const e2 = await ag(rr.abs, ['config', 'user.email']); const n2 = await ag(rr.abs, ['config', 'user.name']);
      const who = e2.ok && e2.out && n2.ok && n2.out ? { GIT_AUTHOR_NAME: n2.out, GIT_AUTHOR_EMAIL: e2.out, GIT_COMMITTER_NAME: n2.out, GIT_COMMITTER_EMAIL: e2.out }
        : { GIT_AUTHOR_NAME: 'CREWGENAI 사용자 승인', GIT_AUTHOR_EMAIL: 'approved@crewgenai.local', GIT_COMMITTER_NAME: 'CREWGENAI', GIT_COMMITTER_EMAIL: 'crewgenai@localhost' };
      const msg = `${message.trim()}\n\n${Object.entries(trailers).filter(([, v]) => v).map(([k, v]) => `${k}: ${v.replace(/\n/g, ' ')}`).join('\n')}\n`;
      const c = await ag(rr.abs, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', msg], who);
      if (!c.ok || !c.out) throw new Error(`커밋 생성 실패: ${(c.err || c.out).slice(0, 300)}`);
      const sym = await ag(rr.abs, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (!sym.ok || sym.out !== branch) throw new Error('커밋 직전에 작업 브랜치가 바뀌어 커밋하지 않았습니다.');
      // HEAD가 그대로일 때만 브랜치를 옮긴다(그 사이 다른 커밋이 생겼으면 실패)
      const ur = await ag(rr.abs, ['update-ref', '-m', 'crewgenai: 사용자 승인 커밋', `refs/heads/${branch}`, c.out, head ?? '0'.repeat(40)]);
      if (!ur.ok) throw new Error(`브랜치를 옮기지 못했습니다(그 사이 다른 커밋이 생김): ${ur.err.slice(0, 200)}`);
      // 실제 인덱스의 그 경로들을 새 HEAD에 맞춘다(작업 트리는 건드리지 않음). 그 사이 브랜치가 바뀌었으면 건드리지 않는다
      const sym2 = await ag(rr.abs, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (sym2.ok && sym2.out === branch) await ag(rr.abs, ['reset', '-q', '--', ...entries.map((e) => e.path)]);
      return { sha: c.out, branch, note };
    } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 무시 */ } }
  });
}

/** 승인 커밋 요청 표식(Crewgenai-Request 트레일러)이 붙은 커밋을 찾는다: 앱이 커밋 도중 꺼졌을 때 실제로 커밋됐는지 확인용 */
export async function findRequestCommit(repoAbs: string, requestId: string): Promise<{ sha: string; branch: string | null } | null> {
  const r = await git(repoAbs, ['log', '--all', '-n', '200', '--format=%H%x1f%(trailers:key=Crewgenai-Request,valueonly)%x1e']);
  if (r.code !== 0) return null;
  for (const rec of r.raw.split('\x1e')) {
    const [sha, val] = rec.trim().split('\x1f');
    if (sha && val && val.trim() === requestId) {
      const b = await git(repoAbs, ['branch', '--contains', sha, '--format=%(refname:short)']);
      return { sha: sha.trim(), branch: b.code === 0 ? b.raw.split('\n').map((x: string) => x.trim()).filter(Boolean)[0] ?? null : null };
    }
  }
  return null;
}

/**
 * 승인 커밋 요청의 코드 차이(텔레그램 '변경 상세'용): 승인 화면과 같은 검사(previewApprovedCommit)를 통과한 파일만 보낸다.
 * 비밀값 이름·내용, git 필터(LFS 등)·링크·저장소 밖·검사 못 한 파일은 빼고, hook·fsmonitor·외부 diff·textconv를 쓰지 않는다(저장소 설정이 명령을 실행하지 못하게).
 */
export async function approvedDiff(folder: string, repo: string, files: string[], workBranch?: string, maxChars = 6000): Promise<string> {
  const pv = await previewApprovedCommit(folder, repo, files, '', workBranch);
  const ok = pv.files.filter((f) => !f.flags.length).map((f) => f.path);
  const skipped = pv.files.length - ok.length;
  if (!ok.length) return `(보낼 수 있는 파일이 없습니다${skipped ? ` — ${skipped}개는 비밀값·필터·링크 등이라 보내지 않음` : ''})`;
  const rr = await approvedRepo(folder, repo);
  if (typeof rr === 'string') throw new Error(rr);
  const head = (await ag(rr.abs, ['rev-parse', '--verify', '-q', 'HEAD'])).out;
  let out = '';
  for (const f of ok) {
    const tracked = head ? (await ag(rr.abs, ['ls-tree', '-z', head, '--', f])).raw.split('\0').filter(Boolean).length > 0 : false;
    if (tracked) { const d = await ag(rr.abs, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', f]); out += d.ok ? d.raw : `(${f}: 차이를 읽지 못함)\n`; }
    else { try { out += `+++ 새 파일 ${f}\n${readFileSync(join(rr.abs, f), 'utf8').split('\n').slice(0, 80).map((l) => `+${l}`).join('\n')}\n`; } catch { out += `(${f}: 읽지 못함)\n`; } }
    if (out.length > maxChars) break;
  }
  // 비밀값으로 보이는 줄(키·토큰·비밀번호가 든 접속 주소 포함)은 한 번 더 뺀다
  const CRED_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i;
  const lines = out.split('\n'); const kept = lines.filter((l) => !SECRET_TEXT.some((re) => re.test(l)) && !CRED_URL.test(l));
  out = kept.join('\n') + (kept.length < lines.length ? '\n(비밀값으로 보이는 줄은 뺐습니다)' : '');
  return `${skipped ? `(비밀값·필터·링크 등 ${skipped}개 파일은 보내지 않음)\n` : ''}${out.length > maxChars ? `${out.slice(0, maxChars)}\n…(이하 생략)` : out}`;
}

// ───── 매일 dev 반영(자동 커밋·push) ─────
/** 비밀값 파일을 커밋하지 않도록 .gitignore에 더하는 규칙(없는 줄만 더한다). 견본(.env.example 등)은 다시 포함한다 */
export const SECRET_IGNORE = ['.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template', '*.pem', '*.p12', '*.pfx', '*.keystore', '*.jks', 'id_rsa*', 'id_ed25519*', 'credentials.json', '*secret*.json', '*secret*.yml', '*secret*.yaml', '*secret*.properties'];
const IGNORE_HEAD = '# CREWGENAI: 비밀값(API 키·DB·접속 정보) 파일은 커밋하지 않는다(자동 추가)';
const BIG_FILE = 20 * 1024 * 1024;

export interface DevSyncResult { repo: string; status: 'pushed' | 'nothing' | 'skipped' | 'failed'; note: string; committed: number; excluded: string[]; sha: string | null }

/** .gitignore에 비밀값 규칙이 없으면 더한다. 바꿨으면 true */
export function ensureSecretIgnore(abs: string): boolean {
  const p = join(abs, '.gitignore');
  let cur = ''; try { cur = readFileSync(p, 'utf8'); } catch { cur = ''; }
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = SECRET_IGNORE.filter((l) => !have.has(l));
  if (!add.length) return false;
  const block = `${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}${have.has(IGNORE_HEAD) ? '' : `${IGNORE_HEAD}\n`}${add.join('\n')}\n`;
  writeFileSync(p, cur + block);
  return true;
}

/** git status -z 결과의 경로들(이름 바꾸기는 새 이름) */
async function changedPaths(abs: string): Promise<string[]> {
  const r = await git(abs, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!r.ok) return [];
  const parts = r.raw.split('\0'); const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]; if (e.length < 4) continue;
    const xy = e.slice(0, 2); out.push(e.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') i++; // 다음 항목은 원래 이름
  }
  return [...new Set(out)];
}

/** 커밋해도 되는 파일인가: 비밀값 이름·내용, 너무 큰 파일은 뺀다(새 파일은 전체, 바뀐 파일은 추가된 줄만 본다) */
async function secretReason(abs: string, rel: string): Promise<string | null> {
  if (looksSecretName(rel)) return '비밀값 파일 이름';
  const f = join(abs, rel);
  let st; try { st = lstatSync(f); } catch { return null; } // 지운 파일
  if (st.isSymbolicLink() || !st.isFile()) return null;
  if (st.size > BIG_FILE) return '20MB 넘는 큰 파일';
  if (st.size > SCAN_MAX) return null;
  const tracked = (await git(abs, ['ls-files', '--error-unmatch', '--', rel])).ok;
  const text = tracked ? addedLines((await ag(abs, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', rel])).raw) : (() => { try { return readFileSync(f, 'utf8'); } catch { return ''; } })();
  return looksSecretText(text) ? '비밀값으로 보이는 내용(API 키·비밀번호·개인 키 등)' : null;
}

const PUSH_ENV = (): Record<string, string> => (process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }); // 암호를 묻지 않는다
const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 160) ?? '';

/**
 * 저장소 하나를 dev에 반영한다: 비밀값을 뺀 미커밋 변경을 지금 브랜치(dev 또는 앱 작업 브랜치)에 커밋하고, dev에 합쳐 원격 dev로 push한다.
 * 사용자 작업 트리는 바꾸지 않는다(dev와 갈라졌으면 임시 작업 폴더에서 병합). 사용자 브랜치(dev·앱 작업 브랜치가 아닌 것)는 건드리지 않는다.
 */
export function syncRepoToDev(abs: string, repo: string, day: string, opts: { push: boolean } = { push: true }): Promise<DevSyncResult> {
  let created = '';
  const res = (status: DevSyncResult['status'], note: string, extra: Partial<DevSyncResult> = {}): DevSyncResult => ({ repo, status, note: `${created}${note}`, committed: 0, excluded: [], sha: null, ...extra });
  return withRepoLock(abs, async () => {
    const busy = await gitBusy(abs); if (busy) return res('skipped', busy);
    let cur = (await git(abs, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).out;
    if (!cur) return res('skipped', '브랜치가 아닌 상태(detached)라 건너뜀');
    const remote = (await git(abs, ['remote'])).out.split('\n').includes('origin') ? 'origin' : '';
    if (remote) await git(abs, ['fetch', '--quiet', '--no-tags', remote, 'dev'], PUSH_ENV(), 60000);
    let hasLocalDev = (await git(abs, ['rev-parse', '--verify', '-q', 'refs/heads/dev'])).ok;
    const hasRemoteDev = !!remote && (await git(abs, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/dev`])).ok;
    if (!hasLocalDev && !hasRemoteDev) {
      // dev가 없으면 지금 브랜치에서 dev를 만들고 dev로 옮긴다(작업 트리의 변경은 그대로 따라온다)
      const sw = await ag(abs, ['switch', '-q', '-c', 'dev']);
      if (!sw.ok) return res('failed', `dev 브랜치를 만들지 못함: ${firstLine(sw.err)}`);
      created = `dev 브랜치를 새로 만듦(${cur}에서) · `; cur = 'dev'; hasLocalDev = true;
    }
    if (cur !== 'dev' && !cur.startsWith('feat/crewgenai-')) return res('skipped', `사용자 브랜치(${cur})에 있어 건드리지 않음`);
    // 1) 비밀값 제외 규칙 → 커밋할 파일 고르기
    const ignoreChanged = ensureSecretIgnore(abs);
    const excluded: string[] = []; const files: string[] = [];
    for (const p of await changedPaths(abs)) { const why = await secretReason(abs, p); if (why) excluded.push(`${p} — ${why}`); else files.push(p); }
    let committed = 0; let sha: string | null = null;
    if (files.length) {
      const add = await ag(abs, ['add', '-A', '--', ...files]);
      if (!add.ok) return res('failed', `스테이징 실패: ${firstLine(add.err)}`, { excluded });
      const c = await ag(abs, ['commit', '--no-verify', '-q', '-m', `CREWGENAI 일일 반영 ${day}`, '-m', `비밀값 제외 ${excluded.length}개${ignoreChanged ? ', .gitignore에 비밀값 제외 규칙 추가' : ''}`]);
      if (!c.ok && !/nothing to commit/.test(c.out + c.err)) return res('failed', `커밋 실패: ${firstLine(c.err || c.out)}`, { excluded });
      if (c.ok) { committed = files.length; sha = (await git(abs, ['rev-parse', 'HEAD'])).out; }
    }
    // 2) dev에 합치기
    const head = (await git(abs, ['rev-parse', 'HEAD'])).out;
    // 합칠 기준 dev: 원격 dev와 로컬 dev 중 앞선 쪽(로컬 dev에만 있는 커밋을 잃지 않게). 지금 브랜치가 dev면 로컬 dev는 HEAD에 이미 들어 있다.
    const rDev = hasRemoteDev ? (await git(abs, ['rev-parse', `refs/remotes/${remote}/dev`])).out : '';
    const lDev = hasLocalDev && cur !== 'dev' ? (await git(abs, ['rev-parse', 'refs/heads/dev'])).out : '';
    let devTip = rDev || lDev;
    if (rDev && lDev && rDev !== lDev) {
      if ((await git(abs, ['merge-base', '--is-ancestor', rDev, lDev])).ok) devTip = lDev;
      else if (!(await git(abs, ['merge-base', '--is-ancestor', lDev, rDev])).ok) return res('skipped', '로컬 dev와 원격 dev가 갈라져 있어 건너뜀(사람이 정리해야 함)', { excluded, committed, sha });
    }
    let target = head;
    if (devTip && devTip !== head && !(await git(abs, ['merge-base', '--is-ancestor', devTip, head])).ok) {
      if ((await git(abs, ['merge-base', '--is-ancestor', head, devTip])).ok) target = devTip; // 이미 dev에 들어 있음
      else {
        // dev가 갈라졌다: 사용자 작업 트리를 건드리지 않고 임시 작업 폴더에서 병합한다
        const tmp = mkdtempSync(join(tmpdir(), 'crewgenai-devsync-'));
        try {
          const wt = await ag(abs, ['worktree', 'add', '--detach', '--quiet', tmp, devTip]);
          if (!wt.ok) return res('failed', `임시 작업 폴더를 만들지 못함: ${firstLine(wt.err)}`, { excluded, committed, sha });
          const m = await ag(tmp, ['merge', '--no-edit', '--no-ff', '-q', '-m', `CREWGENAI 일일 반영 ${day}: ${cur} → dev`, head]);
          if (!m.ok) { await ag(tmp, ['merge', '--abort']); return res('failed', `dev와 충돌해 합치지 못함(커밋은 ${cur}에 남김): ${firstLine(m.err || m.out)}`, { excluded, committed, sha }); }
          target = (await git(tmp, ['rev-parse', 'HEAD'])).out;
        } finally { await git(abs, ['worktree', 'remove', '--force', tmp]); rmSync(tmp, { recursive: true, force: true }); await git(abs, ['worktree', 'prune']); }
      }
    }
    // 로컬 dev도 같은 위치로(다른 작업 폴더에서 dev를 쓰고 있지 않을 때만)
    if (cur !== 'dev') await git(abs, ['branch', '-f', 'dev', target]);
    else if (target !== head) { const ff = await ag(abs, ['merge', '--ff-only', '-q', target]); if (!ff.ok) return res('failed', `dev를 최신으로 맞추지 못함: ${firstLine(ff.err)}`, { excluded, committed, sha }); }
    // 3) push
    if (!remote || !opts.push) return res(committed ? 'pushed' : 'nothing', remote ? 'push 안 함(설정)' : '원격 저장소 없음 — 로컬 dev에만 반영', { excluded, committed, sha });
    if (hasRemoteDev && target === rDev) return res('nothing', committed ? '이미 dev에 반영됨' : '바뀐 것 없음', { excluded, committed, sha });
    const p = await git(abs, ['push', '--quiet', remote, `${target}:refs/heads/dev`], PUSH_ENV(), 120000);
    if (!p.ok) return res('failed', `push 실패: ${firstLine(p.err)}`, { excluded, committed, sha });
    return res('pushed', `${committed ? `파일 ${committed}개 커밋, ` : ''}dev ${(rDev || devTip || '(새로 만듦)').slice(0, 8)} → ${target.slice(0, 8)} push`, { excluded, committed, sha });
  }).catch((e) => res('failed', firstLine((e as Error).message)));
}

/**
 * 사용자가 승인한 main 병합: 원격 dev를 main에 합쳐 push한다(가능하면 fast-forward, 갈라졌으면 임시 작업 폴더에서 병합 커밋).
 * 사용자 작업 트리는 바꾸지 않는다. 충돌이면 합치지 않고 실패로 알린다.
 */
export function mergeDevToMain(abs: string, repo: string, day: string): Promise<DevSyncResult> {
  const res = (status: DevSyncResult['status'], note: string, sha: string | null = null): DevSyncResult => ({ repo, status, note, committed: 0, excluded: [], sha });
  return withRepoLock(abs, async () => {
    if (!(await git(abs, ['remote'])).out.split('\n').includes('origin')) return res('skipped', '원격 저장소(origin)가 없어 건너뜀');
    const f = await git(abs, ['fetch', '--quiet', '--no-tags', 'origin', 'dev', 'main'], PUSH_ENV(), 60000);
    if (!f.ok) return res('skipped', `dev·main을 받아 오지 못해 건너뜀: ${firstLine(f.err)}`);
    const dev = (await git(abs, ['rev-parse', 'refs/remotes/origin/dev'])).out; const main = (await git(abs, ['rev-parse', 'refs/remotes/origin/main'])).out;
    if (!dev || !main) return res('skipped', 'dev 또는 main 브랜치가 없어 건너뜀');
    if (dev === main || (await git(abs, ['merge-base', '--is-ancestor', dev, main])).ok) return res('nothing', 'main에 이미 들어 있음');
    let target = dev;
    if (!(await git(abs, ['merge-base', '--is-ancestor', main, dev])).ok) {
      const tmp = mkdtempSync(join(tmpdir(), 'crewgenai-main-'));
      try {
        const wt = await ag(abs, ['worktree', 'add', '--detach', '--quiet', tmp, main]);
        if (!wt.ok) return res('failed', `임시 작업 폴더를 만들지 못함: ${firstLine(wt.err)}`);
        const m = await ag(tmp, ['merge', '--no-edit', '--no-ff', '-q', '-m', `CREWGENAI main 병합 ${day}: dev → main`, dev]);
        if (!m.ok) { await ag(tmp, ['merge', '--abort']); return res('failed', `main과 충돌해 합치지 못함(사람이 정리해야 함): ${firstLine(m.err || m.out)}`); }
        target = (await git(tmp, ['rev-parse', 'HEAD'])).out;
      } finally { await git(abs, ['worktree', 'remove', '--force', tmp]); rmSync(tmp, { recursive: true, force: true }); await git(abs, ['worktree', 'prune']); }
    }
    const p = await git(abs, ['push', '--quiet', 'origin', `${target}:refs/heads/main`], PUSH_ENV(), 120000);
    if (!p.ok) return res('failed', `push 실패: ${firstLine(p.err)}`);
    // 로컬 main이 뒤처져 있고 지금 브랜치가 아니면 같이 옮긴다
    const cur = (await git(abs, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).out;
    const lMain = (await git(abs, ['rev-parse', '--verify', '-q', 'refs/heads/main'])).out;
    if (cur !== 'main' && lMain && (await git(abs, ['merge-base', '--is-ancestor', lMain, target])).ok) await git(abs, ['branch', '-f', 'main', target]);
    return res('pushed', `main ${main.slice(0, 8)} → ${target.slice(0, 8)} push`, target);
  }).catch((e) => res('failed', firstLine((e as Error).message)));
}

/** 지워도 git 기록으로 되살릴 수 있는가: 경로(파일·폴더)의 모든 파일이 커밋돼 있고 바뀐 것·추적하지 않는 파일이 없다 */
export async function trackedClean(abs: string): Promise<boolean> {
  let isDir = false; try { isDir = statSync(abs).isDirectory(); } catch { return false; }
  const dir = isDir ? abs : dirname(abs);
  const root = await gitRoot(dir); if (!root) return false;
  let real = abs; try { real = realpathSync(abs); } catch { return false; }
  const rel = relative(root, real).split(sep).join('/'); if (!rel || rel.startsWith('..')) return false;
  const ls = await git(root, ['ls-files', '--', rel]); if (!ls.ok || !ls.out) return false;
  // 추적하지 않는 파일·무시된 파일(.gitignore)이 하나라도 있으면 git으로 되살릴 수 없으니 지우지 않는다
  const st = await git(root, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', rel]);
  return st.ok && st.out === '';
}

/** git이 무시하고 추적하는 파일이 하나도 없는 폴더인가(지워도 저장소 기록과 상관없는 빌드 결과) */
export async function ignoredUntracked(abs: string): Promise<boolean> {
  const root = await gitRoot(dirname(abs)); if (!root) return false;
  let real = abs; try { real = realpathSync(abs); } catch { return false; }
  const rel = relative(root, real).split(sep).join('/'); if (!rel || rel.startsWith('..')) return false;
  const ls = await git(root, ['ls-files', '--', rel]); if (!ls.ok || ls.out) return false;
  return (await git(root, ['check-ignore', '-q', '--no-index', '--', rel], { GIT_LITERAL_PATHSPECS: '0' })).ok;
}
