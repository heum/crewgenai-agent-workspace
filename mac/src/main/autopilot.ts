// 사람 손을 줄이는 자동 처리(설정 '자동 처리', 기본 켬)
// - 저장소별 시험 명령: 저장소에 실제로 있는 시험 스크립트만 Bash 허용 명령으로 더한다(그 밖의 명령은 그대로 거부).
// - 프로젝트 스킬: 연결 폴더(또는 그 아래 저장소)의 skills/·.claude/skills/에 있는 스킬을 쓴다.
// - 문서 저장소 최신화: 사이클 시작 때 문서 저장소만 fast-forward로 갱신한다(사용자 변경과 겹치면 git이 거부하고 그대로 둔다).
// - 작업 브랜치: dev·main 등 보호 브랜치에는 커밋하지 않고 작업 브랜치를 만든다(git.ts의 커밋에서 처리).
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const PROTECTED_BRANCHES = new Set(['dev', 'main', 'master', 'develop']);

/** 작업 브랜치 이름: 미션(없으면 실행) 단위 하나. */
export function workBranchName(key: string): string {
  const k = key.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();
  return `feat/crewgenai-${k || 'work'}`;
}

function isFile(p: string) { try { return lstatSync(p).isFile(); } catch { return false; } }
function isDir(p: string) { try { return lstatSync(p).isDirectory(); } catch { return false; } }
function real(p: string) { try { return realpathSync(p); } catch { return p; } }

/** 연결 폴더 자신이 저장소면 그것만, 아니면 바로 아래 저장소들(연결 폴더 기준 이름, 자신은 ''). */
export function repoDirs(folder: string): { rel: string; abs: string }[] {
  if (!folder || !isDir(folder)) return [];
  if (existsSync(join(folder, '.git'))) return [{ rel: '', abs: folder }];
  let names: string[] = [];
  try { names = readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { /* 읽지 못함 */ }
  return names.filter((n) => existsSync(join(folder, n, '.git'))).map((n) => ({ rel: n, abs: join(folder, n) }));
}

export interface RepoCommand {
  repo: string; // 연결 폴더 기준 저장소 이름('' = 연결 폴더 자신)
  prefix: string; // Bash 허용 명령 접두어(작업 폴더 기준)
  example: string; // 직원에게 알려 줄 실행 예
  writeDirs: string[]; // 명령이 써야 하는 격리 복사본 밖 폴더(지금은 없음: 캐시는 복제본을 쓴다)
  cloneDirs: string[]; // 격리 복사본에서 링크 대신 복제본이어야 하는 폴더(연결 폴더 기준)
  localSockets?: boolean; // 로컬 소켓이 있어야 도는 명령(Gradle 잠금·내장 서버 시험). 설정에서 허용했을 때만 연다
}

function packageHasCheck(dir: string): boolean {
  try { const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }; return typeof j.scripts?.check === 'string'; } catch { return false; }
}

/**
 * 저장소에 실제로 있는 시험 명령. 스크립트가 링크면 쓰지 않는다(저장소 밖 실행 파일을 허용하지 않게).
 * - scripts/gradle.sh → 의존성 캐시(.gradle)는 오프라인 시험에 필요하므로 쓰기 허용 폴더로 돌려준다.
 * - scripts/check.sh
 * - package.json의 check 스크립트 → scripts/npm.sh가 있으면 그것으로, 없으면 npm으로.
 */
