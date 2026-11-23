// Codex CLI 연결 — 리뷰 전용(읽기 전용 샌드박스, 구조화 출력).
// 실행: codex exec -m <모델> -c model_reasoning_effort="<강도>" -s read-only --skip-git-repo-check --ephemeral --output-schema <파일> -o <파일> -
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodexStatus } from '../../shared/types';
import { cleanEnv } from './claudeCli';

function run(file: string, args: string[], timeoutMs = 15000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, env: codexEnv(file), maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: `${stdout}\n${stderr}` });
    });
  });
}

/** Codex는 `#!/usr/bin/env node` 스크립트일 수 있어 같은 폴더의 node를 PATH에 넣는다. */
export function codexEnv(codexPath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = cleanEnv(extra);
  env.PATH = [dirname(codexPath), env.PATH].filter(Boolean).join(':');
  return env;
}

export async function findCodex(setting: string | null): Promise<string | null> {
  const cands = [setting];
  const sh = await run('/bin/zsh', ['-lc', 'command -v codex'], 8000);
  if (sh.code === 0) cands.push(sh.out.trim().split('\n')[0]);
  cands.push(join(homedir(), '.local/node/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(homedir(), '.npm-global/bin/codex'));
  return cands.find((c) => !!c && existsSync(c)) ?? null;
}

export async function checkCodex(setting: string | null): Promise<CodexStatus> {
  const path = await findCodex(setting);
  if (!path) return { path: null, version: null, loggedIn: null, ready: false, problem: 'Codex CLI를 찾지 못했습니다.', fix: 'Codex CLI를 설치하거나 설정에서 경로를 지정하세요. Codex 리뷰 단계는 Codex 없이 실행할 수 없습니다.' };
  const v = await run(path, ['--version']);
  const version = v.out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  const st = await run(path, ['login', 'status']);
  const loggedIn = st.code === 0 && /logged in/i.test(st.out);
  return loggedIn
    ? { path, version, loggedIn, ready: true, problem: null, fix: null }
    : { path, version, loggedIn, ready: false, problem: 'Codex CLI는 있지만 로그인되지 않았습니다.', fix: '터미널에서 `codex login`을 실행해 로그인한 뒤 다시 확인하세요.' };
}

/** 작업별 검증(검증 방식 codex): 완료 조건마다 통과·실패를 내고, 작성자가 고칠 수 없는 원인이면 blocked로 알린다 */
export const CODEX_VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'criteria', 'findings', 'blocked', 'needs', 'needsUser'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
    summary: { type: 'string' },
    criteria: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['no', 'pass', 'evidence'],
      properties: { no: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' } } } },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'file', 'issue', 'fix'],
      properties: { severity: { type: 'string', enum: ['P0', 'P1', 'P2'] }, file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } } } },
    blocked: { type: 'boolean' },
    needs: { type: 'string' },
    needsUser: { type: 'boolean' },
  },
};
export const CODEX_REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'file', 'issue', 'fix'],
      properties: { severity: { type: 'string', enum: ['P0', 'P1', 'P2'] }, file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } } } },
  },
};

export function codexArgs(model: string, effort: string, schemaFile: string, outFile: string): string[] {
  return ['exec', '-m', model, '-c', `model_reasoning_effort="${effort.replace(/[^a-z]/gi, '')}"`, '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--output-schema', schemaFile, '-o', outFile, '-'];
}

// ───────── 작성 실행(직원별 실행 도구가 Codex인 작성자) ─────────
// 앱이 만든 격리 복사본(작업 폴더)에서만 쓴다: 쓰기는 작업 폴더와 임시 폴더만, 네트워크는 끈다, 셸에는 기본 환경 변수만 넘긴다.
// 범위 밖 변경 차단·충돌 검사·원본 반영·커밋은 Claude 작성자와 같은 앱 코드가 한다(Codex 쪽 판단에 맡기지 않음).
export function codexAuthorArgs(model: string, effort: string, cwd: string, outFile: string): string[] {
  return ['exec', '-m', model, '-c', `model_reasoning_effort="${effort.replace(/[^a-z]/gi, '') || 'high'}"`, '-c', 'sandbox_workspace_write.network_access=false', '-c', 'shell_environment_policy.inherit="core"',
    '-s', 'workspace-write', '-C', cwd, '--skip-git-repo-check', '--ephemeral', '--json', '-o', outFile, '-'];
}
/** Codex 작성자의 모델: 직원에 Codex 모델(gpt-…)이 적혀 있으면 그것, 아니면 앱 설정의 Codex 모델 */
export function codexAuthorModel(agentModel: string | undefined, fallback: string): string {
  const m = String(agentModel ?? '').trim();
  return /^gpt-[0-9A-Za-z.\-]+$/.test(m) ? m : fallback;
}
export interface CodexSink { thread: string | null; usage: Record<string, number> | null; last: string; failed: string }
/** codex exec --json 한 줄을 기록용 사건으로 바꾼다(모르는 형식은 그대로 짧게 남긴다) */
export function interpretCodexLine(line: string, sink: CodexSink): { kind: 'init' | 'text' | 'tool' | 'tool_result' | 'result' | 'system'; summary: string } | null {
  let d: Record<string, unknown>;
  try { d = JSON.parse(line); } catch { return line.trim() ? { kind: 'system', summary: line.slice(0, 300) } : null; }
  const it = (d.item ?? {}) as Record<string, unknown>;
  const s = (v: unknown, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  switch (d.type) {
    case 'thread.started': sink.thread = s(d.thread_id, 80) || null; return { kind: 'init', summary: 'Codex 작업 시작' };
    case 'turn.completed': {
      const u = d.usage as Record<string, unknown> | undefined;
      if (u && typeof u === 'object') sink.usage = Object.fromEntries(Object.entries(u).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
      return { kind: 'result', summary: `Codex 작업 끝 · 입력 ${sink.usage?.input_tokens ?? '?'} · 출력 ${sink.usage?.output_tokens ?? '?'} 토큰` };
    }
    case 'turn.failed': case 'error': sink.failed = s((d.error as Record<string, unknown> | undefined)?.message ?? d.message ?? line, 500); return { kind: 'system', summary: `Codex 오류: ${sink.failed}` };
    case 'item.started': return it.type === 'command_execution' ? { kind: 'tool', summary: `명령: ${s(it.command, 240)}` } : null;
    case 'item.completed':
      if (it.type === 'agent_message') { sink.last = String(it.text ?? ''); return { kind: 'text', summary: s(it.text) }; }
      if (it.type === 'command_execution') return { kind: 'tool_result', summary: `명령 끝(종료 코드 ${s(it.exit_code, 8)}): ${s(it.command, 160)}` };
      if (it.type === 'file_change') return { kind: 'tool', summary: `파일 변경: ${s(JSON.stringify(it.changes ?? it), 240)}` };
      return it.type ? { kind: 'system', summary: `${s(it.type, 40)}` } : null;
    default: return null;
  }
}
