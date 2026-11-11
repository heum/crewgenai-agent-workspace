#!/usr/bin/env python3
"""사용법·검증 문서용 화면 캡처 단계 생성기.
(13~15번 화면 — 템플릿·추가 지시·스냅샷 — 은 git 저장소 예시 프로젝트에서 같은 스모크 모드로 캡처했다)
사용: python3 scripts/docs/make-capture-steps.py <예시 프로젝트 폴더> <출력 폴더>
출력: <출력>/l1.json(빈 화면·준비), l2.json(탭별 캡처), real.json(실제 미션 화면 — 앱 데이터 사본으로 실행)
각 JSON은 앱의 검증용 스모크 모드(CREWGENAI_SMOKE_SCRIPT + --crewgenai-smoke)로 실행한다. 사용법 캡처는 모의 실행 데이터다.
"""
import json, sys

H = r"""const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const btn = (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes(t));
const click = (t) => { const b = btn(t); if (!b) throw new Error('버튼 없음: ' + t); b.click(); return true; };
const tab = (t) => { const b = [...document.querySelectorAll('[role=tab]')].find(x => x.textContent.includes(t)); if (!b) throw new Error('탭 없음: ' + t); b.click(); };
const setVal = (el, v) => { const proto = Object.getPrototypeOf(el); Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
const byPh = (p) => [...document.querySelectorAll('input,textarea')].find(x => (x.placeholder || '').includes(p));
const proj = async (name) => (await window.workspace.listProjects()).find(p => p.plan.name === name);
const waitMission = async (id, sts) => { for (let i = 0; i < 400; i++) { const m = (await window.workspace.missionDetail(id)).mission; if (sts.includes(m.status)) return m; await sleep(150); } return null; };
const waitRun = async (id, sts) => { for (let i = 0; i < 400; i++) { const r = (await window.workspace.runDetail(id)).run; if (sts.includes(r.status)) return r; await sleep(150); } return null; };
const pickMission = async (text) => { const el = [...document.querySelectorAll('.mission-list *')].find(x => x.children.length === 0 && x.textContent.includes(text)); if (!el) throw new Error('미션 없음: ' + text); el.closest('button,[role=button],div').click(); await sleep(700); };
const clickNode = async (text) => { const n = [...document.querySelectorAll('.react-flow__node')].find(x => x.textContent.includes(text)); if (!n) throw new Error('노드 없음: ' + text); n.click(); await sleep(600); };
"""
S = lambda name, js, w=900: {"name": name, "js": H + js, "waitMs": w}
folder, out = sys.argv[1], sys.argv[2]
NAME = '예시 프로젝트'

l1 = [
    S("g01-empty", "await sleep(1200); return document.title;", 1500),
    S("g02-new-project", f"""click('새 프로젝트'); await sleep(500);
      setVal(byPh('예: 조달크루'), '{NAME}');
      const goal = byPh('이번 프로젝트로'); if (goal) setVal(goal, '공고 목록 화면에 마감일 정렬을 추가하고, 정렬 기준을 문서로 남긴다.');
      return true;""", 900),
    S("setup", f"""
      await window.workspace.saveSettings({{ executor: 'mock', maxConcurrent: 3, missionMaxCycles: 5 }});
      const p = await window.workspace.createProject({{ name: '{NAME}', goal: '공고 목록 화면에 마감일 정렬을 추가하고, 정렬 기준을 문서로 남긴다.', folder: '{folder}', referenceDocs: [], priorOutputs: [], deliverable: '정렬 기능과 기준 문서', doneCriteria: '검사 통과, 문서에 기준 명시', writablePaths: ['docs'], scope: 'docs 폴더만', outputDir: 'crewgenai-output' }});
      await window.workspace.loadAgentTemplates(p.id);
      const g = await window.workspace.defaultGraph(p.id);
      const v = (await window.workspace.saveGraph(p.id, g, '기본 흐름')).version;
      const r = await window.workspace.startRun(p.id, v.id);
      await waitRun(r.id, ['review_wait', 'failed']);
      const m1 = await window.workspace.startMission(p.id, '[[mock:todo-first]] 마감일 정렬 기준을 문서로 정리하라');
      await waitMission(m1.id, ['done', 'waiting_user', 'failed']);
      const m2 = await window.workspace.startMission(p.id, '[[mock:ask]] 사용자 안내 문구를 정리하라');
      await waitMission(m2.id, ['waiting_user', 'done']);
      return {{ project: p.id, run: r.id }};""", 300),
]

