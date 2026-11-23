// 텔레그램 연동 시험 — 가짜 Bot API로 실제 앱 처리 로직(확인함·커밋 승인·지시·미션 제어)과 같은 상태를 쓰는지 확인한다.
// 실제 텔레그램 서버·토큰 없이 돈다(실제 봇 연결 검증은 사용자가 토큰을 넣은 뒤 따로 한다).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mission, MissionCommitRequest, MissionGap } from '../src/shared/types';
import { TelegramBridge } from '../src/main/telegram';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

const TOKEN = '123456789:AAFakeFakeFakeFakeFakeFakeFakeFake00';
const ME = { id: 1001, first_name: '나', username: 'me' };
const OTHER = { id: 2002, first_name: '남', username: 'stranger' };

class FakeTg {
  updates: Record<string, unknown>[] = []; sent: { method: string; body: Record<string, unknown> }[] = []; private uid = 1; private mid = 100;
  fail: { code: number; desc: string } | null = null;
  fetch = (async (url: string, init: { body: unknown }) => {
    const method = String(url).split('/').pop()!;
    if (!String(url).includes(`/bot${TOKEN}/`)) return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
    if (this.fail && method === 'getUpdates') return new Response(JSON.stringify({ ok: false, error_code: this.fail.code, description: this.fail.desc }));
    const body = init.body instanceof FormData ? Object.fromEntries(init.body as unknown as Iterable<[string, unknown]>) : JSON.parse(String(init.body ?? '{}'));
    let result: unknown = true;
    if (method === 'getMe') result = { id: 777, is_bot: true, first_name: 'Crew', username: 'crew_bot' };
    else if (method === 'getUpdates') {
      for (let i = 0; i < 20 && !this.updates.some((u) => (u.update_id as number) >= (body.offset ?? 0)); i++) await sleep(10);
      result = this.updates.filter((u) => (u.update_id as number) >= (body.offset ?? 0));
    } else { this.sent.push({ method, body }); if (method === 'sendMessage' || method === 'sendPhoto') result = { message_id: this.mid++ }; }
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  msg(from: typeof ME, text: string, extra: Record<string, unknown> = {}, chatType = 'private', date = Math.floor(Date.now() / 1000)) {
    this.updates.push({ update_id: this.uid++, message: { message_id: this.mid++, date, chat: { id: from.id, type: chatType }, from, text, ...extra } });
  }
  press(from: typeof ME, data: string, date = Math.floor(Date.now() / 1000)) {
    this.updates.push({ update_id: this.uid++, callback_query: { id: `cb${this.uid}`, from, data, message: { message_id: 1, date, chat: { id: from.id, type: 'private' } } } });
  }
  texts() { return this.sent.filter((x) => x.method === 'sendMessage').map((x) => String(x.body.text)); }
  last() { return this.texts().slice(-1)[0] ?? ''; }
  /** 보낸 메시지의 버튼에서 글자로 콜백 데이터를 찾는다 */
  button(label: RegExp): string {
    for (const s of [...this.sent].reverse()) {
      const kb = (s.body.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? [];
      for (const row of kb) for (const b of row) if (label.test(b.text) && b.callback_data) return b.callback_data;
    }
    throw new Error(`버튼 없음: ${label}`);
  }
}
const until = async <T,>(f: () => T | null | undefined | false, ms = 15000): Promise<T> => { const t0 = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('시간 초과'); await sleep(20); } };

async function setup() {
  const dir = tmpProject(); const g = gitInit(dir); const tg = new FakeTg();
  let br: TelegramBridge | null = null;
  const svc = mkService(dir, [], { emit: (e) => br?.onLive(e) });
  const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
  svc.loadAgentTemplates(p.id);
  let tok: string | null = null;
  const token = { get: () => tok, set: (v: string | null) => { tok = v; }, available: () => true };
  br = new TelegramBridge({ svc, token, fetchImpl: tg.fetch, pollTimeoutSec: 1 });
  const link = async () => {
    await br!.setToken(TOKEN); br!.setOptions({ enabled: true });
    await until(() => br!.status().state === 'connected');
    const code = br!.newLinkCode().settings.linkCode!.code;
    tg.msg(ME, `/start ${code}`);
    await until(() => br!.status().settings.candidate);
    await br!.confirmLink(true);
  };
  return { dir, g, tg, svc, p, br: br!, token, link, tokRef: () => tok };
}
const set = (svc: ReturnType<typeof mkService>, id: string, p: Partial<Mission>) => (svc.missions as unknown as { set(id: string, p: Partial<Mission>): Mission }).set(id, p);

describe('텔레그램 연동', () => {
  it('토큰은 보안 저장소에만 두고 화면·설정·오류에 남기지 않는다', async () => {
    const { svc, br, tokRef } = await setup();
    await expect(br.setToken('not-a-token')).rejects.toThrow('형식');
    const st = await br.setToken(TOKEN);
    expect(tokRef()).toBe(TOKEN);
    expect(JSON.stringify(st)).not.toContain(TOKEN.split(':')[1]);
    expect(JSON.stringify(svc.store.getSetting('telegram', {}))).not.toContain(TOKEN.split(':')[1]);
    expect(st.settings.bot?.username).toBe('crew_bot');
    // 보안 저장소를 못 쓰면 저장하지 않는다(평문으로 바꾸지 않음)
    const { TelegramBridge: B } = await import('../src/main/telegram');
    const b2 = new B({ svc, token: { get: () => null, set: () => { throw new Error('x'); }, available: () => false }, fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
    await expect(b2.setToken(TOKEN)).rejects.toThrow('보안 저장소');
    br.close(); svc.close();
  });

  it('등록: 일회용 코드 + 앱 확인. 처음 보낸 사람·코드 없는 사람·그룹은 등록·조작하지 못하고, 버튼도 막힌다', async () => {
    const { tg, svc, br } = await setup();
    await br.setToken(TOKEN); br.setOptions({ enabled: true });
    await until(() => br.status().state === 'connected');
    tg.msg(OTHER, '/status'); // 코드 없이 먼저 보낸 사람
    await until(() => tg.texts().some((t) => t.includes('등록된 계정만')));
    expect(br.status().settings.link).toBeNull(); expect(br.status().settings.candidate).toBeNull();
    const code = br.newLinkCode().settings.linkCode!.code;
    tg.msg(OTHER, '/start WRONG123');
    tg.msg(ME, `/start ${code}`, {}, 'group'); // 그룹에서는 무시
    tg.msg(ME, `/start ${code}`);
    const c = await until(() => br.status().settings.candidate);
    expect(c.userId).toBe(ME.id);
    expect(br.status().settings.link).toBeNull(); // 앱에서 확인하기 전에는 등록 안 됨
    await br.confirmLink(true);
    expect(br.status().settings.link?.userId).toBe(ME.id);
    const n = tg.texts().length;
    tg.msg(OTHER, '/status');
    await until(() => tg.texts().length > n);
    expect(tg.last()).toContain('등록된 계정만');
    // 내 메뉴 버튼을 다른 사람이 눌러도 막힌다
    tg.msg(ME, '/menu');
    await until(() => tg.texts().some((t) => t.includes('CREWGENAI 메뉴')));
    const data = tg.button(/진행 상황/);
    tg.press(OTHER, data);
    await until(() => tg.sent.some((x) => x.method === 'answerCallbackQuery' && String(x.body.text).includes('등록된 계정만')));
    // 연결을 해제하면 이전 버튼은 쓸 수 없다(다시 연결해도)
    br.unlink();
    const code2 = br.newLinkCode().settings.linkCode!.code; tg.msg(ME, `/start ${code2}`); await until(() => br.status().settings.candidate); await br.confirmLink(true);
    tg.press(ME, data);
    await until(() => tg.sent.some((x) => x.method === 'answerCallbackQuery' && String(x.body.text).includes('지난 연결')));
    br.close(); svc.close();
  });

  it('조회는 저장된 상태로(대상 프로젝트·미션 표시), 지시는 실제 미션에 반영되고 계획에 들어가면 알린다', async () => {
    const { tg, svc, p, br, link } = await setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 화면을 만들어라');
    await until(() => svc.missions.get(m0.id).status === 'running');
    await link();
    for (const c of ['/status', '/tasks', '/results', '/usage', '/health']) {
      const n = tg.texts().length; tg.msg(ME, c); await until(() => tg.texts().length > n);
      expect(tg.texts().slice(n).join('\n')).toContain(p.plan.name);
    }
    tg.msg(ME, '/next 목록 위에 검색창을 두세요');
    await until(() => svc.missions.events(m0.id).some((e) => e.kind === 'directive' && e.text.includes('검색창')));
    await until(() => tg.last().includes('접수했습니다'));
    // 일반 문장도 대상이 명확하면 바로 접수
    tg.msg(ME, '버튼 문구를 짧게');
    await until(() => svc.missions.events(m0.id).some((e) => e.kind === 'directive' && e.text.includes('버튼 문구')));
    // /now는 진행 중 작업을 끊지 않는 우선 지시로 접수(실행 취소 없음)
    const run = svc.missions.get(m0.id).currentRunId!;
    tg.msg(ME, '/now 저장 버튼을 오른쪽 위로');
    await until(() => svc.missions.events(m0.id).some((e) => e.text.includes('[우선 지시') && e.text.includes('저장 버튼')));
    expect(svc.engine.isActive(run)).toBe(true);
    // 계획에 반영되면 알림
    br.onLive({ type: 'missionEvent', event: { missionId: m0.id, seq: 9999, at: '', kind: 'operator_plan', cycle: 2, text: '사이클 2 계획: …', data: '' } });
    await until(() => tg.texts().some((t) => t.includes('계획에 반영됐습니다')));
    await svc.missions.stop(m0.id);
    br.close(); svc.close();
  });

  it('확인함: 추천을 골라도 적용 전에는 반영되지 않고, 적용하면 앱과 같은 처리로 한 번만 반영된다. 오래된 버튼·바뀐 질문은 실행하지 않는다', async () => {
    const { tg, svc, p, br, link } = await setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 화면을 만들어라');
    await until(() => svc.missions.get(m0.id).status === 'running');
    const gap: MissionGap = { doc: '화면.md', issue: '삭제 기능을 넣을까요?', need: '', kind: 'decide', options: ['넣는다', '미룬다'], choices: [{ label: '넣는다', effect: '삭제 버튼', recommended: false, why: '' }, { label: '미룬다', effect: '숨김', recommended: true, why: '정책 없음' }] };
    set(svc, m0.id, { gaps: [gap] });
    await link();
    tg.msg(ME, '/pending');
    await until(() => tg.texts().some((t) => t.includes('삭제 기능을 넣을까요?')));
    tg.press(ME, tg.button(/추천안 모두 선택/));
    await until(() => tg.texts().some((t) => t.includes('선택한 내용(아직 적용 안 됨)')));
    expect(svc.missions.get(m0.id).decisions ?? []).toEqual([]); // 적용 전에는 반영 안 됨
    const apply = tg.button(/선택한 내용 적용/);
    tg.press(ME, apply);
    await until(() => (svc.missions.get(m0.id).decisions ?? []).some((d) => d.choice.startsWith('미룬다')));
    tg.press(ME, apply); // 같은 버튼 다시(중복 클릭·재시도)
    await until(() => tg.sent.some((x) => x.method === 'answerCallbackQuery' && String(x.body.text).includes('이미 처리')));
    expect((svc.missions.get(m0.id).decisions ?? []).length).toBe(1);
    // 질문 내용이 바뀐 뒤의 오래된 선택은 적용하지 않는다(앱 화면도 같은 판정)
    set(svc, m0.id, { gaps: [{ ...gap, issue: '수정 기능을 넣을까요?' }] });
    const r = svc.applyDecisions([{ key: `${m0.id}|g|화면.md|삭제 기능을 넣을까요?`, choice: '넣는다' }]);
    expect(r).toMatchObject({ applied: 0, stale: 1 });
    await svc.missions.stop(m0.id);
    br.close(); svc.close();
  });

  it('커밋 승인: 보여 준 변경 묶음만 한 번 커밋하고(push 없음), 그 뒤 바뀌면 커밋하지 않고 새로 보여 준다', async () => {
    const { tg, svc, p, br, link, dir, g } = await setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    await until(() => svc.missions.get(m0.id).status === 'running');
    writeFileSync(join(dir, 'a.txt'), 'a\n'); writeFileSync(join(dir, 'b.txt'), 'b\n'); writeFileSync(join(dir, 'user.txt'), '사용자 변경\n');
    const req = (id: string, f: string): MissionCommitRequest => ({ id, cycle: 1, repo: '', files: [f], message: `커밋 ${f}`, why: '기능 저장', task: '', status: 'pending', at: '' });
    set(svc, m0.id, { commitRequests: [req('r1', 'a.txt'), req('r2', 'b.txt')] });
    await link();
    tg.msg(ME, '/commits');
    await until(() => tg.texts().filter((t) => t.includes('커밋 승인 요청')).length >= 2);
    expect(tg.texts().join('\n')).toContain('push·main 병합·배포는 하지 않습니다');
    // r1: 승인 → 커밋 1번, 같은 버튼 다시 눌러도 다시 커밋하지 않음
    const approves = tg.sent.filter((x) => String(x.body.text ?? '').includes('커밋 a.txt')).map((x) => (x.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat().find((b) => b.text.includes('커밋 승인'))!.callback_data);
    tg.press(ME, approves[0]);
    await until(() => svc.missions.get(m0.id).commitRequests!.find((r) => r.id === 'r1')!.status === 'approved');
    tg.press(ME, approves[0]);
    await until(() => tg.sent.some((x) => x.method === 'answerCallbackQuery' && String(x.body.text).includes('이미 처리')));
    expect(g('log', '--format=%s').split('\n').filter((l) => l === '커밋 a.txt').length).toBe(1);
    expect(g('show', '--name-only', '--format=', 'HEAD').trim()).toBe('a.txt'); // 다른 사용자 변경은 넣지 않음
    // r2: 보여 준 뒤 파일이 바뀌면 커밋하지 않고 새 요약을 다시 보냄
    writeFileSync(join(dir, 'b.txt'), 'b 바뀜\n');
    const approveB = tg.sent.filter((x) => String(x.body.text ?? '').includes('커밋 b.txt')).map((x) => (x.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat().find((b) => b.text.includes('커밋 승인'))!.callback_data)[0];
    tg.press(ME, approveB);
    await until(() => tg.texts().some((t) => t.includes('변경 내용이 바뀌어 커밋하지 않았습니다')));
    expect(svc.missions.get(m0.id).commitRequests!.find((r) => r.id === 'r2')!.status).toBe('pending');
    expect(g('log', '--format=%s').includes('커밋 b.txt')).toBe(false);
    await svc.missions.stop(m0.id);
    br.close(); svc.close();
  }, 90000);

  it('미션 제어: 일시정지·재개는 대상 미션에, 중단은 확인 후. 오래된 상태 변경 명령은 실행하지 않는다', async () => {
    const { tg, svc, p, br, link } = await setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    await until(() => svc.missions.get(m0.id).status === 'running');
    await link();
    tg.msg(ME, '/pause'); await until(() => svc.missions.get(m0.id).paused === true);
    tg.msg(ME, '/resume'); await until(() => svc.missions.get(m0.id).paused === false);
    tg.msg(ME, '/stop', {}, 'private', Math.floor(Date.now() / 1000) - 3600); // 한 시간 전에 보낸 명령
    await until(() => tg.texts().some((t) => t.includes('오래돼')));
    expect(svc.missions.get(m0.id).status).toBe('running');
    tg.msg(ME, '/stop');
    await until(() => tg.texts().some((t) => t.includes('정말 중단할까요')));
    expect(svc.missions.get(m0.id).status).toBe('running'); // 확인 전에는 중단하지 않음
    tg.press(ME, tg.button(/^중단$/));
    await until(() => svc.missions.get(m0.id).status === 'stopped');
    br.close(); svc.close();
  });

  it('연결이 끊긴 동안의 알림은 로컬에 쌓았다가(같은 것은 한 번만) 다시 연결되면 보내고, 그사이 처리된 질문은 보내지 않는다. 받은 업데이트는 재시작 후에도 다시 처리하지 않는다', async () => {
    const { tg, svc, p, br, link, token } = await setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    await until(() => svc.missions.get(m0.id).status === 'running');
    await link();
    tg.fail = { code: 502, desc: 'Bad Gateway' }; // 연결 끊김
    await until(() => br.status().state === 'error');
    const gap: MissionGap = { doc: 'd', issue: '색을 정할까요?', need: '', kind: 'decide', blocking: true, options: ['파랑', '빨강'] };
    set(svc, m0.id, { status: 'waiting_user', gaps: [gap], question: '결정 필요' });
    const ev = { missionId: m0.id, seq: 500, at: '', kind: 'question' as const, cycle: 1, text: '결정 필요', data: '' };
    br.onLive({ type: 'missionEvent', event: ev }); br.onLive({ type: 'missionEvent', event: ev }); // 같은 알림 두 번
    expect(br.status().pendingOut).toBe(1);
    tg.fail = null;
    await until(() => tg.texts().some((t) => t.includes('색을 정할까요?')), 20000);
    expect(tg.texts().filter((t) => t.includes('색을 정할까요?')).length).toBe(1);
    // 재시작: 같은 업데이트가 다시 와도 처리하지 않는다
    const n = svc.missions.events(m0.id).filter((e) => e.kind === 'directive').length;
    set(svc, m0.id, { status: 'running', gaps: null, question: null });
    tg.msg(ME, '/next 한 번만');
    await until(() => svc.missions.events(m0.id).filter((e) => e.kind === 'directive').length === n + 1);
    br.close();
    const { TelegramBridge: B } = await import('../src/main/telegram');
    const replay = tg.updates.slice(-1)[0];
    tg.updates.push({ ...replay }); // 같은 update_id가 다시 옴(통신 재시도)
    const b2 = new B({ svc, token, fetchImpl: tg.fetch, pollTimeoutSec: 1 }); b2.start();
    await sleep(800);
    expect(svc.missions.events(m0.id).filter((e) => e.kind === 'directive').length).toBe(n + 1);
    b2.close(); await svc.missions.stop(m0.id); svc.close();
  }, 90000);

  it('Claude 한도 대기 중에도 조회와 지시 접수가 되고, 한도 정보를 추측하지 않는다', async () => {
    const { tg, svc, p, br, link } = await setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    await until(() => svc.missions.get(m0.id).status === 'running');
    set(svc, m0.id, { limitUntil: new Date(Date.now() + 3600_000).toISOString(), limitWait: { source: 'run', reason: '사용 한도 도달', resetKnown: false, nextAt: new Date(Date.now() + 3600_000).toISOString(), tries: 0, lastAt: null, lastResult: null, target: '사이클 1 · 문서 작성' } });
    await link();
    tg.msg(ME, '/usage');
    await until(() => tg.texts().some((t) => t.includes('해제 시각: 알 수 없음')));
    tg.msg(ME, '/next 한도 풀리면 표부터');
    await until(() => svc.missions.events(m0.id).some((e) => e.text.includes('한도 풀리면 표부터')));
    await svc.missions.stop(m0.id);
    br.close(); svc.close();
  });

  it('Codex 지적 반영: 연결 코드는 한 번만, 확인은 보여 준 후보에만. 꺼져 있던 동안 누른 버튼은 실행하지 않음. 검토 카드 결정 여러 개는 함께. 다시 시작해도 수신 루프는 하나', async () => {
    const { tg, svc, p, br } = await setup();
    await br.setToken(TOKEN); br.setOptions({ enabled: true });
    await until(() => br.status().state === 'connected');
    const code = br.newLinkCode().settings.linkCode!.code;
    tg.msg(ME, `/start ${code}`);
    await until(() => br.status().settings.candidate?.userId === ME.id);
    tg.msg(OTHER, `/start ${code}`); // 같은 코드로 바꿔치기 시도
    await until(() => tg.texts().filter((t) => t.includes('등록된 계정만')).length >= 1);
    expect(br.status().settings.candidate?.userId).toBe(ME.id);
    await expect(br.confirmLink(true, OTHER.id)).rejects.toThrow('바뀌었습니다');
    await br.confirmLink(true, ME.id);
    // 검토 카드 결정 두 개를 함께 적용
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    await until(() => svc.missions.get(m0.id).status === 'running');
    const { buildCheckpoint } = await import('../src/main/mission');
    const cp = buildCheckpoint({ title: '카드', decisions: [{ question: 'Q1?', choices: [{ label: 'A1', effect: '', recommended: false, why: '' }] }, { question: 'Q2?', choices: [{ label: 'A2', effect: '', recommended: false, why: '' }] }] }, 1, [], [], [], 'ready', 'x');
    set(svc, m0.id, { checkpoint: cp });
    const pick = (q: string, a: string) => (br as unknown as { cbToken(p: object): string }).cbToken({ a: 'pick', k: `cpd|${m0.id}|${cp.at}|${q}`, v: a, ver: '', kind: 'cp' });
    tg.press(ME, pick('0', 'A1')); tg.press(ME, pick('1', 'A2'));
    await until(() => tg.texts().some((t) => t.includes('[검토 카드] Q2?')));
    tg.press(ME, tg.button(/선택한 내용 적용/));
    await until(() => (svc.missions.get(m0.id).decisions ?? []).length === 2);
    // 오래 끊겼던 동안 쌓인 버튼: 실행하지 않음
    br.close();
    svc.store.db.prepare("UPDATE tg_kv SET value=? WHERE key='lastOk'").run(String(Date.now() - 3600_000));
    const { TelegramBridge: B } = await import('../src/main/telegram');
    let tok: string | null = TOKEN; const b2 = new B({ svc, token: { get: () => tok, set: (v) => { tok = v; }, available: () => true }, fetchImpl: tg.fetch, pollTimeoutSec: 1 });
    const stopTok = (b2 as unknown as { cbToken(p: object): string }).cbToken({ a: 'mc', m: m0.id, x: 'pause' });
    tg.press(ME, stopTok);
    b2.start();
    await until(() => tg.texts().some((t) => t.includes('꺼져 있거나 연결이 끊긴 동안 누른 버튼')));
    expect(svc.missions.get(m0.id).paused ?? false).toBe(false);
    // 다시 시작해도 수신 루프는 하나(같은 봇을 두 번 받지 않음)
    b2.restart(); b2.restart();
    let inflight = 0; let maxIn = 0; const orig = tg.fetch;
    tg.fetch = (async (u: string, i: { body: unknown }) => { if (String(u).endsWith('/getUpdates')) { inflight++; maxIn = Math.max(maxIn, inflight); try { return await orig(u, i as never); } finally { inflight--; } } return orig(u, i as never); }) as unknown as typeof fetch;
    (b2 as unknown as { d: { fetchImpl: typeof fetch } }).d.fetchImpl = tg.fetch;
    b2.restart();
    await sleep(1500);
    expect(maxIn).toBeLessThanOrEqual(1);
    b2.close(); await svc.missions.stop(m0.id); svc.close();
  }, 90000);

  it('확인함의 결과 검토 카드는 결정과 고르는 버튼을 함께 보내고, 추천안 모두 선택에 검토 카드 결정도 들어간다(적용 전에는 반영 안 됨)', async () => {
    const { tg, svc, p, br } = await setup();
    await br.setToken(TOKEN); br.setOptions({ enabled: true });
    await until(() => br.status().state === 'connected');
    const code = br.newLinkCode().settings.linkCode!.code;
    tg.msg(ME, `/start ${code}`);
    await until(() => br.status().settings.candidate?.userId === ME.id);
    await br.confirmLink(true, ME.id);
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    await until(() => svc.missions.get(m0.id).status === 'running');
    const { buildCheckpoint } = await import('../src/main/mission');
    const cp = buildCheckpoint({ title: '카드', decisions: [{ question: '시연 서버 접속을 허용할까요?', choices: [{ label: '허용', effect: '', recommended: true, why: '' }, { label: '안 함', effect: '', recommended: false, why: '' }] }, { question: '오류 문구는 가짜 응답으로 닫을까요?', choices: [{ label: '닫기', effect: '', recommended: true, why: '' }] }] }, 1, [], [], [], 'ready', 'x');
    set(svc, m0.id, { checkpoint: { ...cp, blocking: true } });
    tg.msg(ME, '/pending');
    await until(() => tg.texts().some((t) => t.includes('시연 서버 접속을 허용할까요?')));
    expect(() => tg.button(/결정1: ⭐ 허용/)).not.toThrow(); // 카드 안에서 바로 고를 수 있다
    tg.press(ME, tg.button(/추천안 모두 선택/));
    await until(() => tg.texts().some((t) => t.includes('[검토 카드] 오류 문구는')));
    expect(svc.missions.get(m0.id).decisions ?? []).toHaveLength(0); // 고르기만 해서는 반영되지 않는다
    tg.press(ME, tg.button(/선택한 내용 적용/));
    await until(() => (svc.missions.get(m0.id).decisions ?? []).length === 2);
    br.close(); await svc.missions.stop(m0.id); svc.close();
  }, 90000);

  it('변경 상세: 비밀값 파일만 든 요청이면 저장소 전체 차이를 보내지 않고, 보내는 차이에서도 비밀값 줄은 뺀다', async () => {
    const { svc, p, dir } = await setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    await until(() => svc.missions.get(m0.id).status === 'running');
    writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://u:pw1234567@h/db\n'); writeFileSync(join(dir, 'other.txt'), '다른 변경\n'); writeFileSync(join(dir, 'ok.txt'), '보통 줄\nurl=postgres://u:pw1234567@h/db\n');
    set(svc, m0.id, { commitRequests: [{ id: 'e1', cycle: 1, repo: '', files: ['.env'], message: 'env', why: '', task: '', status: 'pending', at: '' }, { id: 'o1', cycle: 1, repo: '', files: ['ok.txt'], message: 'ok', why: '', task: '', status: 'pending', at: '' }] });
    const d1 = await svc.commitDiff(m0.id, 'e1');
    expect(d1).toContain('보낼 수 있는 파일이 없습니다'); expect(d1).not.toContain('다른 변경'); expect(d1).not.toContain('pw1234567');
    const d2 = await svc.commitDiff(m0.id, 'o1');
    expect(d2).not.toContain('pw1234567');
    await svc.missions.stop(m0.id); svc.close();
  }, 90000);
});
