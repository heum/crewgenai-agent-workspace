// 참고 사이트 스냅샷 시험 — 공개 주소만, 앱이 저장한 스냅샷을 직원이 읽기 전용으로 받는다
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicWebUrl, refDirFor } from '../src/main/refs';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

describe('참고 사이트', () => {
  it('공개 http(s) 주소만 허용하고 이 컴퓨터·사설망·계정이 든 주소는 막는다', () => {
    for (const u of ['https://www.biddata.kr/', 'http://example.com/a?b=1']) expect(publicWebUrl(u)).toBe(true);
    for (const u of ['http://localhost:3000', 'http://127.0.0.1/', 'http://10.0.0.5', 'http://192.168.0.1', 'http://172.20.1.1', 'http://169.254.169.254/latest', 'file:///etc/passwd', 'https://user:pw@example.com', 'http://intranet', 'http://[::1]/', 'http://printer.local']) expect(publicWebUrl(u), u).toBe(false);
    expect(refDirFor('/r', 'abcdef1234', 'https://www.biddata.kr/x')).toMatch(/^\/r\/abcdef12\/www\.biddata\.kr-[0-9a-f]{8}$/);
  });

  it('오퍼레이터가 요청한 공개 주소만 앱이 저장하고, 저장본을 작업 직원에게 읽기 전용으로 연다', async () => {
    const dir = tmpProject(); gitInit(dir);
    const asked: string[] = [];
    const svc = mkService(dir, [], { captureRef: async (url: string, out: string) => {
      asked.push(url); mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'page.md'), '# 예시'); writeFileSync(join(out, 'page.png'), 'x'); return { title: '예시 게시판', finalUrl: url };
    } });
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] })); svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:ref]] 예시 사이트를 참고해 문서를 정리하라');
    const t0 = Date.now(); let m = svc.missions.get(m0.id);
    while (!(m.currentRunId && (m.refSnapshots?.length ?? 0) >= 2) && Date.now() - t0 < 60000) { await sleep(100); m = svc.missions.get(m0.id); }
    expect(asked).toEqual(['https://example.com/board']); // 사설망 주소는 저장하지 않음(아래에서 실패로 기록)
    const ok = m.refSnapshots!.find((r) => r.url === 'https://example.com/board')!;
    expect(ok.title).toBe('예시 게시판');
    expect(m.refSnapshots!.find((r) => r.url.includes('192.168'))!.error).toContain('공개 웹 주소가 아님');
    const node = svc.engine.detail(m.currentRunId!).graph.nodes.find((n) => n.kind === 'agent')!;
    expect(node.inputs).toContain(ok.dir);
    expect(node.instructions).toContain('page.png');
    await svc.missions.stop(m0.id); svc.close();
  });
});
