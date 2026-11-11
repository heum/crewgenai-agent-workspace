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