l2 = [
    S("g03-plan", f"await sleep(700); click('{NAME}'); await sleep(500); tab('기획'); return true;", 900),
    S("g04-agents", "tab('직원'); return true;", 900),
    S("g05-flow", "tab('업무 흐름'); await sleep(900); return document.querySelectorAll('.react-flow__node').length;", 1400),
    S("g06-mission-input", "tab('운영'); await sleep(600); const ta = document.querySelector('.mission-left textarea'); setVal(ta, '[[mock:hang]] 공고 목록에 마감일 정렬을 추가하고 기준을 문서로 남겨라'); return true;", 900),
    S("g07-mission-running", "click('지시하기'); for (let i=0;i<80;i++){ await sleep(100); const t = document.querySelector('.mission-head')?.innerText || ''; if (t.includes('수행 중')) break; } await sleep(1500); return document.querySelector('.mission-head')?.innerText.slice(0,80);", 1500),
    S("g08-mission-question", "const p = await proj('예시 프로젝트'); const ms = await window.workspace.listMissions(p.id); const run = ms.find(m => m.status === 'running' || m.status === 'planning'); if (run) await window.workspace.stopMission(run.id); await sleep(600); await pickMission('사용자 안내 문구'); return true;", 1200),
    S("g09-mission-done", "await pickMission('마감일 정렬 기준'); return true;", 1200),
    S("g10-run-detail", "click('실행 화면에서 자세히'); await sleep(1200); await clickNode('Claude 재검토'); return true;", 1500),
    S("g11-review", "tab('결과물'); await sleep(900); const sel = document.querySelector('select'); if (sel) { const o = [...sel.options].find(x => x.textContent.includes('검토 대기')); if (o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } } await sleep(900); return true;", 1200),
    S("g13-help-guide", "click('사용법'); await sleep(1500); const imgs = [...document.querySelectorAll('.md-figure img')]; return { figures: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length };", 1200),
    S("g14-help-verification", "const t = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '검증 결과'); if (t) t.click(); await sleep(1500); const imgs = [...document.querySelectorAll('.md-figure img')]; const fig = document.querySelector('.md-figure'); fig?.scrollIntoView({ block: 'start' }); return { figures: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length };", 1200),
    S("g15-close-help", "const c = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '닫기'); c?.click(); await sleep(400); return true;", 400),
    S("g12-settings", "click('설정'); await sleep(800); const d = document.querySelector('[role=dialog], .modal'); if (d) { const c = [...d.querySelectorAll('*')].find(x => x.children.length === 0 && x.textContent.includes('Codex')); c?.scrollIntoView({ block: 'center' }); } return true;", 1200),
]

real = [
    S("v01-real-mission", "await sleep(900); click('조달크루 문서 시범'); await sleep(600); tab('운영'); await sleep(900); return document.querySelector('.mission-head')?.innerText.slice(0, 80) ?? '';", 1500),
    S("v02-real-timeline", "const el = document.querySelector('.timeline'); if (el) el.scrollTop = 0; const box = document.querySelector('.mission-main'); if (box) box.scrollTop = box.scrollHeight; return true;", 1200),
    S("v03-real-codex-node", "box = document.querySelector('.mission-main'); if (box) box.scrollTop = 0; click('실행 화면에서 자세히'); await sleep(1500); await clickNode('Codex 리뷰'); return true;".replace("box =", "const box ="), 1500),
    S("v04-real-claude-review", "await clickNode('Claude 재검토: 원문 간'); return true;", 1500),
]

for n, v in [('l1', l1), ('l2', l2), ('real', real)]:
    json.dump(v, open(f"{out}/{n}.json", 'w'), ensure_ascii=False, indent=1)
print('ok')
