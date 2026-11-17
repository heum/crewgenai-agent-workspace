// 작업별 결과물(미션 화면·사무실 공용): 어떤 미션·회차·작업의 결과인지, 달라진 점, 확인할 것, 실제 검증 여부와 남은 사항, 열기.
// 회차가 넘어가도 직전 회차 결과물을 골라 볼 수 있다. 피드백은 다음 사이클 계획에 반영된다.
import { useEffect, useState } from 'react';
import { RESULT_STATUS_LABEL, type Mission, type MissionResult, type ResultStatus } from '../../shared/types';
import { useAction, ws } from '../api';
import { Badge, Banner } from './common';
import { openDefaultApp, useFileOpener } from './fileOpen';
import { DemoBar, DemoBlock, useDemo, useDemoOpener } from './Demo';

const ACTIVE: Mission['status'][] = ['planning', 'running', 'evaluating'];

export function missionTitle(m: Mission): string {
  return m.prompt.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 80) ?? '미션';
}

/** 회차별 결과물 목록(최신 먼저). 예전 미션(기록 없음)은 마지막 결과물만. */
export function resultRounds(m: Mission): { cycle: number; results: MissionResult[] }[] {
  if (m.resultsHistory?.length) return m.resultsHistory;
  return m.results ? [{ cycle: m.resultsCycle ?? m.cycle, results: m.results }] : [];
}

export default function ResultsPanel({ mission: m, feedback = true, showMission = false }: { mission: Mission; feedback?: boolean; showMission?: boolean }) {
  const act = useAction();
  const rounds = resultRounds(m);
  const [cycle, setCycle] = useState<number | null>(null);
  const latest = rounds[0]?.cycle ?? null;
  useEffect(() => { setCycle(null); }, [m.id, latest]);
  const round = rounds.find((r) => r.cycle === (cycle ?? latest)) ?? rounds[0];
  const [fb, setFb] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const opener = useFileOpener();
  const demo = useDemo(m.projectId);
  const demoOpen = useDemoOpener(m.projectId, demo);
  if (!round) return <div className="muted small">아직 열어 볼 결과물이 없습니다. 첫 사이클의 판단이 끝나면 작업별 결과물이 여기에 나타납니다.</div>;
  const rs = round.results;
  const send = () => act.run(async () => {
    const t = fb.trim(); if (!t) throw new Error('피드백을 입력하세요.');
    const text = `[사이클 ${round.cycle} 결과물 피드백] ${t}`;
    if (ACTIVE.includes(m.status)) await ws().addDirective(m.id, text, 'next');
    else if (m.status === 'failed') throw new Error('실패한 미션입니다. 미션 화면에서 새로 지시하세요.');
    else await ws().answerMission(m.id, text, 'continue', true);
    setFb(''); setSent(ACTIVE.includes(m.status) ? '다음 사이클 계획에 반영합니다.' : '피드백을 반영해 이어서 진행합니다.');
  });
  return (
    <div className="results-panel">
      <DemoBar projectId={m.projectId} demo={demo} onConsole={demoOpen.openConsole} />
      {demoOpen.ui}
      {demoOpen.act.error && <Banner>{demoOpen.act.error}</Banner>}
      <div className="results-meta">
        {showMission && <span className="results-mission" title={missionTitle(m)}>{missionTitle(m)}</span>}
        <span className="muted small">작업 {new Set(rs.map((r) => r.task)).size}개 · 결과물 {rs.length}개</span>
        {rounds.length > 1 && (
          <label className="results-cycle small">
            회차
            <select value={round.cycle} onChange={(e) => setCycle(Number(e.target.value))}>
              {rounds.map((r) => <option key={r.cycle} value={r.cycle}>사이클 {r.cycle}{r.cycle === latest ? ' (최신)' : ''}</option>)}
            </select>
          </label>
        )}
        {rounds.length <= 1 && <span className="muted small">사이클 {round.cycle}</span>}
      </div>
      {!rs.length && <div className="muted small">이 회차에는 열어 볼 결과물이 없었습니다. 진행 보고에서 이유를 확인하세요.</div>}
      <ul className="results-list">
        {rs.map((r, i) => (
          <li key={i}>
            <div className="results-row-head">
              <strong className="results-title">{r.title}</strong>
              {r.status && <StatusBadge s={r.status} />}
              {!r.exists && <Badge tone="bad">파일 없음</Badge>}
              {r.kind === 'file' && r.exists && <button className="btn-link small" disabled={act.busy} onClick={() => void act.run(() => openDefaultApp(r.path))}>기본 앱</button>}
            </div>
            {r.task && <div className="small results-task"><span className="muted">작업</span> {r.task}</div>}
            {r.changed && <div className="small"><span className="muted">달라진 기능</span> {r.changed}</div>}
            {r.demo ? <DemoBlock d={r.demo} info={demo.info} busy={demoOpen.act.busy} onOpen={() => void demoOpen.open(r.demo!)} /> : r.check && <div className="small"><span className="muted">확인할 것</span> {r.check}</div>}
            <div className="small"><span className="muted">검증</span> {r.verified?.trim() ? r.verified : <span className="muted">기록 없음(이 회차 판단이 검증 여부를 남기지 않음)</span>}</div>
            {r.remaining?.trim() && <div className="small"><span className="muted">남은 제한사항</span> {r.remaining}</div>}
            <div className="small results-aux">
              <span className="muted">{r.demo ? '보조 자료' : '결과물'}</span>
              <button className={`btn btn-sm${r.demo ? '' : ' btn-primary'}`} disabled={!r.exists || act.busy} title={r.exists ? r.path : '파일이 없습니다'} onClick={() => void act.run(() => opener.open(r.path, r.kind, r.title))}>{r.kind === 'url' ? '화면 열기' : r.demo ? '문서·소스 보기' : '열기'}</button>
              <span className="muted mono results-path">{r.relPath}</span>
            </div>
          </li>
        ))}
      </ul>
      {feedback && (
        <>
          <div className="row gap results-fb">
            <textarea className="input" rows={2} value={fb} placeholder="결과물을 보고 바꿀 점을 적어 주세요. 예: 추천 목록을 맨 위로, 이 문구는 숨겨 주세요" onChange={(e) => setFb(e.target.value)} />
            <button className="btn btn-primary" disabled={act.busy || !fb.trim()} onClick={() => void send()}>피드백 보내기</button>
          </div>
          {sent && <div className="muted small">{sent}</div>}
        </>
      )}
      {act.error && <Banner>{act.error}</Banner>}
      {opener.viewer}
    </div>
  );
}

/** 결과 상태: 구현됨 → 실행됨 → 실제 기능 검증됨 → 사용자 검토 가능 → 피드백 반영됨 */
export function StatusBadge({ s }: { s: ResultStatus }) {
  const tone = s === 'implemented' ? 'neutral' : s === 'ran' ? 'info' : s === 'verified' ? 'ok' : s === 'reviewable' ? 'ok' : 'ok';
  return <Badge tone={tone}>{RESULT_STATUS_LABEL[s]}</Badge>;
}
