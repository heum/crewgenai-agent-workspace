// 작업 줄 시험 — 먼저 끝난 작업은 다른 작업을 기다리지 않고 바로 Codex 리뷰·다음 단계로 간다
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { laneBlocks } from '../src/main/engine/lanes';
import { agentFields, e, mkService, n, plan, sleep, tmpProject, waitRun } from './helpers';

describe('작업 줄(먼저 끝난 작업부터 다음 단계로)', () => {
  it('묶음 찾기: 작성 → 리뷰 → 재검토 → 검사(실패 시 작성으로)는 한 묶음, 입력·합류는 따로', () => {
    const inp = n('input', '입력'); const merge = n('merge', '취합');
    const a = n('agent', 'A'); const cx = n('codexReview', 'CA'); const rv = n('review', 'RA'); const ck = n('check', 'KA');
    const b = n('agent', 'B'); const cb = n('codexReview', 'CB');
    const ur = n('userReview', '사용자 검토');
    const g = { nodes: [inp, a, cx, rv, ck, b, cb, merge, ur], edges: [
      e(inp, a), e(a, cx), e(cx, rv), e(rv, a, 'fail'), e(rv, ck), e(ck, a, 'fail'), e(ck, merge),
      e(inp, b), e(b, cb), e(cb, merge), e(merge, ur),
    ] };
    const lanes = [...laneBlocks(g, [inp.id]).values()].map((l) => ({ head: l.head, members: [...l.members].sort() }));
    expect(lanes).toHaveLength(2);
    expect(lanes).toContainEqual({ head: a.id, members: [a.id, cx.id, rv.id, ck.id].sort() });
    expect(lanes).toContainEqual({ head: b.id, members: [b.id, cb.id].sort() });
    // 다시 실행 시작점이 묶음 중간이면 그 묶음은 나누어 실행한다(입구가 둘이 됨)
    expect([...laneBlocks(g, [cx.id]).values()].some((l) => l.members.includes(cx.id))).toBe(false);
  });

  it('작성 단계가 이어진 흐름(A → B)은 한 묶음에 넣지 않는다: 수정 요청이 B만 골라 되돌릴 수 있어야 한다', () => {
    const inp = n('input', '입력'); const a = n('agent', 'A'); const b = n('agent', 'B'); const merge = n('merge', '취합'); const ur = n('userReview', '검토');
    const g = { nodes: [inp, a, b, merge, ur], edges: [e(inp, a), e(a, b), e(b, merge), e(merge, ur)] };
    for (const l of laneBlocks(g, [inp.id]).values()) expect(l.members.filter((m) => m === a.id || m === b.id).length).toBeLessThan(2);
  });

  it('빠른 작업의 Codex 리뷰는 느린 작업이 끝나기 전에 시작하고, 합류는 둘 다 끝난 뒤에 한다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    const w1 = svc.saveAgent(p.id, null, agentFields('01', '빠른 작성자'));
    const w2 = svc.saveAgent(p.id, null, agentFields('02', '느린 작성자'));
    const hold = join(dir, '..', `HOLD-lane-${Date.now()}`); writeFileSync(hold, '1');
    const inp = n('input', '입력');
    const a = n('agent', '빠른 A', { agentId: w1.id, writeScope: ['docs/a'], outputs: [{ path: 'docs/a/x.md', format: 'markdown', required: true }] });
    const ca = n('codexReview', 'Codex A', { inputs: ['docs/a/x.md'] });
    const b = n('agent', '느린 B', { agentId: w2.id, instructions: `[[mock:wait-while:${hold}]]`, writeScope: ['docs/b'], outputs: [{ path: 'docs/b/y.md', format: 'markdown', required: true }] });
    const cb = n('codexReview', 'Codex B', { inputs: ['docs/b/y.md'] });
    const merge = n('merge', '취합');
    const v = svc.store.saveGraph(p.id, { nodes: [inp, a, ca, b, cb, merge], edges: [e(inp, a), e(a, ca), e(ca, merge), e(inp, b), e(b, cb), e(cb, merge)] }, '작업 줄');
    const run = svc.engine.startRun(p.id, v.id);
    // 느린 B가 아직 붙잡혀 있는 동안 빠른 A의 Codex 리뷰가 끝난다
    const t0 = Date.now();
    while (svc.store.getRunNode(run.id, ca.id).status !== 'succeeded') {
      if (Date.now() - t0 > 30000) throw new Error('빠른 작업의 Codex 리뷰가 시작되지 않았습니다(느린 작업을 기다림)');
      await sleep(50);
    }
    expect(svc.store.getRunNode(run.id, b.id).status).toBe('running');
    expect(svc.store.getRunNode(run.id, merge.id).status).not.toBe('succeeded');
    rmSync(hold);
    const fin = await waitRun(svc, run.id, ['succeeded', 'failed']);
    expect(fin.status).toBe('succeeded');
    expect(svc.store.getRunNode(run.id, merge.id).status).toBe('succeeded');
    svc.close();
  });
});