export function repoTestCommands(folder: string): RepoCommand[] {
  const out: RepoCommand[] = [];
  for (const r of repoDirs(folder)) {
    const at = r.rel ? `./${r.rel}/` : './';
    if (isFile(join(r.abs, 'scripts', 'gradle.sh'))) {
      // 의존성 캐시(.gradle)는 실제 폴더에 쓰게 하지 않고 격리 복사본 안의 복제본을 쓴다(캐시 오염이 사용자 빌드로 번지지 않게)
      const cache = join(r.abs, '.gradle');
      out.push({ repo: r.rel, prefix: `${at}scripts/gradle.sh`, example: `${at}scripts/gradle.sh --no-daemon --offline test`, writeDirs: [], cloneDirs: isDir(cache) ? [r.rel ? `${r.rel}/.gradle` : '.gradle'] : [], localSockets: true });
    }
    if (isFile(join(r.abs, 'scripts', 'check.sh'))) out.push({ repo: r.rel, prefix: `${at}scripts/check.sh`, example: `${at}scripts/check.sh`, writeDirs: [], cloneDirs: [] });
    if (packageHasCheck(r.abs)) {
      const nm = isDir(join(r.abs, 'node_modules')) ? [r.rel ? `${r.rel}/node_modules` : 'node_modules'] : [];
      if (isFile(join(r.abs, 'scripts', 'npm.sh'))) out.push({ repo: r.rel, prefix: `${at}scripts/npm.sh run check`, example: `${at}scripts/npm.sh run check`, writeDirs: [], cloneDirs: nm });
      else if (!r.rel) out.push({ repo: '', prefix: 'npm run check', example: 'npm run check', writeDirs: [], cloneDirs: nm });
      else out.push({ repo: r.rel, prefix: `npm --prefix ./${r.rel} run check`, example: `npm --prefix ./${r.rel} run check`, writeDirs: [], cloneDirs: nm });
    }
  }
  return out;
}

/** 직원 프롬프트에 붙이는 안내(허용된 시험 명령). */
export function commandNote(cmds: RepoCommand[], sockets = true): string {
  if (!cmds.length) return '';
  const blocked = sockets ? [] : cmds.filter((c) => c.localSockets);
  return ['## 바로 쓸 수 있는 시험 명령(앱이 허용함, 네트워크 없음·내려받아 둔 의존성만)', ...cmds.slice(0, 20).map((c) => `- ${c.repo || '이 저장소'}: \`${c.example}\``),
    '- 이 명령은 따로 허용을 요청하지 않아도 된다. 파이프(|)·리디렉션·&&로 다른 명령과 묶으면 거부되므로 명령 하나만 그대로 실행한다.',
    ...(blocked.length ? [`- ${blocked.map((c) => c.repo || '이 저장소').join(', ')}의 Gradle 시험은 로컬 소켓이 꺼져 있어(설정 > 자동 처리) 실패한다. 실행하지 말고 '실행 못 함(로컬 소켓 꺼짐)'으로 기록한다.`] : []),
    '- 실패하면 출력 마지막 부분을 근거로 기록한다. 시험이 만든 build/·.next 등 git이 무시하는 파일은 반영 대상이 아니다.'].join('\n');
}

/** 연결 폴더(와 그 아래 저장소)의 스킬 폴더: skills/·.claude/skills/ 중 SKILL.md가 있는 하위 폴더를 가진 것. */
export function projectSkillDirs(folder: string): string[] {
  const out: string[] = [];
  const bases = repoDirs(folder).map((r) => r.abs);
  if (!bases.includes(folder) && folder && isDir(folder)) bases.unshift(folder);
  for (const b of bases) {
    const root = real(b);
    const inside = (p: string) => { const q = real(p); return q === root || q.startsWith(root + sep); };
    for (const d of [join(b, 'skills'), join(b, '.claude', 'skills')]) {
      if (!isDir(d) || !inside(d)) continue;
      let names: string[] = [];
      try { names = readdirSync(d, { withFileTypes: true }).filter((e) => (e.isDirectory() || e.isSymbolicLink()) && isFile(join(d, e.name, 'SKILL.md'))).map((e) => e.name); } catch { /* 읽지 못함 */ } // SKILL.md는 링크가 아닌 일반 파일만(폴더 모양 표시로 플러그인 해석을 유도하지 못하게)
      if (!names.length) continue;
      // 자동으로 찾은 스킬은 그 저장소 안에 있는 스킬 폴더 하나하나만 넘긴다: 링크로 저장소 밖(다른 저장소의 비공개 자료 등)을 가리키는 스킬,
      // 스킬 폴더 안에 둔 플러그인(그 안의 링크)은 받지 않는다
      out.push(...names.filter((n) => inside(join(d, n))).map((n) => join(d, n)));
    }
  }
  return out;
}

