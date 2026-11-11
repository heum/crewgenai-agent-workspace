// Windows판 전용 동작 시험: 경로 검사, .cmd 실행 파일 해석, 내장 검사(test·grep), 내장 검사 이름 제한
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchSpec } from '../src/main/cli/claudeCli';
import { BUILTIN_CHECK } from '../src/main/checks';
import { safeRel } from '../src/main/docset';
import { escapes } from '../src/main/engine/validate';

const CHECK = resolve(__dirname, '../resources/check-builtin.cjs');
function check(args: string[]): number {
  try { execFileSync(process.execPath, [CHECK, ...args], { stdio: 'pipe' }); return 0; } catch (e) { return (e as { status: number }).status; }
}

describe('Windows 경로 검사', () => {
  it('드라이브 경로·UNC 경로·역슬래시 상위 이동은 프로젝트 밖으로 본다', () => {
    expect(escapes('C:\\Windows\\System32')).toBe(true);
    expect(escapes('c:/temp')).toBe(true);
    expect(escapes('\\\\server\\share\\x')).toBe(true);
    expect(escapes('..\\..\\outside')).toBe(true);
    expect(escapes('docs\\sub')).toBe(false);
    expect(escapes('docs/sub')).toBe(false);
    expect(safeRel('C:/x.md')).toBeNull();
    expect(safeRel('docs\\a.md')).toBe('docs/a.md');
  });
});

describe('.cmd 실행 파일 해석', () => {
  it('npm 형식(SET "X=%~dp0\\…\\cli.js")과 예전 형식("%dp0%\\…") 모두 Node 스크립트로 바꿔 셸 없이 실행한다', () => {
    const d = mkdtempSync(join(tmpdir(), 'shim '));
    mkdirSync(join(d, 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    writeFileSync(join(d, 'node_modules', 'npm', 'bin', 'npm-prefix.js'), '');
    // 실제 npm.cmd처럼 보조 스크립트(npm-prefix.js)가 먼저 나와도 npm-cli.js를 고른다
    writeFileSync(join(d, 'npm.cmd'), ':: npm\r\n@ECHO OFF\r\nSET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n');
    const a = launchSpec(join(d, 'npm.cmd'), ['test']);
    expect(a.args).toEqual([join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'test']);
    mkdirSync(join(d, 'node_modules', 'tool'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'tool', 'cli.mjs'), '');
    writeFileSync(join(d, 'tool.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\tool\\cli.mjs" %*\r\n');
    expect(launchSpec(join(d, 'tool.cmd'), ['-x']).args).toEqual([join(d, 'node_modules', 'tool', 'cli.mjs'), '-x']);
    writeFileSync(join(d, 'bad.cmd'), '@echo off\r\necho hi\r\n');
    expect(() => launchSpec(join(d, 'bad.cmd'), [])).toThrow('해석하지 못했습니다');
  });
});

describe('내장 검사', () => {
  it('내장 검사는 정확한 이름(test·grep)만 해당하고, 프로젝트의 test.cmd·grep.bat는 해당하지 않는다', () => {
    expect(BUILTIN_CHECK.has('test')).toBe(true);
    expect(BUILTIN_CHECK.has('grep')).toBe(true);
    for (const x of ['test.cmd', 'grep.bat', 'test.exe', 'C:\\proj\\test.cmd', './test']) expect(BUILTIN_CHECK.has(x)).toBe(false);
  });

  it('test·grep은 macOS 명령과 같은 종료 코드를 낸다', () => {
    const d = mkdtempSync(join(tmpdir(), 'check '));
    const r = join(d, 'r.txt'); const e = join(d, 'e.txt');
    writeFileSync(r, 'pass\nfail\n'); writeFileSync(e, '');
    expect(check(['test', '-s', r])).toBe(0);
    expect(check(['test', '-s', e])).toBe(1);
    expect(check(['test', '-e', join(d, 'none')])).toBe(1);
    expect(check(['test', '-d', d])).toBe(0);
    expect(check(['grep', '-q', 'pass|fail', r])).toBe(1); // 기본 정규식에서 |는 글자 그대로
    expect(check(['grep', '-q', '-E', 'pass|fail', r])).toBe(0);
    expect(check(['grep', '-q', 'pa\\(s\\)\\+', r])).toBe(0);
    expect(check(['grep', '-q', '^$', e])).toBe(1); // 빈 파일에는 줄이 없다
    expect(check(['grep', '-q', '^$', r])).toBe(1); // 끝 줄바꿈 뒤에 빈 줄을 만들지 않는다
    expect(check(['grep', 'pass', r, join(d, 'none')])).toBe(2); // 읽지 못한 파일이 있으면 오류
    expect(check(['grep', '-q', 'pass', r, join(d, 'none')])).toBe(0); // -q이고 일치가 있으면 성공
    expect(check(['grep', '-q', 'zzz', r])).toBe(1);
    writeFileSync(join(d, 'l.txt'), 'a^b\nx$y\n*star\n');
    expect(check(['grep', '-q', 'a^b', join(d, 'l.txt')])).toBe(0); // 중간의 ^·$는 글자 그대로
    expect(check(['grep', '-q', 'x$y', join(d, 'l.txt')])).toBe(0);
    expect(check(['grep', '-q', '*star', join(d, 'l.txt')])).toBe(0); // 맨 앞의 *는 글자 그대로
    expect(check(['grep', '-q', '^\\(a\\)*b\\1$', r])).toBe(2);
    writeFileSync(join(d, 'br.txt'), '[aaa\n');
    expect(check(['grep', '-q', '[[]a\\+', join(d, 'br.txt')])).toBe(0); // 대괄호 안의 [는 글자
    expect(check(['grep', '-q', '[]a]', join(d, 'br.txt')])).toBe(0); // 맨 앞 ]는 글자
    expect(check(['grep', '-q', 'a[\\]b', join(d, 'br.txt')])).toBe(1); // 역참조는 뜻이 달라 지원하지 않음(통과로 처리하지 않음)
  });
});
