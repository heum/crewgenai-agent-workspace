// 검토 지점: 의미 있는 결과가 준비됐을 때 한곳에서 보고 판단한다.
// 이번에 만든 큰 기능·달라진 점, 바로 여는 시연, 눌러 볼 순서와 예상 결과, 실제 확인한 범위와 미완성·미검증, 가정하고 진행한 세부,
// 사용자가 정할 핵심(최대 3, 추천 표시만 하고 자동으로 고르지 않음), 묶은 피드백. 고르지 않은 결정은 다음 검토 지점에 다시 나온다.
import { useState } from 'react';
import type { Mission } from '../../shared/types';
import { useAction, ws } from '../api';
import { Banner } from './common';
import { Markdown } from '../markdown';
import ResultsPanel, { StatusBadge } from './Results';

const REASON: Record<string, string> = {
  ready: '검토할 결과가 준비됐습니다', budget: '지금까지의 결과입니다(개발은 계속 진행 중)',
  blocked: '실행 준비 확인에서 막혀 작업을 배정하지 않았습니다',
};

export default function ReviewCheckpoint({ mission: m, onChanged }: { mission: Mission; onChanged: () => Promise<void> | void }) {
  const c = m.checkpoint!;
  const act = useAction();
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [own, setOwn] = useState<Record<number, string>>({});
  const [fb, setFb] = useState('');
  const send = (action: 'continue' | 'stop') => act.run(async () => {
    const list = c.decisions.map((d, i) => ({ doc: d.doc, question: d.question, choice: (own[i]?.trim() || picks[i] || '').trim() })).filter((p) => p.choice);
    await ws().reviewMission(m.id, list, fb, action);
    await onChanged();
  });
  const undecided = c.decisions.filter((_, i) => !(own[i]?.trim() || picks[i])).length;
  return (
    <section className="card review-cp" aria-label="검토 지점">
      <div className="review-cp-head">
        <span className="review-cp-eyebrow">{REASON[c.reason] ?? REASON.budget} · 사이클 {c.cycle}</span>
        <h3>{c.title}</h3>
        {c.usage && <div className="muted small review-cp-usage">사용량: {c.usage}</div>}
      </div>
      {/* 한눈에 보기: 무엇이 됐고, 무엇을 확인·결정하면 되는지 */}
      <div className="review-cp-summary" role="list" aria-label="한눈에 보기">
        <span role="listitem" className="sum-chip">만들어진 것 <b>{c.features.length}</b>{c.features.some((f) => f.status === 'verified' || f.status === 'reviewable') ? <> · 검증 <b>{c.features.filter((f) => f.status === 'verified' || f.status === 'reviewable').length}</b></> : null}</span>
        {c.decisions.length > 0 && <span role="listitem" className="sum-chip is-ask">정할 것 <b>{c.decisions.length}</b></span>}
        {c.assumptions.length > 0 && <span role="listitem" className="sum-chip">가정하고 진행 <b>{c.assumptions.length}</b></span>}
        {!!c.blocked?.length && <span role="listitem" className="sum-chip is-bad">막힘 <b>{c.blocked.length}</b></span>}
        {c.unverified?.trim() && <span role="listitem" className="sum-chip is-warn">미완성·미검증 있음</span>}
      </div>
      {!!c.blocked?.length && (
        <div className="review-cp-sec review-cp-blocked">
          <h4>막힌 것 — 자동 재시도·작업 배정을 멈췄습니다</h4>
          <ul>{c.blocked.map((b, i) => <li key={i}>{b}</li>)}</ul>
          <div className="muted small">해결하셨거나 이대로 진행하려면 아래 '이어서 진행'을 누르세요.</div>
        </div>
      )}
      {c.features.length > 0 && (
        <div className="review-cp-sec">
          <h4>이번에 만들어진 것</h4>
          <ul className="review-cp-feats">{c.features.map((f, i) => <li key={i}><StatusBadge s={f.status} /> <strong>{f.name}</strong>{f.changed && <span className="muted"> — {f.changed}</span>}</li>)}</ul>
        </div>
      )}
      <div className="review-cp-sec">
        <h4>시연 열기</h4>
        <ResultsPanel mission={m} feedback={false} />
      </div>
      {c.steps && <div className="review-cp-sec"><h4>눌러 볼 순서와 예상 결과</h4><Markdown text={c.steps} /></div>}
      <div className="review-cp-grid">
        <div className="review-cp-sec"><h4>실제로 확인한 범위</h4>{c.verified ? <Clamp><Markdown text={c.verified} /></Clamp> : <span className="muted small">기록 없음</span>}</div>
        <div className="review-cp-sec"><h4>미완성·미검증</h4>{c.unverified ? <Clamp><Markdown text={c.unverified} /></Clamp> : <span className="muted small">없음으로 보고됨</span>}</div>
      </div>
      {c.assumptions.length > 0 && (
        <div className="review-cp-sec">
          <h4>문서가 부족해 가정하고 진행한 것 <span className="muted small">(다르면 아래 피드백에 적어 주세요)</span></h4>
          <AssumeList items={c.assumptions} />
        </div>
      )}
      {c.decisions.length > 0 && (
        <div className="review-cp-sec">
          <h4>정해 주셔야 할 것 {c.decisions.length}건</h4>
          {c.decisions.map((d, i) => (
            <div key={i} className="review-cp-dec">
              <div className="review-cp-q">{i + 1}. {d.question}</div>
              <div className="review-cp-choices" role="radiogroup" aria-label={d.question}>
                {d.choices.map((ch) => (
                  <label key={ch.label} className={`review-cp-choice${picks[i] === ch.label ? ' is-on' : ''}`}>
                    <input type="radio" name={`cp-${c.at}-${i}`} checked={picks[i] === ch.label} onChange={() => setPicks((p) => ({ ...p, [i]: ch.label }))} />
                    <span><b>{ch.label}</b>{ch.recommended && <span className="badge badge-info">추천</span>}{ch.effect && <span className="muted small"> — {ch.effect}</span>}{ch.recommended && ch.why && <span className="small review-cp-why">추천 이유: {ch.why}</span>}</span>
                  </label>
                ))}
                <input className="input" placeholder="직접 적기(선택)" value={own[i] ?? ''} onChange={(e) => setOwn((o) => ({ ...o, [i]: e.target.value }))} />
              </div>
            </div>
          ))}
          <div className="muted small">추천은 표시만 합니다. 고르지 않은 항목은 정하지 않은 채로 남고 다음 검토 지점에 다시 보여 드립니다.</div>
        </div>
      )}
      <div className="review-cp-sec">
        <h4>피드백(한 번에 묶어서)</h4>
        <textarea className="input" rows={3} value={fb} placeholder="시연을 보고 바꿀 점을 한 번에 적어 주세요. 다음 사이클에 수정하고 같은 시연에서 다시 확인할 수 있게 합니다." onChange={(e) => setFb(e.target.value)} />
      </div>
      {act.error && <Banner>{act.error}</Banner>}
      <div className="row gap review-cp-actions">
        <button className="btn btn-primary" disabled={act.busy} onClick={() => void send('continue')}>{fb.trim() || Object.keys(picks).length || Object.values(own).some((v) => v.trim()) ? '보내고 이어서 진행' : '확인했습니다 — 이어서 진행'}</button>
        <button className="btn" disabled={act.busy} onClick={() => void send('stop')}>여기서 종료</button>
        {undecided > 0 && <span className="muted small">정하지 않은 결정 {undecided}건은 남겨 둡니다</span>}
      </div>
    </section>
  );
}

