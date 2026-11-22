#!/usr/bin/env node
// 모의 Claude CLI — 오류·복구·흐름 검사 전용. 실제 모델을 호출하지 않는다.
// 실제 CLI와 같은 인자(-p, --output-format stream-json, --settings, --session-id/--resume, --json-schema)를 받아
// 같은 형태의 stream-json 이벤트를 출력한다. 앱 화면과 기록에는 "모의 실행"으로 구분 표시된다.
// 프롬프트 표식:
//   [[mock:fail]]            결과를 실패(is_error)로 보고
//   [[mock:crash]]           결과 이벤트 없이 종료 코드 3
//   [[mock:hang]]            오래 대기(취소·시간 초과 시험)
//   [[mock:hang-once]]       첫 시도는 docs/부분.md를 만든 뒤 멈춤(시간 초과), --resume으로 이어 가면 정상 완료
//   [[mock:gaps-once:이름]]   오퍼레이터 계획이 처음 한 번만 '근거 문서 보완 요청(gaps)'을 돌려줌
//   [[mock:limit-once:이름]]  처음 한 번만 사용 한도 도달(rate_limit_event rejected + is_error)로 끝남. 오퍼레이터가 먼저 맞고, 작업 지시에는 '이름-agent'로 넘긴다
//   [[mock:todo-first]]      첫 작성에는 TODO를 남기고 재작업 요청을 받으면 제거
//   [[mock:code]]            작성 직원이 산출물 옆에 코드 파일(.mjs)도 하나 만든다(코드 변경이 있어야 붙는 리뷰 시험)
//   [[mock:deny:bash:명령]] / [[mock:deny:read:경로]] 작성 직원이 권한 거부로 실패(오퍼레이터가 작업 지시에 넘김)
//   [[mock:learn:global|project:preference|environment|rule|fact:문장]] 학습 정리 때 배운 것으로 돌려줌
//   [[mock:dir:NAME]]        오퍼레이터가 NAME/docs/mission 아래에 쓰도록 계획(여러 저장소 시험)
//   [[mock:write-outside:경로]] 권한 엔진을 거치지 않고 범위 밖 파일을 직접 기록(사후 탐지 시험)
//   [[mock:try-edit:경로]]   허용 규칙 밖 파일 편집 시도 → 권한 거부로 보고
//   [[mock:two-tasks]]       오퍼레이터가 작업을 둘로 계획(둘째는 거부 표식 없이 정상 작성)
//   [[mock:ignore-parked]]   오퍼레이터가 '보류한 업무'를 무시하고 같은 작업을 다시 계획
//   [[mock:needs:명령]]       첫 작업에 실행 전 점검용 필요 명령(needs.commands)을 적음
//   [[mock:gaps-with-tasks]] 오퍼레이터가 근거 부족(gaps)을 적으면서도 작업을 계획
//   [[mock:gaps-options]]    근거 부족 항목에 선택지(options)를 달고 작업도 계획(사용자 결정이 있으면 그 항목은 다시 내지 않음)
//   [[mock:gaps-options-only]] 선택지 달린 근거 부족만 내고 작업 없음 — 사용자 결정이 생기면 작업을 계획
//   [[mock:secret-gap]]     API 키가 있어야 하는 결정(.env 저장 위치 secret 포함)만 내고 작업 없음 — 결정이 생기면 작업을 계획
//   [[mock:perm-request]]   첫 판단에서 직원 09의 curl 허용을 요청(넓은 셸 요청은 앱이 걸러야 함)
//   [[mock:workplan]]       진척 관리: 첫 갱신에서 단원 3개(하나는 근거 없는 완료), 다음 갱신에서 모두 근거와 함께 완료
//   [[mock:workplan-stuck]] 진척 관리: 다음 갱신에서도 W3이 남고, 이유 없이 W3을 빼려 함(앱이 거부해야 함)
//   [[mock:staff]]          오퍼레이터가 직원 제안(새 직원·역할 변경, 오퍼레이터 00 변경은 걸러져야 함)을 함께 냄(기록에 있으면 다시 내지 않음)
//   [[mock:ask-options]]     계획 질문을 선택지(questionOptions)와 함께 묻는다(답변 전 한 번)
//   [[mock:commit-request]]  판단에서 이미 있는 미커밋 파일(pending.txt) 커밋을 요청(목록에 있으면 다시 내지 않음)
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
// 시험용: 받은 인자·환경을 기록한다(CREWGENAI_MOCK_ARGV_DIR을 지정한 시험에서만)
if (process.env.CREWGENAI_MOCK_ARGV_DIR) { try { fs.writeFileSync(path.join(process.env.CREWGENAI_MOCK_ARGV_DIR, `${sessionId}.json`), JSON.stringify({ argv, cwd, env: { TMPDIR: process.env.TMPDIR || '', JAVA_TOOL_OPTIONS: process.env.JAVA_TOOL_OPTIONS || '', AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY } })); } catch { /* 무시 */ } }

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
  // 실행 환경 점검: [[mock:probe-fail]]이 프로젝트 경로에 있으면 쓰기 실패로, 아니면 모두 됨으로 보고
  // 문의 응대: 질문에 짧게 답한다. 질문에 [[mock:qa-directive]]가 있으면 추가 지시 제안을 함께 낸다
  if (schema && prompt.includes('# 문의 답변')) {
    const q = (prompt.split('## 질문\n')[1] || '').split('\n## 규칙')[0].trim();
    const ans = { answer: `모의 답변: "${q.slice(0, 40)}"에 대해 진행 기록을 보고 답합니다.`, directive: q.includes('[[mock:qa-directive]]') ? '저장 기능을 목록보다 먼저 하라' : '' };
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify(ans), structured_output: ans, permission_denials: [] });
    process.exit(0);
  }
  // 진척 관리 직원: 프로젝트 진척(큰 단계·기능 목록) 갱신
  if (schema && prompt.includes('# 진척 갱신')) {
    const dec = (prompt.match(/오퍼레이터 판단\((\w+)\)/) || [])[1];
    const has = /## 지금 진척 목록\n(### |- W)/.test(prompt);
    let wp;
    if (prompt.includes('[[mock:workplan]]') || prompt.includes('[[mock:workplan-stuck]]')) {
      const stuck = prompt.includes('[[mock:workplan-stuck]]');
      wp = !has ? { summary: '3개 중 1개 완료', phases: [{ title: '기반', goal: '데이터 저장' }, { title: '화면', goal: '목록·상세' }], items: [
        { phase: '화면', title: '목록 화면', criteria: '목록 시험 통과', status: 'done', refs: ['FN-001'], evidence: 'npm test 3 passed' },
        { phase: '화면', title: '상세 화면', criteria: '상세 시험 통과', status: 'done', refs: ['FN-002'], evidence: '' },
        { phase: '기반', title: '저장', criteria: '저장 후 다시 열어 값 확인', status: 'todo', refs: ['FN-003'] }] }
        : { summary: stuck ? '3개 중 2개 완료' : '모두 완료', phases: [], items: [
          { id: 'W2', phase: 'P2', title: '상세 화면', criteria: '상세 시험 통과', status: 'done', evidence: 'npm test 2 passed' },
          { id: 'W3', phase: 'P1', title: '저장', criteria: '저장 후 다시 열어 값 확인', status: stuck ? 'doing' : 'done', evidence: stuck ? '' : '화면 확인 기록 save.png' }],
          ...(stuck ? { removed: [{ id: 'W3', reason: '' }] } : {}) };
    } else {
      wp = { summary: '', phases: has ? [] : [{ title: '전체', goal: '지시 완료' }], items: [{ ...(has ? { id: 'W1' } : {}), phase: '전체', title: '지시 완료', criteria: '오퍼레이터가 완료로 판단', status: dec === 'done' ? 'done' : 'doing', evidence: dec === 'done' ? '오퍼레이터 완료 판단(모의)' : '' }] };
    }
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify(wp), structured_output: wp, permission_denials: [] });
    process.exit(0);
  }
  if (prompt.includes('# 실행 환경 점검')) {
    const res = { output: prompt.includes('probe-nowrite') ? 'READ_OK\nNODE: v20' : 'W_OK\nPORT_OK\nREAD_OK\nNODE: v20' };
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify(res), structured_output: res, permission_denials: [], total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 } });
    process.exit(0);
  }
  // 화면 시험용: 임시 폴더에 crewgenai-mock-slow-claude 파일이 있으면 그 밀리초만큼 늦게 시작한다(모든 호출)
  const slowF = path.join((process.env.CREWGENAI_MOCK_STATE || require('node:os').tmpdir()), 'crewgenai-mock-slow-claude');
  if (fs.existsSync(slowF)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(slowF, 'utf8')) || 0);
  for (const m of isOperator ? [] : prompt.matchAll(/\[\[mock:wait-while:(.+?)\]\]/g)) {
    out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: `${m[1]} 파일이 사라질 때까지 대기합니다.` }] } });
    while (fs.existsSync(path.resolve(cwd, m[1]))) await new Promise((r) => setTimeout(r, 100));
  }
  // [[mock:netfail-once:이름]] 오퍼레이터 호출이 처음 한 번 연결 장애로 실패
  for (const m of isOperator ? prompt.matchAll(/\[\[mock:netfail-once:([\w-]+)\]\]/g) : []) {
    const flag = path.join((process.env.CREWGENAI_MOCK_STATE || require('node:os').tmpdir()), `crewgenai-mock-netfail-${m[1]}`);
    if (fs.existsSync(flag)) continue;
    fs.writeFileSync(flag, String(Date.now()));
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'API Error: fetch failed (ECONNRESET)', permission_denials: [] });
    process.exit(1);
  }
  for (const m of prompt.matchAll(/\[\[mock:limit-once:([\w-]+)\]\]/g)) {
    const flag = path.join((process.env.CREWGENAI_MOCK_STATE || require('node:os').tmpdir()), `crewgenai-mock-limit-${m[1]}`);
    if (fs.existsSync(flag)) continue;
    fs.writeFileSync(flag, String(Date.now()));
    const resetsAt = Math.floor(Date.now() / 1000) + 1;
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
  // 첫 시도는 일부 파일을 만든 뒤 멈춰 시간 제한에 걸리고, 같은 세션으로 이어 가면(--resume) 정상으로 끝난다
  if (!isOperator && prompt.includes('[[mock:hang-once]]') && !opt('--resume')) {
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'docs', '부분.md'), '# 시간 초과 전에 만든 부분\n');
    out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: '큰 작업을 진행합니다.' }] } }); await new Promise((r) => setTimeout(r, 600000));
  }
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
      const flag = path.join((process.env.CREWGENAI_MOCK_STATE || require('node:os').tmpdir()), `crewgenai-mock-gaps-${gm[1]}`);
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
    const parked = prompt.includes('## 보류한 업무(') && !user.includes('[[mock:ignore-parked]]');
    const denyMarks = (user.match(/\[\[mock:deny:[^\]]+\]\]/g) || []);
    const needCmd = (user.match(/\[\[mock:needs:([^\]]+)\]\]/) || [])[1];
    const plan = ask ? { summary: '정보 부족', question: '어느 문서를 기준으로 할까요?', tasks: [] } : {
      summary: `사이클 ${cyc} 작업 1개`, question: '',
      tasks: [{ title: `문서 작성 ${cyc}`, agentCode: code, instructions: `${mdir}/cycle-${cyc}.md를 작성한다. ${user.includes('[[mock:todo-first]]') ? '[[mock:todo-first]]' : ''} ${user.includes('[[mock:code]]') ? '[[mock:code]]' : ''} ${user.includes('[[mock:hang]]') ? '[[mock:hang]]' : ''} ${(user.match(/\[\[mock:limit-once:([\w-]+)\]\]/) || [])[1] ? `[[mock:limit-once:${user.match(/\[\[mock:limit-once:([\w-]+)\]\]/)[1]}-agent]]` : ''} ${(user.match(/\[\[mock:deny:[^\]]+\]\]/g) || []).join(' ')}`,
        writeScope: [mdir], outputs: [{ path: `${mdir}/cycle-${cyc}.md`, format: 'markdown' }], doneCriteria: 'TODO 없이 작성', checkCommand: user.includes('[[mock:check-sh]]') ? ['sh', '-c', 'touch pwned.txt'] : [],
        ...(needCmd ? { needs: { commands: [needCmd], readPaths: [] } } : {}) }] };
    if (!ask && user.includes('[[mock:two-tasks]]')) plan.tasks.push({ title: `보조 문서 ${cyc}`, agentCode: code, instructions: `${mdir}-b/cycle-${cyc}.md를 작성한다.`, writeScope: [`${mdir}-b`], outputs: [{ path: `${mdir}-b/cycle-${cyc}.md`, format: 'markdown' }], doneCriteria: '작성', checkCommand: [] });
    if (!ask && user.includes('[[mock:ref]]')) plan.references = [{ url: 'https://example.com/board', why: '화면 구성 참고' }, { url: 'http://192.168.0.10/admin', why: '사설망(막혀야 함)' }];
    // 산출물을 작업 수정 경로 옆(같은 허용 경로 안)에 낸다: 앱이 그 파일을 수정 경로에 더해야 한다
    if (!ask && user.includes('[[mock:out-sibling]]')) plan.tasks[0].outputs = [{ path: `docs/tests/cycle-${cyc}.md`, format: 'markdown' }];
    // 처음 계획은 허용 경로 밖을 쓴다(앱 검사 실패) → 앱이 이유를 알려 주면 고쳐서 다시 낸다
    if (!ask && user.includes('[[mock:bad-plan-once]]') && !prompt.includes('## 직전 계획이 앱 검사에서 걸림')) { plan.tasks[0].writeScope = ['outside']; plan.tasks[0].outputs = [{ path: 'outside/x.md', format: 'markdown' }]; }
    // 보류한 업무(거부·필요 명령이 있는 첫 작업)는 다시 계획하지 않는다
    if (!ask && parked && (denyMarks.length || needCmd)) plan.tasks = plan.tasks.slice(1);
    if (!ask && !plan.tasks.length) plan.question = '보류한 업무를 해결해야 진행할 수 있습니다.';
    if (!ask && user.includes('[[mock:gaps-with-tasks]]')) plan.gaps = [{ doc: '서비스 기획서', issue: '대상 사용자 범위가 애매하다', need: '1차 출시 대상 사용자군' }];
    const scode = ((prompt.split('## 사용 가능한 직원')[1] || '').match(/^- (0[1-9]|[1-9]\d) .*쓰기 가능/m) || [])[1] || code;
    if (!ask && user.includes('[[mock:staff]]') && !prompt.includes('## 직원 제안 기록')) plan.staffProposals = [
      { kind: 'add', agentCode: scode, name: '화면 검수', role: '화면과 문서 대조', instructions: '화면 시안과 기능 대조표를 비교해 다른 점을 적는다.', workPaths: ['docs/qa'], reason: '사이클 결과에서 화면 대조 담당이 없어 같은 지적이 반복됨' },
      { kind: 'update', agentCode: scode, name: '', role: '문서 작성(근거 줄 번호 필수)', instructions: '근거 문서의 줄 번호를 붙여 작성한다.', workPaths: [], reason: '근거 위치 없이 작성해 재검토에서 반려됨' },
      { kind: 'update', agentCode: '00', name: '', role: '오퍼레이터', instructions: '바꾼 지시', workPaths: [], reason: '걸러져야 함' }];
    const decided = prompt.includes('## 사용자 결정(');
    const optGap = { doc: '기능 대조표.md', issue: '항목 A가 화면 시안과 제품에서 다르다', need: '어느 쪽을 기준으로 할지', explain: '기능 대조표 2줄에는 버튼이 위에 있다고 적혀 있지만 제품에는 본문에 있습니다. 어느 쪽을 맞출지 정해야 화면 작업을 시작할 수 있습니다.', refs: [{ path: 'docs/기능 대조표.md', line: 2 }], options: ['HTML 기준 유지 — 제품을 HTML에 맞춘다', '제품 기준 승인 — HTML을 제품에 맞춘다'] };
    if (!ask && user.includes('[[mock:gaps-options]]') && !decided) plan.gaps = [optGap];
    if (!ask && user.includes('[[mock:secret-gap]]') && !decided) { plan.tasks = []; plan.question = ''; plan.gaps = [{ doc: '외부 연동.md', issue: '외부 API 키가 있어야 연동을 시험할 수 있다', need: 'DEMO_API_KEY를 .env에 넣어야 한다', kind: 'decide', blocking: true, secret: { file: '.env', name: 'DEMO_API_KEY', source: '예시 서비스 콘솔' } }]; }
    if (!ask && user.includes('[[mock:gaps-options-only]]') && !decided) { plan.tasks = []; plan.question = ''; plan.gaps = [optGap]; }
    // 되돌리기 쉬운 세부는 가정(assume), 사람이 정할 것은 결정(decide, 진행은 계속)
    if (!ask && user.includes('[[mock:assume]]')) plan.gaps = [
      { doc: '화면 기획.md', issue: '저장 버튼 위치가 문서에 없다', need: '', kind: 'assume', assumption: '저장 버튼은 화면 오른쪽 위에 둔다' },
      ...(decided ? [] : [{ ...optGap, kind: 'decide', blocking: false }]),
    ];
    if (user.includes('[[mock:ask-options]]') && !answered) { plan.tasks = []; plan.gaps = []; plan.question = '어느 기준으로 진행할까요?'; plan.questionOptions = ['HTML 기준', '제품 기준']; }
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify(plan), structured_output: plan, permission_denials: [] });
    process.exit(0);
  }
  if (schema && prompt.includes('# 오퍼레이터 판단')) {
    const cyc = Number((prompt.match(/## 사이클: (\d+)/) || [])[1] || 1);
    const failed = /## 실행 결과: (failed|cancelled)/.test(prompt) && !prompt.includes('## 보류한 업무(');
    const dec = failed ? { decision: 'ask_user', summary: '실행 실패', question: '실패를 어떻게 처리할까요?', nextFocus: '' }
      : cyc >= 2 ? { decision: 'done', summary: '두 사이클로 목표 충족', question: '', nextFocus: '' }
      : { decision: 'continue', summary: '1차 결과 확인, 보완 필요', question: '', nextFocus: '보완' };
    // 큰 결과가 준비되면 검토 지점(review): 기능·시연 순서·검증 범위·결정(최대 3)·가정을 한곳에
    if (prompt.includes('[[mock:review]]') && !failed) {
      const reviewed = prompt.includes('검토 지점 결정') || prompt.includes('[검토 피드백');
      if (!reviewed && cyc < 3) Object.assign(dec, { decision: 'review', summary: '전체 화면과 핵심 흐름 준비', nextFocus: '피드백 반영', checkpoint: { title: '회사 관리 전체 흐름', steps: '1. 목록 열기 → 2. 회사 선택 → 3. 메모 저장 → 다시 열어 저장값 확인', verified: '목록·상세·저장을 시연 환경에서 실제로 실행', unverified: '권한별 화면은 준비 중', features: [{ name: '회사 목록·상세', changed: '실제 API 연결', status: 'reviewable' }], decisions: [{ question: '삭제 기능을 1차에 넣을까요?', choices: [{ label: '넣는다', effect: '삭제 버튼과 확인 창을 만든다', recommended: false, why: '' }, { label: '2차로 미룬다', effect: '이번에는 숨긴다', recommended: true, why: '정책이 아직 없음' }] }], assumptions: ['메모는 최대 500자로 가정'] } });
      else Object.assign(dec, { decision: 'done', summary: '피드백 반영 완료', question: '', nextFocus: '' });
    }
    if (prompt.includes('[[mock:perm-request]]') && cyc === 1) dec.permissionRequests = [{ agentCode: '09', command: 'curl -s http://localhost:8080/health', why: '시연 서버 응답을 직접 확인해야 합니다' }, { agentCode: '09', command: 'bash -c "echo x"', why: '넓은 셸은 묻지 않아야 함' }];
    if (prompt.includes('[[mock:milestone]]') && prompt.includes('## 커밋·main 병합') && !prompt.includes('지금 main 병합을 묻는 중')) dec.milestone = { title: '첫 화면 완성', summary: '첫 화면과 시험이 통과' };
    if (prompt.includes('[[mock:commit-request]]') && !prompt.includes('## 커밋 요청(최근)')) dec.commitRequests = [{ repo: '', files: ['pending.txt'], message: '대기 변경 커밋', why: '다음 작업에 필요' }];
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
    if (prompt.includes('[[mock:code]]') && editAllowed(`${o.rel}.mjs`)) fs.writeFileSync(path.resolve(cwd, `${o.rel}.mjs`), `export const done = ${!todo};\n`);
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
