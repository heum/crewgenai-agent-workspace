// 비정상 종료 시험용 하네스: 실행을 시작하고 두 번째 단계가 실행 중이 되면 READY를 출력한 뒤 대기한다.
// 시험은 이 프로세스를 SIGKILL로 강제 종료한다(앱 비정상 종료 재현).
import { Service } from '../../src/main/service';
import { agentFields, e, n, plan } from '../helpers';

const [dbFile, folder, mock] = process.argv.slice(2);
const svc = new Service({ dbFile, mockScript: mock, emit: () => {} });
svc.saveSettings({ executor: 'mock', maxConcurrent: 2 });
const p = svc.createProject(plan(folder));
const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
const inp = n('input', '입력');
const a = n('agent', '첫 작업', { agentId: w.id, writeScope: ['docs'], outputs: [{ path: 'docs/first.md', format: 'markdown', required: true }] });
const b = n('agent', '둘째 작업', { agentId: w.id, instructions: '작성 [[mock:wait-while:HOLD]]', writeScope: ['src'], outputs: [{ path: 'src/second.md', format: 'markdown', required: true }] });
const m = n('merge', '취합'); const ur = n('userReview', '팀장 검토');
const saved = svc.saveGraph(p.id, { nodes: [inp, a, b, m, ur], edges: [e(inp, a), e(a, b), e(b, m), e(m, ur), e(ur, a, 'fail')] }, '');
if (!saved.version) { console.log('ERR', JSON.stringify(saved.issues)); process.exit(2); }
void svc.startRun(p.id, saved.version.id).then(async (run) => {
  for (;;) {
    const at = svc.store.runAttempts(run.id).find((x) => x.nodeId === b.id && x.pid);
    if (at) { const evs = svc.store.events(at.id); if (evs.length >= 2) { console.log(`READY ${JSON.stringify({ runId: run.id, pid: at.pid, aId: a.id, bId: b.id })}`); break; } }
    await new Promise((r) => setTimeout(r, 50));
  }
});
setInterval(() => {}, 1000);
