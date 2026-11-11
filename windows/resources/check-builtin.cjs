#!/usr/bin/env node
// Windows판 내장 검사 명령 — Windows에는 test·grep이 없으므로 같은 뜻의 최소 기능을 Node로 제공한다.
// 사용: check-builtin.cjs test -s|-f|-e|-d 경로
//       check-builtin.cjs grep [-q] [-i] [-F] [-E] [-c] 패턴 파일...
// 종료 코드: 0 = 참/일치 있음, 1 = 거짓/일치 없음, 2 = 사용법 오류. 셸을 거치지 않는다.
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
function grep(args) {
  let quiet = false, ci = false, fixed = false, count = false;
  const files = []; let pattern = null; let opts = true;
  for (const x of args) {
    if (opts && x === '--') { opts = false; continue; }
    if (opts && /^-[qiFEc]+$/.test(x)) { for (const c of x.slice(1)) { if (c === 'q') quiet = true; if (c === 'i') ci = true; if (c === 'F') fixed = true; if (c === 'c') count = true; } continue; }
    if (pattern === null) { pattern = x; opts = false; } else files.push(x);
  }
  if (pattern === null || !files.length) { process.stderr.write('grep: 패턴과 파일이 필요합니다\n'); return 2; }
  let re;
  try { re = fixed ? null : new RegExp(pattern, ci ? 'i' : ''); } catch (e) { process.stderr.write(`grep: 잘못된 패턴 ${e.message}\n`); return 2; }
  const has = (line) => (fixed ? (ci ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern)) : re.test(line));
  let total = 0; let err = false;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { process.stderr.write(`grep: ${f}: 파일을 읽을 수 없습니다\n`); err = true; continue; }
    let n = 0;
    for (const line of text.split(/\r?\n/)) if (has(line)) { n++; if (!quiet && !count) process.stdout.write(`${files.length > 1 ? `${f}:` : ''}${line}\n`); }
    if (count && !quiet) process.stdout.write(`${files.length > 1 ? `${f}:` : ''}${n}\n`);
    total += n;
  }
  if (total > 0) return 0;
  return err ? 2 : 1;
}
const code = cmd === 'test' ? test(rest) : cmd === 'grep' ? grep(rest) : (process.stderr.write(`지원하지 않는 내장 검사: ${cmd}\n`), 2);
process.exit(code);
