// Codex CLI 연결 — 리뷰 전용(읽기 전용 샌드박스, 구조화 출력).
// 실행: codex exec -m <모델> -c model_reasoning_effort="<강도>" -s read-only --skip-git-repo-check --ephemeral --output-schema <파일> -o <파일> -
// Windows판: where·npm 전역 설치(.cmd)에서 찾고, .cmd는 Node 스크립트로 해석해 셸 없이 실행한다.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { CodexStatus } from '../../shared/types';
import { cleanEnv, launchSpec } from './claudeCli';

function run(file0: string, args0: string[], timeoutMs = 15000): Promise<{ code: number; out: string }> {
  let spec: ReturnType<typeof launchSpec>;
  try { spec = launchSpec(file0, args0); } catch (e) { return Promise.resolve({ code: 1, out: (e as Error).message }); }
  return new Promise((resolve) => {
    execFile(spec.file, spec.args, { windowsHide: true, timeout: timeoutMs, env: codexEnv(file0, spec.env), maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: `${stdout}\n${stderr}` });
    });
  });
}

/** Codex는 `#!/usr/bin/env node` 스크립트일 수 있어 같은 폴더의 node를 PATH에 넣는다. */
export function codexEnv(codexPath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = cleanEnv(extra);
  env.PATH = [dirname(codexPath), env.PATH].filter(Boolean).join(delimiter);
  return env;
}

export async function findCodex(setting: string | null): Promise<string | null> {
  const cands: (string | null)[] = [setting];
  try {
    const w = execFileSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true, timeout: 8000, env: cleanEnv() });
    const found = w.split(/\r?\n/).map((x) => x.trim()).filter((x) => /\.(exe|cmd|bat)$/i.test(x)).sort((x, y) => Number(/\.exe$/i.test(y)) - Number(/\.exe$/i.test(x)));
    cands.push(...found);
  } catch { /* PATH에 없음 */ }
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  cands.push(join(appData, 'npm', 'codex.cmd'), join(homedir(), '.local', 'bin', 'codex.exe'));
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