const BUILD_FILES = ['package.json', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml', 'gradlew', 'pyproject.toml', 'setup.py', 'requirements.txt', 'pubspec.yaml', 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json', 'Package.swift', 'CMakeLists.txt', 'Makefile'];

/** 문서 저장소: 빌드 파일이 하나도 없는 저장소(문서만 모아 둔 저장소). 최신화는 이 저장소들만 한다. */
export function isDocRepo(abs: string): boolean {
  if (BUILD_FILES.some((f) => existsSync(join(abs, f)))) return false;
  try { return !readdirSync(abs).some((n) => /\.(xcodeproj|xcworkspace|sln|csproj)$/.test(n)); } catch { return false; }
}

/**
 * 격리 복사본 안의 링크(의존성 폴더)를 원본의 복제본으로 바꾼다. macOS APFS 즉시 복제(cp -c)를 쓰고,
 * 실패하면 링크로 되돌린다. macOS가 아니면 그대로 둔다.
 * 복제 원본은 앱이 정한 경로(expected)만 쓴다: 링크가 그 경로를 가리키지 않거나(직원이 바꾼 링크),
 * 복제 위치의 상위 경로가 격리 폴더 밖으로 이어지면 복제하지 않는다.
 */
export async function materializeLink(isoRoot: string, rel: string, expected: string, timeoutMs = 120000): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const p = join(isoRoot, rel);
  try {
    if (!lstatSync(p).isSymbolicLink() || readlinkSync(p) !== expected) return false;
    const root = realpathSync(isoRoot); const parent = realpathSync(join(p, '..'));
    if (parent !== root && !parent.startsWith(root + sep)) return false;
    if (!isDir(expected)) return false;
  } catch { return false; }
  rmSync(p, { force: true });
  const ok = await new Promise<boolean>((res) => execFile('/bin/cp', ['-c', '-R', expected, p], { timeout: timeoutMs }, (e) => res(!e)));
  if (!ok) { rmSync(p, { recursive: true, force: true }); try { symlinkSync(expected, p); } catch { /* 무시 */ } }
  return ok;
}

/**
 * 최신화할 문서 저장소: 빌드 파일이 없는 저장소 중 프로젝트 경로(참고 문서·이전 결과물·수정 허용 경로, 연결 폴더 기준 또는 절대 경로)가
 * 그 저장소 안을 가리키거나 스킬을 가져오는 저장소. 저장소를 포함하는 상위 경로(연결 폴더 전체 등)는 근거로 보지 않는다.
 */
export function docReposFor(folder: string, paths: string[]): { rel: string; abs: string }[] {
  const root = resolve(folder);
  const pts = [...paths, ...projectSkillDirs(folder)].filter((x) => typeof x === 'string' && x.trim()).map((x) => resolve(root, x));
  return repoDirs(folder).filter((r) => { const a = resolve(r.abs); return isDocRepo(a) && pts.some((p) => p === a || p.startsWith(a + sep)); });
}

const KEEP_ENV = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']);
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|^AWS_|^AZURE_|^GOOGLE_APPLICATION|^GITHUB_|^GH_|^NPM_|^LANGSMITH|^LANGCHAIN|^OPENAI|^CODEX|^DATABASE_URL$|_DATABASE_|^PG(PASSWORD|USER|HOST|DATABASE|SERVICE)|SSH_AUTH_SOCK)/i;

/**
 * Bash를 쓰는 직원 실행 환경에서 비밀 성격의 변수를 뺀다(하위 프로그램·저장소 스크립트가 읽지 못하게).
 * Claude CLI 인증에 필요한 변수만 남긴다(구독 로그인이면 이 변수들도 없다).
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (KEEP_ENV.has(k) || !SECRET_ENV.test(k)) out[k] = v;
  return out;
}
