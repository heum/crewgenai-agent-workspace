// 결정 팝업: 사용자가 정해야 하는 것이 생기면 어느 탭에서든 팝업으로 알리고, 그 자리에서 버튼으로 고르게 한다.
// 추천안은 '추천' 표시와 이유만 보여 주고 자동으로 고르지 않는다. 닫아도 오른쪽 아래 '결정 대기'로 다시 열 수 있다.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveEvent, PendingDecision } from '../../shared/types';
import { useAction, ws } from '../api';
import { Banner } from './common';

export default function DecisionCenter({ onOpenMission }: { onOpenMission: (projectId: string, missionId: string) => void }) {
  const [items, setItems] = useState<PendingDecision[]>([]);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [own, setOwn] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set()); // 이미 팝업으로 보여 준 결정(닫으면 같은 결정으로 다시 띄우지 않음)
  const act = useAction();

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      ws().pendingDecisions().then((list) => {
        setItems(list);
        const fresh = list.filter((d) => !seen.current.has(d.key));
        if (fresh.length) { for (const d of fresh) seen.current.add(d.key); setIdx(Math.max(0, list.findIndex((d) => d.key === fresh[0].key))); setDone(null); setOpen(true); }
      }).catch(() => {});
    };
    load();
    const off = ws().onLive((e: LiveEvent) => { if (e.type === 'mission') { if (t) clearTimeout(t); t = setTimeout(load, 400); } });
    // 다른 화면(사무실의 '확인 필요' 등)에서 결정 팝업을 연다
    const openNow = () => { ws().pendingDecisions().then((list) => { for (const d of list) seen.current.add(d.key); setItems(list); setIdx(0); setDone(null); setOpen(true); }).catch(() => {}); };
    window.addEventListener('crewgenai:open-decisions', openNow);
    return () => { off(); if (t) clearTimeout(t); window.removeEventListener('crewgenai:open-decisions', openNow); };
  }, []);

  const cur = items[Math.min(idx, items.length - 1)] ?? null;
  useEffect(() => { setOwn(''); }, [cur?.key]);
  const rec = useMemo(() => cur?.choices.find((c) => c.recommended) ?? null, [cur]);

  // 고른 안의 설명(고르면 달라지는 것)도 함께 넘겨 다음 계획이 사용자가 승인한 내용 그대로 따르게 한다
  const choose = (label: string, action?: 'stop', effect?: string) => act.run(async () => {
    if (!cur) return;
    const choice = (effect?.trim() ? `${label.trim()} — ${effect.trim()}` : label.trim()).slice(0, 600);
    if (!choice) throw new Error('고를 내용을 입력하세요.');
    if (action === 'stop') await ws().answerMission(cur.missionId, '', 'stop');
    else if (cur.kind === 'question') await ws().answerMission(cur.missionId, choice, 'continue', true);
    else await ws().decideMission(cur.missionId, [{ doc: cur.doc, issue: cur.issue, choice }], cur.waiting);
    const list = await ws().pendingDecisions();
    for (const d of list) seen.current.add(d.key);
    setItems(list);
    setDone(action === 'stop' ? `'${label.trim()}' — 미션을 종료했습니다.` : `'${label.trim()}'로 정했습니다. ${cur.kind === 'question' || cur.waiting ? '미션이 이 결정으로 이어서 진행합니다.' : '다음 계획부터 이 결정을 따릅니다.'}`);
    setIdx(0);
    if (!list.length) setTimeout(() => setOpen(false), 1800);
  });

  if (!items.length && !open) return null;
  return (
    <>
      {items.length > 0 && !open && (
        <button className="decision-badge" onClick={() => { setDone(null); setIdx(0); setOpen(true); }} title="정해야 할 결정을 다시 엽니다">
          결정 대기 {items.length}
        </button>
      )}
      {open && (
        <div className="modal-back" role="presentation">
          <div className="modal decision-modal" role="dialog" aria-modal="true" aria-label="결정이 필요합니다">
            <div className="modal-head">
              <h2>결정이 필요합니다{items.length > 1 ? ` (${Math.min(idx, items.length - 1) + 1}/${items.length})` : ''}</h2>
              <button className="btn" onClick={() => setOpen(false)}>나중에</button>
            </div>
            {cur ? (
              <>
              <div className="decision-body">
                {done && <div className="decision-done">{done}</div>}
                <div className="decision-where">
                  <div><span className="muted small">미션</span> <strong>{cur.projectName}</strong> · {cur.missionTitle}</div>
                  <div><span className="muted small">작업</span> {cur.task}</div>
                  {cur.waiting && <div className="muted small decision-wait">미션이 이 결정을 기다리며 멈춰 있습니다. 고르기 전에는 진행하지 않습니다.</div>}
                </div>
                <div className="decision-q">{cur.question}</div>
                {cur.explain && <div className="decision-explain small">{cur.explain}</div>}
                {rec && <div className="decision-rec small"><span className="badge badge-info">추천</span> {rec.label}{rec.why ? ` — ${rec.why}` : ''} <span className="muted">(자동으로 고르지 않습니다)</span></div>}
                <ul className="decision-choices">
                  {cur.choices.map((c, i) => (
                    <li key={i} className={c.recommended ? 'is-rec' : ''}>
                      <button className="btn decision-choice" disabled={act.busy} onClick={() => void choose(c.label, c.action, c.effect)}>
                        <span className="decision-label">{c.label}{c.recommended && <span className="badge badge-info">추천</span>}</span>
                        {c.effect && <span className="decision-effect small">고르면: {c.effect}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="row gap decision-own">
                  <input className="input" value={own} placeholder="다른 답을 직접 적기" onChange={(e) => setOwn(e.target.value)} />
                  <button className="btn" disabled={act.busy || !own.trim()} onClick={() => void choose(own)}>이 답으로 정하기</button>
                </div>
                {act.error && <Banner>{act.error}</Banner>}
              </div>
              <div className="decision-foot">
                <button className="btn-link small" onClick={() => { onOpenMission(cur.projectId, cur.missionId); setOpen(false); }}>미션 화면에서 자세히</button>
                <div className="decision-foot-nav">
                  {items.length > 1 && <button className="btn" onClick={() => setIdx((i) => (i - 1 + items.length) % items.length)}>이전</button>}
                  {items.length > 1 && <button className="btn" onClick={() => setIdx((i) => (i + 1) % items.length)}>다음 결정</button>}
                </div>
              </div>
              </>
            ) : (
              <div className="decision-body">{done && <div className="decision-done">{done}</div>}<div className="muted">남은 결정이 없습니다.</div></div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
