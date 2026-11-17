// 운영 흐름: 결과 상태(실제 확인 없이 '검증됨'으로 올리지 않음), 검토 지점(결정 최대 3, 미결 결정·가정 합침)
import { describe, expect, it } from 'vitest';
import { buildCheckpoint, resultStatus } from '../src/main/mission';

describe('결과 상태와 검토 지점', () => {
  it('실제로 확인하지 않은 결과는 검증됨·검토 가능으로 올리지 않는다', () => {
    expect(resultStatus({ status: 'verified', verified: '미검증 — 서버를 띄우지 못함' })).toBe('implemented');
    expect(resultStatus({ status: 'reviewable', verified: '' })).toBe('implemented');
    expect(resultStatus({ status: 'reviewable', verified: '목록·저장을 시연 환경에서 실행, 200 확인' })).toBe('reviewable');
    expect(resultStatus({ status: 'ran', verified: '' })).toBe('ran');
    expect(resultStatus({ status: '아무거나' })).toBe('implemented');
  });

  it('검토 지점의 결정은 오퍼레이터 결정과 미결 결정을 합쳐 최대 3개, 가정은 묻지 않고 목록으로', () => {
    const cp = buildCheckpoint(
      { title: '전체 흐름', decisions: [{ question: 'A?', choices: [{ label: '예', effect: '', recommended: true, why: '' }] }, { question: 'B?' }], assumptions: ['버튼은 위'] },
      3, [], [{ doc: 'd', issue: 'C?', need: '', kind: 'decide', options: ['x', 'y'] }, { doc: 'd', issue: 'D?', need: '', kind: 'decide' }, { doc: 'd', issue: '가정', need: '', kind: 'assume' }],
      ['메모 500자'], 'ready', 'x');
    expect(cp.decisions.map((d) => d.question)).toEqual(['A?', 'B?', 'C?']);
    expect(cp.decisions.map((d) => d.doc)).toEqual(['검토 지점', '검토 지점', 'd']);
    expect(cp.assumptions).toEqual(['버튼은 위', '메모 500자']);
    expect(cp.title).toBe('전체 흐름');
    // 검토 지점에 실제 확인 기록이 없으면 기능 상태를 올리지 않는다
    const cp2 = buildCheckpoint({ features: [{ name: 'f', changed: '', status: 'reviewable' }] }, 1, [], [], [], 'ready', 'x');
    expect(cp2.features[0].status).toBe('implemented');
  });
});
