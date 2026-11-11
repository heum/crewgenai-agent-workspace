// 공개 소스 보안 시험: 오퍼레이터가 계획한 검사 명령 제한, 검사 환경 변수, 비밀값 가림, 외부 추적 설정 차단
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkArgv, checkEnvFilter } from '../src/main/checks';
import { redact } from '../src/main/cli/claudeCli';

function project() {
  const d = mkdtempSync(join(tmpdir(), 'sec '));
  mkdirSync(join(d, 'docs')); writeFileSync(join(d, 'docs', 'a.md'), 'x');
  const outside = mkdtempSync(join(tmpdir(), 'outside ')); writeFileSync(join(outside, 'secret.txt'), 'top secret');
  try { symlinkSync(outside, join(d, 'link-out')); } catch { /* 링크를 만들 수 없는 환경 */ }
  return { d, outside };
}

describe('검사 명령 제한', () => {
  it('내장 test·grep은 정확한 이름만, 파일 인자는 프로젝트 안만 허용한다', () => {
    const { d, outside } = project();
    expect(checkArgv(['test', '-s', 'docs/a.md'], [], d)).toEqual(['/bin/test', '-s', 'docs/a.md']);
    expect(checkArgv(['./tools/test', '-s', 'docs/a.md'], [], d)).toBeNull(); // 프로젝트 안의 같은 이름 파일
    expect(checkArgv(['tools/grep', 'x', 'docs/a.md'], [], d)).toBeNull();
    expect(checkArgv(['grep', '.', '../../.ssh/id_ed25519', 'docs/a.md'], [], d)).toBeNull(); // 프로젝트 밖 읽기
    expect(checkArgv(['grep', '-q', 'x', '/etc/passwd'], [], d)).toBeNull();
    expect(checkArgv(['grep', 'x', join(outside, 'secret.txt')], [], d)).toBeNull();
    expect(checkArgv(['grep', 'x', 'link-out/secret.txt'], [], d)).toBeNull(); // 링크로 밖을 가리키는 경로
    expect(checkArgv(['grep', 'x'], [], d)).toBeNull(); // 파일 없이 표준 입력 읽기 금지
    // 값을 받는 옵션·이상한 옵션으로 패턴 자리를 바꿔 밖의 파일을 읽게 하는 형태
    expect(checkArgv(['grep', '-e.', '/etc/hosts', 'docs/a.md'], [], d)).toBeNull();
    expect(checkArgv(['grep', '-*', join(outside, 'secret.txt'), 'docs/a.md'], [], d)).toBeNull();
    expect(checkArgv(['grep', '-f', '/etc/hosts', 'docs/a.md'], [], d)).toBeNull();
    expect(checkArgv(['grep', '-q', '--', '-x', 'docs/a.md'], [], d)).not.toBeNull(); // -- 뒤의 - 패턴은 허용
    expect(checkArgv(['test', '-s', 'docs/a.md', '/etc/hosts'], [], d)).toBeNull();
    expect(checkArgv(['test', '-nt', 'docs/a.md'], [], d)).toBeNull();
  });

  it('허용 명령 뒤에는 옵션·대입 없는 평범한 인자만 붙일 수 있다', () => {
    const { d } = project();
    const allowed = ['npm test'];
    expect(checkArgv(['npm', 'test'], allowed, d)).toEqual(['npm', 'test']);
    expect(checkArgv(['npm', 'test', 'docs/a.md'], allowed, d)).toEqual(['npm', 'test', 'docs/a.md']);
    expect(checkArgv(['npm', 'test', '--script-shell=/tmp/evil'], allowed, d)).toBeNull();
    expect(checkArgv(['npm', 'test', '--', '--reporter=x'], allowed, d)).toBeNull();
    expect(checkArgv(['npm', 'test', '../outside'], allowed, d)).toBeNull();
    expect(checkArgv(['npm', 'testx'], allowed, d)).toBeNull();
    expect(checkArgv(['npm', 'run', 'build'], allowed, d)).toBeNull();
    expect(checkArgv(['sh', '-c', 'npm test'], ['sh'], d)).toBeNull();
    expect(checkArgv(['node', '-e', 'process.exit(0)'], ['node'], d)).toBeNull();
  });

  it('검사 실행 환경에서 키·토큰·비밀번호 변수를 뺀다', () => {
    const env = checkEnvFilter({ PATH: '/usr/bin', HOME: '/home/x', AWS_SECRET_ACCESS_KEY: 'a', GITHUB_TOKEN: 'b', NPM_TOKEN: 'c', OPENAI_API_KEY: 'd', MY_PASSWORD: 'e', LANG: 'ko_KR.UTF-8' });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH']);
  });
});

describe('비밀값 가림·외부 추적', () => {
  it('개인 키·AWS 키를 가린다', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----';
    expect(redact(`출력: ${pem} 끝`)).not.toContain('b3BlbnNzaC1rZXk');
    expect(redact('key AKIAABCDEFGHIJKLMNOP')).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('앱 밖에서 물려받은 LangSmith·LangChain 추적 설정은 앱이 시작될 때 지운다', async () => {
    process.env.LANGSMITH_TRACING = 'true'; process.env.LANGCHAIN_TRACING_V2 = 'true'; process.env.LANGSMITH_API_KEY = 'lsv2_pt_FAKE';
    await import('../src/main/service'); // 이 시험 파일에서 처음 불러온다(시작 시 정리 코드가 실행됨)
    expect(Object.keys(process.env).some((k) => /^(LANGSMITH_|LANGCHAIN_)/i.test(k))).toBe(false);
  });
});
