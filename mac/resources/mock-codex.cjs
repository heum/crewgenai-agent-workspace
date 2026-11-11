#!/usr/bin/env node
// 모의 Codex CLI — 시험 전용. 실제 Codex와 같은 인자(exec ... --output-schema F -o F -)를 받아 구조화 리뷰 결과를 -o 파일에 쓴다.
// "## 검토 대상" 목록의 파일에 TODO가 있으면 수정 요청, 없으면 승인.
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const sec = (input.split('## 검토 대상')[1] || '').split('\n## ')[0];
  const targets = [...sec.matchAll(/^- (.+)$/gm)].map((m) => m[1].trim());
  const findings = [];
  for (const t of targets) {
    const p = path.resolve(process.cwd(), t);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
    if (fs.readFileSync(p, 'utf8').includes('TODO')) findings.push({ severity: 'P1', file: t, issue: 'TODO가 남아 있습니다.', fix: 'TODO를 실제 내용으로 바꾸세요.' });
  }
  const res = { verdict: findings.length ? 'changes_requested' : 'approve', summary: findings.length ? '수정 필요' : '문제 없음', findings };
  // 화면 시험용: 임시 폴더에 crewgenai-mock-slow-codex 파일이 있으면 그 안의 밀리초만큼 늦게 끝난다
  const slow = path.join(require('node:os').tmpdir(), 'crewgenai-mock-slow-codex');
  const wait = fs.existsSync(slow) ? Number(fs.readFileSync(slow, 'utf8')) || 0 : 0;
  setTimeout(() => {
    process.stdout.write('codex(모의) 리뷰 완료\n');
    fs.writeFileSync(opt('-o'), JSON.stringify(res));
    process.exit(0);
  }, wait);
});
