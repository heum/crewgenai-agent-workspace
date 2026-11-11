#!/usr/bin/env node
// Windows판 내장 검사 명령 — Windows에는 test·grep이 없으므로 같은 뜻의 최소 기능을 Node로 제공한다.
// 사용: check-builtin.cjs test -s|-f|-e|-d 경로
//       check-builtin.cjs grep [-q] [-i] [-F] [-E] [-c] 패턴 파일...  (-E가 없으면 기본 정규식: | + ? ( ) { }는 글자 그대로)
// 종료 코드: 0 = 참/일치 있음, 1 = 거짓/일치 없음, 2 = 사용법 오류. 셸을 거치지 않는다.
// Windows: 파이프 출력이 비동기라 process.exit 전에 내용이 잘릴 수 있어 동기 쓰기로 바꾼다
for (const s of [process.stdout, process.stderr]) { try { if (s._handle && s._handle.setBlocking) s._handle.setBlocking(true); } catch { /* 무시 */ } }
const fs = require('node:fs');
const [cmd, ...rest] = process.argv.slice(2);
function test(args) {
  const neg = args[0] === '!';
  const a = neg ? args.slice(1) : args;
  if (a.length !== 2) { process.stderr.write('test: 지원하는 형식은 test -s|-f|-e|-d 경로\n'); return 2; }
  const [op, p] = a;
  let st = null;
  try { st = fs.statSync(p); } catch { st = null; }
  let ok;
  if (op === '-e') ok = !!st;
  else if (op === '-f') ok = !!st && st.isFile();
  else if (op === '-d') ok = !!st && st.isDirectory();
  else if (op === '-s') ok = !!st && st.isFile() && st.size > 0;
  else { process.stderr.write(`test: 지원하지 않는 옵션 ${op}\n`); return 2; }
  return (neg ? !ok : ok) ? 0 : 1;
}
/**
 * 기본 정규식(BRE)을 JavaScript 정규식으로 바꾼다(GNU grep과 같은 뜻).
 * - | + ? ( ) { }는 글자 그대로, \| \+ \? \( \) \{ \}는 특수 기호
 * - ^는 맨 앞(또는 \( 바로 뒤)에서만, $는 맨 끝(또는 \) 바로 앞)에서만 특수 기호, 그 밖에서는 글자 그대로
 * - *는 맨 앞(또는 ^·\( 바로 뒤)에서는 글자 그대로
 * - 역참조(\1~\9)는 JavaScript와 뜻이 달라(빈 그룹을 빈 문자열로 봄) 지원하지 않는다 → 오류
 */
function breToJs(p) {
  let out = '';
  let atStart = true; // 그룹이나 패턴의 맨 앞인지(^·* 해석용)
  let inBracket = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (inBracket) { out += c === '\\' ? '\\\\' : c; if (c === ']' && !/\[\^?$/.test(out.slice(0, -1).slice(-2))) inBracket = false; continue; }
    if (c === '[') { inBracket = true; out += c; if (p[i + 1] === '^') { out += '^'; i++; } if (p[i + 1] === ']') { out += '\\]'; i++; } atStart = false; continue; }
    if (c === '\\' && i + 1 < p.length) {
      const n = p[++i];
      if (/[1-9]/.test(n)) throw new Error('역참조(\\1~\\9)는 지원하지 않습니다');
      if (n === '(') { out += '('; atStart = true; continue; }
      if ('|+?){}'.includes(n)) { out += n; atStart = n === '|'; continue; }
      out += '\\' + n; atStart = false; continue;
    }
    if (c === '^') { out += atStart ? '^' : '\\^'; continue; }
    if (c === '$') { const end = i === p.length - 1 || p.slice(i + 1, i + 3) === '\\)' || p.slice(i + 1, i + 3) === '\\|'; out += end ? '$' : '\\$'; atStart = false; continue; }
    if (c === '*' && atStart) { out += '\\*'; atStart = false; continue; }
    if ('|+?(){}'.includes(c)) { out += '\\' + c; atStart = false; continue; }
    out += c; atStart = false;
  }
  return out;
}
function grep(args) {
  let quiet = false, ci = false, fixed = false, ere = false, count = false;
  const files = []; let pattern = null; let opts = true;
  for (const x of args) {
    if (opts && x === '--') { opts = false; continue; }
    if (opts && /^-[qiFEc]+$/.test(x)) { for (const c of x.slice(1)) { if (c === 'q') quiet = true; if (c === 'i') ci = true; if (c === 'F') fixed = true; if (c === 'E') ere = true; if (c === 'c') count = true; } continue; }
    if (pattern === null) { pattern = x; opts = false; } else files.push(x);
  }
  if (pattern === null || !files.length) { process.stderr.write('grep: 패턴과 파일이 필요합니다\n'); return 2; }
  let re = null;
  try { if (!fixed) re = new RegExp(ere ? pattern : breToJs(pattern), ci ? 'i' : ''); } catch (e) { process.stderr.write(`grep: 잘못된 패턴 ${e.message}\n`); return 2; }
  const has = (line) => (fixed ? (ci ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern)) : re.test(line));
  let total = 0; let err = false;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { process.stderr.write(`grep: ${f}: 파일을 읽을 수 없습니다\n`); err = true; continue; }
    // 빈 파일은 줄이 없고, 끝 줄바꿈 뒤에 빈 줄을 만들지 않는다
    const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
    let n = 0;
    for (const line of lines) if (has(line)) { n++; if (!quiet && !count) process.stdout.write(`${files.length > 1 ? `${f}:` : ''}${line}\n`); }
    if (count && !quiet) process.stdout.write(`${files.length > 1 ? `${f}:` : ''}${n}\n`);
    total += n;
  }
  // GNU grep과 같게: 오류가 있으면 2(단, -q이고 일치가 있으면 0), 일치 있으면 0, 없으면 1
  if (err && !(quiet && total > 0)) return 2;
  return total > 0 ? 0 : 1;
}
const code = cmd === 'test' ? test(rest) : cmd === 'grep' ? grep(rest) : (process.stderr.write(`지원하지 않는 내장 검사: ${cmd}\n`), 2);
process.exit(code);
