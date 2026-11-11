#!/usr/bin/env node
// 모의 Claude CLI — 오류·복구·흐름 검사 전용. 실제 모델을 호출하지 않는다.
// 실제 CLI와 같은 인자(-p, --output-format stream-json, --settings, --session-id/--resume, --json-schema)를 받아
// 같은 형태의 stream-json 이벤트를 출력한다. 앱 화면과 기록에는 "모의 실행"으로 구분 표시된다.
// 프롬프트 표식:
//   [[mock:fail]]            결과를 실패(is_error)로 보고
//   [[mock:crash]]           결과 이벤트 없이 종료 코드 3
//   [[mock:hang]]            오래 대기(취소·시간 초과 시험)
//   [[mock:gaps-once:이름]]   오퍼레이터 계획이 처음 한 번만 '근거 문서 보완 요청(gaps)'을 돌려줌
//   [[mock:limit-once:이름]]  처음 한 번만 사용 한도 도달(rate_limit_event rejected + is_error)로 끝남. 오퍼레이터가 먼저 맞고, 작업 지시에는 '이름-agent'로 넘긴다
//   [[mock:todo-first]]      첫 작성에는 TODO를 남기고 재작업 요청을 받으면 제거
//   [[mock:deny:bash:명령]] / [[mock:deny:read:경로]] 작성 직원이 권한 거부로 실패(오퍼레이터가 작업 지시에 넘김)
//   [[mock:learn:global|project:preference|environment|rule|fact:문장]] 학습 정리 때 배운 것으로 돌려줌
//   [[mock:dir:NAME]]        오퍼레이터가 NAME/docs/mission 아래에 쓰도록 계획(여러 저장소 시험)
//   [[mock:write-outside:경로]] 권한 엔진을 거치지 않고 범위 밖 파일을 직접 기록(사후 탐지 시험)
//   [[mock:try-edit:경로]]   허용 규칙 밖 파일 편집 시도 → 권한 거부로 보고
// Windows: 파이프 출력이 비동기라 process.exit 전에 내용이 잘릴 수 있어 동기 쓰기로 바꾼다
for (const s of [process.stdout, process.stderr]) { try { if (s._handle && s._handle.setBlocking) s._handle.setBlocking(true); } catch { /* 무시 */ } }
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const sessionId = opt('--resume') || opt('--session-id') || crypto.randomUUID();
const settings = JSON.parse(opt('--settings') || '{}');
const allow = (settings.permissions && settings.permissions.allow) || [];
const deny = (settings.permissions && settings.permissions.deny) || [];
const tools = (opt('--tools') || '').split(',').filter(Boolean);
const schema = opt('--json-schema');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const cwd = process.cwd();

