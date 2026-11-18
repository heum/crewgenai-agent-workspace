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
        <div className="review-cp-sec"><h4>실제로 확인한 범위</h4>{c.verified ? <Markdown text={c.verified} /> : <span className="muted small">기록 없음</span>}</div>
        <div className="review-cp-sec"><h4>미완성·미검증</h4>{c.unverified ? <Markdown text={c.unverified} /> : <span className="muted small">없음으로 보고됨</span>}</div>
      </div>
      {c.assumptions.length > 0 && (
        <div className="review-cp-sec">
          <h4>문서가 부족해 가정하고 진행한 것 <span className="muted small">(다르면 아래 피드백에 적어 주세요)</span></h4>
          <ul className="review-cp-assume">{c.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
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
