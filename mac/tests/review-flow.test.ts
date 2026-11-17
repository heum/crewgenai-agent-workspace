// 운영 흐름: 결과 상태(실제 확인 없이 '검증됨'으로 올리지 않음), 검토 지점(결정 최대 3, 미결 결정·가정 합침)
import { describe, expect, it } from 'vitest';
import { buildCheckpoint, resultStatus, sameSubject, summaryTitle } from '../src/main/mission';
import { staleCopyServer } from '../src/main/demo';
import { tmpdir } from 'node:os';

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

  it('같은 대상을 다른 말로 묻는 결정은 하나로 본다(따옴표 인용 문구가 같음)', () => {
    const a = "화면 하단 안내 '변경사항은 현재 검토 세션에만 유지됩니다'(layout.tsx:25)는 HTML 원문인데 어떻게 할까요?";
    const b = "[layout.tsx] 하단 안내 '변경사항은 현재 검토 세션에만 유지됩니다'는 운영 HTML 원문입니다. 그런데 실제 DB에 남습니다.";
    expect(sameSubject(a, b)).toBe(true);
    expect(sameSubject(a, "회원 관리 기본값을 '전체 회사'로 바꿀까요?")).toBe(false);
    const cp = buildCheckpoint({ decisions: [{ question: a }] }, 1, [], [{ doc: 'layout.tsx', issue: b, need: '', kind: 'decide' }], [], 'ready', 'x');
    expect(cp.decisions.length).toBe(1);
  });

  it('자동 진행 한도 검토 지점: 제목은 이번에 한 일, 확인 범위는 앱이 직접 확인한 시연 결과로 채운다', () => {
    expect(summaryTitle('**한 줄 요약:** 회원 수정 리뷰 지적 2건을 고쳤습니다.\n자세히…')).toBe('회원 수정 리뷰 지적 2건을 고쳤습니다.');
    const demo = ['- 회원 서버(a): 실행 중 · 상태 확인 /health 응답 정상', '- 운영 웹(w): 실행 승인 필요 — 사용자가 시연 열기에서 처음 한 번 승인해야 앱이 켤 수 있음(켜지 않음)',
      '- API l1 POST /login: 502 (기대: 200 토큰)', '- API c2 GET /companies/b: 403 (기대: 403 다른 회사)', '- API g GET /agents: 200'];
    const cp = buildCheckpoint(undefined, 5, [], [], [], 'budget', summaryTitle('한 줄 요약: 중계 오류를 나눴습니다'), demo);
    expect(cp.title).toBe('중계 오류를 나눴습니다');
    expect(cp.verified).toContain('회원 서버'); expect(cp.verified).toContain('/companies/b'); expect(cp.verified).toContain('/agents');
    expect(cp.verified).not.toContain('/login'); expect(cp.verified).not.toContain('운영 웹');
    expect(cp.unverified).toContain('/login: 502'); expect(cp.unverified).toContain('운영 웹');
    // 오퍼레이터가 적은 확인 범위가 있으면 그대로 쓴다
    expect(buildCheckpoint({ verified: '직접 확인함' }, 5, [], [], [], 'ready', 'x', demo).verified).toBe('직접 확인함');
  });

  it('임시 폴더에서 실행 중인 서버는 실제 저장소 코드가 아닌 것으로 본다', () => {
    expect(staleCopyServer(`${tmpdir()}/crewgenai-iso/abc/app`)).toBe(true);
    expect(staleCopyServer('/private/tmp/claude-501/c53-pwf')).toBe(true);
    expect(staleCopyServer('/Users/someone/projects/app')).toBe(false);
    expect(staleCopyServer('')).toBe(false);
  });
});