/** 가정 한 줄을 '핵심'과 '자세히'로 나눈다: '핵심 — 자세히' 형식이면 그대로, 아니면 첫 마디(쉼표·마침표·괄호 앞, 40자 안)를 핵심으로 */
export function splitHead(t: string): { head: string; rest: string } {
  const s = t.trim();
  const m = /^(.{2,48}?)\s+[—–-]\s+([\s\S]+)$/.exec(s) ?? /^(.{2,40}?)[:：]\s+([\s\S]+)$/.exec(s);
  if (m) return { head: m[1].trim(), rest: m[2].trim() };
  const cut = s.search(/[,.。(]|(?:하고|하며|하되|이며|지만)\s/);
  if (cut > 6 && cut <= 40) return { head: s.slice(0, cut).trim(), rest: s.slice(cut).replace(/^[,.。]\s*/, '').trim() };
  if (s.length <= 40) return { head: s, rest: '' };
  return { head: `${s.slice(0, 34).trim()}…`, rest: s };
}

/** 가정 목록: 굵은 핵심만 먼저 보이고 누르면 자세히. 처음 5개만 보이고 나머지는 펼쳐서 */
function AssumeList({ items }: { items: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 5);
  return (
    <>
      <ul className="review-cp-assume">
        {shown.map((a, i) => { const { head, rest } = splitHead(a); return (
          <li key={i}>{rest ? <details><summary><b>{head}</b></summary><div className="muted small">{rest}</div></details> : <b>{head}</b>}</li>
        ); })}
      </ul>
      {items.length > 5 && <button className="btn-link small" onClick={() => setAll((v) => !v)}>{all ? '접기' : `나머지 ${items.length - 5}개 보기`}</button>}
    </>
  );
}

/** 긴 글은 몇 줄만 보이고 '더 보기'로 펼친다 */
function Clamp({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`clamp-box${open ? ' is-open' : ''}`}>
      <div className="clamp-body">{children}</div>
      <button className="btn-link small" onClick={() => setOpen((v) => !v)}>{open ? '접기' : '더 보기'}</button>
    </div>
  );
}
