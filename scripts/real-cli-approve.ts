// 실제 CLI 시험 실행의 팀장 검토를 '검토 완료'로 기록하고 최종 상태를 확인한다.
// 사용: node dist/verify/real-cli-approve.cjs <real-cli 출력 폴더>
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Service } from '../src/main/service';
const out = resolve(process.argv[2]);
const r = JSON.parse(readFileSync(join(out, 'real-cli-result.json'), 'utf8'));
const svc = new Service({ dbFile: join(out, 'real-cli.sqlite'), mockScript: '', emit: () => {} });
void (async () => {
  const d = svc.engine.detail(r.run.id);
  const ur = d.graph.nodes.find((n) => n.kind === 'userReview')!;
  await svc.engine.submitReview(r.run.id, ur.id, 'approve', '실제 CLI 시험 결과 확인', null, d.currentSubjectHash!);
  for (let i = 0; i < 200 && (svc.engine.isActive(r.run.id) || svc.store.getRun(r.run.id).status === 'review_wait'); i++) await new Promise((x) => setTimeout(x, 100));
  const fin = svc.store.getRun(r.run.id);
  r.finalApproval = { status: fin.status, reason: fin.reason, userReviews: svc.store.reviews(r.run.id).filter((x) => x.kind === 'user').map((x) => ({ verdict: x.verdict, stale: x.stale })) };
  writeFileSync(join(out, 'real-cli-result.json'), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r.finalApproval));
  svc.close();
})();