function editAllowed(rel) {
  const norm = rel.replace(/^\.\//, '');
  const match = (rule) => {
    const m = /^Edit\(\.\/(.*)\)$/.exec(rule); if (!m) return false;
    const pat = m[1];
    if (pat === '**') return true;
    const base = pat.replace(/\/\*\*$/, '');
    return norm === base || norm.startsWith(base + '/');
  };
  if (deny.some(match)) return false;
  if (!tools.includes('Edit') && !tools.includes('Write')) return false;
  return allow.some(match);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', main);

async function main() {
  const prompt = input;
  const denials = [];
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd, tools, model: 'mock-model', permissionMode: argv[argv.indexOf('--permission-mode') + 1], mock: true });
  if (prompt.includes('[[mock:leak]]')) out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'env: ANTHROPIC_API_KEY=sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234 token: ghp_FAKEFAKEFAKEFAKEFAKEFAKE12' }] } });
  const isOperator = prompt.includes('# 오퍼레이터 ');
  // 화면 시험용: 임시 폴더에 crewgenai-mock-slow-claude 파일이 있으면 그 밀리초만큼 늦게 시작한다(모든 호출)
  const slowF = path.join(require('node:os').tmpdir(), 'crewgenai-mock-slow-claude');
  if (fs.existsSync(slowF)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(slowF, 'utf8')) || 0);
  for (const m of isOperator ? [] : prompt.matchAll(/\[\[mock:wait-while:(.+?)\]\]/g)) {
    out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: `${m[1]} 파일이 사라질 때까지 대기합니다.` }] } });
    while (fs.existsSync(path.resolve(cwd, m[1]))) await new Promise((r) => setTimeout(r, 100));
  }
  for (const m of prompt.matchAll(/\[\[mock:limit-once:([\w-]+)\]\]/g)) {
    const flag = path.join(require('node:os').tmpdir(), `crewgenai-mock-limit-${m[1]}`);
    if (fs.existsSync(flag)) continue;
    fs.writeFileSync(flag, String(Date.now()));
    const resetsAt = Math.floor(Date.now() / 1000) + 3; // Windows판: 느린 환경에서도 미션이 한도 상태를 볼 수 있게 3초
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' }, session_id: sessionId });
    out({ type: 'assistant', session_id: sessionId, error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your limit · resets soon" }] } });
    out({ type: 'result', subtype: 'success', is_error: true, session_id: sessionId, result: "You've hit your limit · resets soon", permission_denials: [] });
    process.exit(1);
  }
  // 학습 정리: 대화에 [[mock:learn:범위:종류:문장]]이 있으면 그 항목을 배운 것으로 돌려준다
  if (prompt.includes('# 학습 정리')) {
    const items = [...prompt.matchAll(/\[\[mock:learn:(global|project):(preference|environment|rule|fact):([^\]]+)\]\]/g)].map(([, scope, kind, text]) => ({ scope, kind, text }));
    const res = { items };
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify(res), structured_output: res, permission_denials: [] });
    process.exit(0);
  }
  // [[mock:deny:bash:명령]] / [[mock:deny:read:경로]] — 권한 거부로 작업을 끝내지 못함(작성 직원만)
  const denyMarks = isOperator || schema ? [] : [...prompt.matchAll(/\[\[mock:deny:(bash|read):([^\]]+)\]\]/g)];
  if (denyMarks.length) {
    const den = [];
    for (const [, kind, target] of denyMarks) {
      const id = crypto.randomUUID();
      if (kind === 'bash') {
        out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: target } }] } });
        out({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: "Permission to use Bash has been denied because Claude Code is running in don't ask mode." }] } });
        den.push({ tool_name: 'Bash', tool_use_id: id, tool_input: { command: target } });
      } else {
        out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: target } }] } });
        out({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `${target} is outside ${cwd}; --restricted confines the file tools to the working directory.` }] } });
      }
    }
    out({ type: 'result', subtype: 'success', is_error: true, session_id: sessionId, result: '권한 거부로 작업을 끝내지 못했습니다.', permission_denials: den });
    process.exit(1);
  }
  if (prompt.includes('[[mock:crash]]')) { process.stderr.write('mock crash\n'); process.exit(3); }
  if (!isOperator && prompt.includes('[[mock:hang]]')) { out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: '오래 걸리는 작업을 진행합니다.' }] } }); await new Promise((r) => setTimeout(r, 600000)); }

  // 산출물 목록: "- 경로 (형식)" 줄을 "## 산출물" 구획에서 읽는다.
  const section = (prompt.split('## 산출물')[1] || '').split('\n## ')[0];
  const outputs = [...section.matchAll(/^- (.+?) \((\w+)\)/gm)].map((m) => ({ rel: m[1].trim(), format: m[2] }));
  const rework = prompt.includes('## 재작업 요청');

  if (schema && prompt.includes('# 오퍼레이터 계획')) {
    const cyc = Number((prompt.match(/## 사이클: (\d+)/) || [])[1] || 1);
    const code = ((prompt.split('## 사용 가능한 직원')[1] || '').match(/^- (\d+) .*쓰기 가능/m) || [])[1] || '01';
    const user = (prompt.split('## 사용자 지시')[1] || '').split('\n## ')[0];
    const answered = prompt.includes('사용자 답변: ');
    const ask = user.includes('[[mock:ask]]') && !answered;
    const gm = user.match(/\[\[mock:gaps-once:([\w-]+)\]\]/);
    if (gm) {
      const flag = path.join(require('node:os').tmpdir(), `crewgenai-mock-gaps-${gm[1]}`);
      if (!fs.existsSync(flag)) {
        fs.writeFileSync(flag, String(Date.now()));
        const docsLine = (prompt.split('## 근거 문서')[1] || '').split('\n## ')[0];
        const gplan = { summary: '근거 부족', question: '', tasks: [], gaps: [
          { doc: (docsLine.match(/: (\S+\.md) \(없음\)/) || [])[1] || '고객사 요구사항 정의서', issue: '요구사항의 우선순위와 수용 기준이 없다', need: '각 요구사항의 우선순위(필수/선택)와 수용 기준' },
          { doc: '서비스 기획서', issue: '대상 사용자 범위가 애매하다', need: '1차 출시 대상 사용자군' }] };
        out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify(gplan), structured_output: gplan, permission_denials: [] });
        return;
      }
    }
    const md = (user.match(/\[\[mock:dir:([\w-]+)\]\]/) || [])[1]; // 여러 저장소 시험: 이 하위 폴더 안에 작성
    const mdir = md ? `${md}/docs/mission` : 'docs/mission';
    const plan = ask ? { summary: '정보 부족', question: '어느 문서를 기준으로 할까요?', tasks: [] } : {
      summary: `사이클 ${cyc} 작업 1개`, question: '',
      tasks: [{ title: `문서 작성 ${cyc}`, agentCode: code, instructions: `${mdir}/cycle-${cyc}.md를 작성한다. ${user.includes('[[mock:todo-first]]') ? '[[mock:todo-first]]' : ''} ${user.includes('[[mock:hang]]') ? '[[mock:hang]]' : ''} ${(user.match(/\[\[mock:limit-once:([\w-]+)\]\]/) || [])[1] ? `[[mock:limit-once:${user.match(/\[\[mock:limit-once:([\w-]+)\]\]/)[1]}-agent]]` : ''} ${(user.match(/\[\[mock:deny:[^\]]+\]\]/g) || []).join(' ')}`,
        writeScope: [mdir], outputs: [{ path: `${mdir}/cycle-${cyc}.md`, format: 'markdown' }], doneCriteria: 'TODO 없이 작성', checkCommand: user.includes('[[mock:check-sh]]') ? ['sh', '-c', 'touch pwned.txt'] : [] }] };
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify(plan), structured_output: plan, permission_denials: [] });
    process.exit(0);
  }
  if (schema && prompt.includes('# 오퍼레이터 판단')) {
    const cyc = Number((prompt.match(/## 사이클: (\d+)/) || [])[1] || 1);
    const failed = /## 실행 결과: (failed|cancelled)/.test(prompt);
    const dec = failed ? { decision: 'ask_user', summary: '실행 실패', question: '실패를 어떻게 처리할까요?', nextFocus: '' }
      : cyc >= 2 ? { decision: 'done', summary: '두 사이클로 목표 충족', question: '', nextFocus: '' }
      : { decision: 'continue', summary: '1차 결과 확인, 보완 필요', question: '', nextFocus: '보완' };
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify(dec), structured_output: dec, permission_denials: [] });
    process.exit(0);
  }
  if (schema) {
    // 검토자: 산출물을 읽어 TODO가 남아 있으면 수정 요청
    const reviewSection = (prompt.split('## 검토 대상')[1] || '').split('\n## ')[0];
    const targets = [...reviewSection.matchAll(/^- (.+)$/gm)].map((m) => m[1].trim());
    const issues = [];
    for (const t of targets) {
      const p = path.resolve(cwd, t);
      out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: crypto.randomUUID(), name: 'Read', input: { file_path: p } }] } });
      if (!fs.existsSync(p)) issues.push(`${t} 파일이 없습니다.`);
      else if (fs.readFileSync(p, 'utf8').includes('TODO')) issues.push(`${t}에 TODO가 남아 있습니다.`);
    }
    if (prompt.includes('[[mock:leak-review]]')) issues.push('검토 중 발견한 값 token=sk-ant-api03-REVIEWFAKEFAKEFAKE99');
    const verdict = issues.length ? 'changes_requested' : 'approve';
    const structured = { verdict, summary: issues.length ? '수정이 필요합니다.' : '완료 조건을 충족합니다.', issues };
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify(structured), structured_output: structured, num_turns: 2, permission_denials: [] });
    process.exit(0);
  }

  for (const o of outputs) {
    const id = crypto.randomUUID();
    out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: path.resolve(cwd, o.rel) } }] } });
    if (!editAllowed(o.rel)) {
      denials.push({ tool_name: 'Write', tool_use_id: id, tool_input: { file_path: o.rel } });
      out({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `Permission to write ${o.rel} has been denied.` }] } });
      continue;
    }
    const todo = prompt.includes('[[mock:todo-first]]') && !rework;
    let body;
    if (o.format === 'json') body = JSON.stringify({ status: 'done', fixed: rework, todo: todo ? 'TODO' : undefined }, null, 2);
    else if (o.format === 'html') body = `<!doctype html><html><body><h1>모의 산출물</h1><p>${todo ? 'TODO' : '완료'}</p></body></html>`;
    else body = `# 모의 산출물\n\n${rework ? 'FIXED: 재작업 요청을 반영했습니다.\n' : ''}${todo ? 'TODO: 남은 작업\n' : '내용 작성 완료\n'}`;
    fs.mkdirSync(path.dirname(path.resolve(cwd, o.rel)), { recursive: true });
    fs.writeFileSync(path.resolve(cwd, o.rel), body);
    out({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'File written' }] } });
  }
  for (const m of prompt.matchAll(/\[\[mock:try-edit:(.+?)\]\]/g)) {
    const id = crypto.randomUUID();
    out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: m[1] } }] } });
    if (!editAllowed(m[1])) {
      denials.push({ tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: m[1] } });
      out({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `Permission to edit ${m[1]} has been denied.` }] } });
    }
  }
  for (const m of prompt.matchAll(/\[\[mock:write-outside:(.+?)\]\]/g)) {
    fs.mkdirSync(path.dirname(path.resolve(cwd, m[1])), { recursive: true });
    fs.writeFileSync(path.resolve(cwd, m[1]), 'outside');
  }
  const failed = prompt.includes('[[mock:fail]]');
  out({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, session_id: sessionId,
    result: failed ? '모의 실패' : `모의 작업 완료${rework ? '(재작업 반영)' : ''}. 변경: ${outputs.map((o) => o.rel).join(', ')}\n결정 필요: 모의 실행에서는 없음`,
    num_turns: 3, permission_denials: denials });
  process.exit(failed ? 1 : 0);
}
