// 디자인 비교(예시 상태): 같은 구역·같은 직원 배치를 A안(예전 픽셀 감성)과 B안(현재 스타일 보완)으로 나란히 보여 준다.
// 여기 나오는 인원·리뷰는 확인용 예시이며 실제 미션 상태·실행 기록과 무관하다. 손 흔들기·깜빡임 같은 동작은 장식이다.
import { type JSX, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { charSide } from '../art';
import { characterOf, type CharDef } from '../characters';
import { KITS, isStanding, type Kit, type Piece } from '../officeKit';
import { loungePlan, reviewPlan, habitsFor, type Habit, type ReviewGroupIn } from '../officePlan';
import type { ArtPose } from '../art';
import { Pix, pickScale, placePeople, Scene, type Person, type Pose } from './officeScene';
import { moodAt } from './officeTime';

type Sample = { key: string; code: string; name: string; role: string; char: CharDef; external?: boolean };
const NAMES = ['총괄', '기획·요구 분석', '설계', '백엔드 개발', '프런트엔드 개발', '데이터·DB', '문서 작성', '보안·권한 검토', '코드 리뷰', '시험·품질', '통합·결과물', '인프라', '디자인', '조사·연구', '운영', '지원'];
const STAFF: Sample[] = NAMES.map((n, i) => { const code = String(i).padStart(2, '0'); return { key: `s${code}`, code, name: n, role: n, char: characterOf({ code, name: n, role: n }) }; });
const CODEX: Sample = { key: 'cx1', code: 'CX1', name: 'Codex 리뷰어', role: '외부 검토자', char: characterOf({ code: 'X1', name: 'Codex', role: '' }), external: true };
const byKey = (k: string) => (k === CODEX.key ? CODEX : STAFF.find((s) => s.key === k)!);

type Zone = 'lounge' | 'review' | 'desk' | 'full';
type ReviewCase = 'one' | 'many' | 'crowd';
const REVIEW_CASES: Record<ReviewCase, { label: string; groups: (ReviewGroupIn & { task: string; status: string; results: string[] })[] }> = {
  one: { label: '리뷰 1건', groups: [{ key: 'g1', task: '운영자 API 회사 수정(PATCH) 검토', status: '독립 검토 진행 중', results: ['회사 수정 API 코드', '시험 결과 보고서'], author: 's03', reviewers: [{ key: 's08', external: false }] }] },
  many: { label: '동시 3건', groups: [
    { key: 'g1', task: '운영자 API 회사 수정(PATCH) 검토', status: '독립 검토 + Codex 리뷰 진행 중', results: ['회사 수정 API 코드'], author: 's03', reviewers: [{ key: 's08', external: false }, { key: 'cx1', external: true }] },
    { key: 'g2', task: '운영 웹 회사 목록 화면 검토', status: '독립 검토 진행 중', results: ['회사 목록 화면'], author: 's04', reviewers: [{ key: 's07', external: false }] },
    { key: 'g3', task: '설계 문서 2.4절 검토', status: '자동 검사 진행 중', results: ['설계 문서'], author: 's06', reviewers: [{ key: 's09', external: false }] },
  ] },
  crowd: { label: '참여자 많은 1건', groups: [{ key: 'g1', task: '로그인·권한 전체 흐름 검토', status: '여러 검토자 진행 중', results: ['권한 정책 문서', '로그인 화면'], author: 's03', reviewers: [{ key: 's07', external: false }, { key: 's08', external: false }, { key: 's09', external: false }, { key: 's01', external: false }, { key: 'cx1', external: true }] }] },
};
const REST_COUNTS = [0, 1, 2, 6, 12, 16];

export default function OfficeCompare({ still, onClose }: { still: boolean; onClose: () => void }) {
  const [zone, setZone] = useState<Zone>('lounge');
  const [rest, setRest] = useState(6);
  const [rc, setRc] = useState<ReviewCase>('many');
  const [sel, setSel] = useState<{ kind: 'person' | 'group'; key: string; kit: 'A' | 'B' } | null>(null);
  const [waving, setWaving] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const pick = (key: string, kit: 'A' | 'B') => {
    setSel({ kind: 'person', key, kit });
    if (still) return;
    setWaving(key); if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setWaving(null), 1400); // 잠깐 손 흔들기(장식). 상태는 바꾸지 않는다
  };
  const wrap = useRef<HTMLDivElement | null>(null);
  const [cw, setCw] = useState(900);
  useLayoutEffect(() => { const el = wrap.current; if (!el) return; const f = () => setCw(Math.floor(el.getBoundingClientRect().width)); f(); const ro = new ResizeObserver(f); ro.observe(el); return () => ro.disconnect(); }, []);
  const pw = Math.max(320, Math.floor((cw - 14) / 2)); const ph = 440;
  const restKeys = STAFF.slice(0, rest).map((s) => s.key);
  const groups = REVIEW_CASES[rc].groups;
  const selPerson = sel?.kind === 'person' ? byKey(sel.key) : null;
  const selGroup = sel?.kind === 'group' ? groups.find((g) => g.key === sel.key || `g:${g.author}` === sel.key) ?? null : null;
  return (
    <div className={`ofc-cmp${still ? ' ofc-still' : ''}`}>
      <div className="ofc-cmp-bar">
        <span className="ofc-cmp-note">디자인 비교 · <b>예시 상태</b>(실제 미션·실행 기록과 무관)</span>
        <span className="ofc-cmp-ctl" role="group" aria-label="구역">{([['full', '전체 사무실(A안)'], ['lounge', '휴식 공간'], ['review', '리뷰룸'], ['desk', '업무 자리']] as const).map(([z, l]) => <button key={z} className={zone === z ? 'is-on' : ''} onClick={() => { setZone(z); setSel(null); }}>{l}</button>)}</span>
        {(zone === 'lounge' || zone === 'full') && <span className="ofc-cmp-ctl" role="group" aria-label="휴식 인원">휴식 {REST_COUNTS.map((n) => <button key={n} className={rest === n ? 'is-on' : ''} onClick={() => { setRest(n); setSel(null); }}>{n}명</button>)}</span>}
        {(zone === 'review' || zone === 'full') && <span className="ofc-cmp-ctl" role="group" aria-label="리뷰 경우">{(Object.keys(REVIEW_CASES) as ReviewCase[]).map((k) => <button key={k} className={rc === k ? 'is-on' : ''} onClick={() => { setRc(k); setSel(null); }}>{REVIEW_CASES[k].label}</button>)}</span>}
        <button className="btn btn-sm" onClick={onClose}>실제 사무실로</button>
      </div>
      <div className="ofc-cmp-panels" ref={wrap}>
        {zone === 'full' && <FullSample w={cw} rest={rest} rc={rc} still={still} sel={sel?.key ?? null} waving={waving} onPick={(k) => pick(k, 'A')} onGroup={(k) => setSel({ kind: 'group', key: k, kit: 'A' })} />}
        {zone !== 'full' && (['A', 'B'] as const).map((id) => (
          <section key={id} className="ofc-cmp-panel">
            <h4>{KITS[id].label} <span className="muted small">· {KITS[id].scale}배</span></h4>
            <Panel kit={KITS[id]} w={pw} h={ph} zone={zone} restKeys={restKeys} groups={groups} sel={sel?.kit === id ? sel : null} waving={waving} still={still}
              onPick={(k) => pick(k, id)} onGroup={(k) => setSel({ kind: 'group', key: k, kit: id })} />
          </section>
        ))}
      </div>
      <div className="ofc-cmp-detail">
        {selPerson && <div><b>{selPerson.code} {selPerson.name}</b> <span className="muted small">· 예시 상태</span><div className="small">{zone === 'lounge' ? '휴식 중' : zone === 'review' ? (groups.find((g) => g.author === selPerson.key) ? '리뷰받는 중' : '검토 중') : '작업 중'} — 누르면 손을 흔든 뒤 상세가 열립니다(장식 동작, 상태는 바뀌지 않음)</div></div>}
        {selGroup && <div><b>{selGroup.task}</b> <span className="muted small">· 예시 상태</span>
          <div className="small">검토 상태: {selGroup.status}</div>
          <div className="small">리뷰받는 직원: {selGroup.author ? `${byKey(selGroup.author).code} ${byKey(selGroup.author).name}` : '—'} · 검토자: {selGroup.reviewers.map((r) => `${byKey(r.key).code} ${byKey(r.key).name}`).join(', ')}</div>
          <div className="small">결과물: {selGroup.results.join(', ')}</div></div>}
        {!sel && <span className="muted small">직원이나 리뷰 그룹을 눌러 보세요. 같은 직원·같은 배치를 두 안으로 그렸습니다.</span>}
      </div>
    </div>
  );
}

function Panel({ kit, w, h, zone, restKeys, groups, sel, waving, still, onPick, onGroup }: {
  kit: Kit; w: number; h: number; zone: Zone; restKeys: string[]; groups: ReviewGroupIn[]; sel: { kind: string; key: string } | null; waving: string | null; still: boolean;
  onPick: (k: string) => void; onGroup: (k: string) => void;
}) {
  const s = kit.scale; const LW = Math.floor(w / s); const LH = Math.floor(h / s);
  const pad = kit.id === 'B' ? 8 : 4;
  const box = { x: pad, y: pad + (kit.id === 'B' ? 10 : 6), w: LW - 2 * pad, h: LH - 2 * pad - (kit.id === 'B' ? 10 : 6) };
  const lounge = useMemo(() => (zone === 'lounge' ? loungePlan(kit, box, restKeys) : null), [kit, zone, restKeys.join(), LW, LH]);
  const review = useMemo(() => (zone === 'review' ? reviewPlan(kit, box, groups) : null), [kit, zone, groups, LW, LH]);
  const [showMore, setShowMore] = useState(false);
  const tags: { key: string; x: number; y: number; role?: string }[] = [];
  const floor = <Floor kit={kit} w={LW} h={LH} zone={zone} />;
  const actor = (key: string, pose: ArtPose, x: number, y: number, habits: Habit[], frames?: boolean) => {
    const c = byKey(key).char; const wav = waving === key && !still;
    const r = wav ? kit.person(c, isStanding(pose) ? 'wave' : pose, isStanding(pose) ? '' : 'wave') : kit.person(c, pose);
    return (
      <g key={key} className={wav ? 'ofc-wave' : undefined}>
        {frames && !wav ? <><Pix r={kit.person(c, pose, '', 0)} x={x} y={y} className="ofc-fa" /><Pix r={kit.person(c, pose, '', 1)} x={x} y={y} className="ofc-fb" /></> : <Pix r={r} x={x} y={y} />}
        {!wav && !still && habits.map((hb) => <g key={hb.mod} className={`ofc-hab ofc-hab-${hb.mod === 'blink' ? 'short' : 'long'}`} style={{ animationDuration: `${hb.period}s`, animationDelay: `${hb.delay}s` }}><Pix r={kit.person(c, pose, hb.mod)} x={x} y={y} /></g>)}
        {sel?.key === key && <rect x={x - 1} y={y - 1} width={kit.cw + 2} height={(isStanding(pose) ? kit.ch : kit.sitH) + 2} fill="none" stroke="#14b8a6" strokeWidth={1} />}
        <rect x={x} y={y} width={kit.cw} height={isStanding(pose) ? kit.ch : kit.sitH} fill="transparent" style={{ cursor: 'pointer' }} onClick={() => onPick(key)}><title>{`${byKey(key).code} ${byKey(key).name}`}</title></rect>
      </g>
    );
  };
  const pieces = (ps: Piece[], k: string) => ps.map((p, i) => <g key={`${k}${i}`}>{p.sky && <rect x={p.x + 2} y={p.y + 2} width={p.sky.w - 2} height={p.sky.h - 2} fill="#bfe1f2" />}<Pix r={p.r} x={p.x} y={p.y} /></g>);
  let body: JSX.Element[] = [];
  if (lounge) {
    lounge.stations.forEach((pl, i) => {
      const inside = lounge.seats.filter((st) => st.x >= pl.x - 2 && st.x < pl.x + pl.st.w && st.y >= pl.y - 4 && st.y < pl.y + pl.st.h);
      const shift = (ps: Piece[]) => ps.map((p) => ({ ...p, x: p.x + pl.x, y: p.y + pl.y }));
      body.push(<g key={`st${i}`}>{pieces(shift(pl.st.back), `b${i}`)}{inside.map((st) => actor(st.key, st.pose, st.x, st.y, st.habits))}{pieces(shift(pl.st.front), `f${i}`)}</g>);
      inside.forEach((st) => tags.push({ key: st.key, x: st.x + kit.cw / 2, y: st.y + (isStanding(st.pose) ? kit.ch : kit.sitH + (kit.id === 'B' ? 6 : 3)) }));
    });
  }
  if (review) {
    review.pods.forEach((pd) => {
      const sh = (ps: Piece[]) => ps.map((p) => ({ ...p, x: p.x + pd.x, y: p.y + pd.y }));
      const g = groups.find((x) => x.key === pd.key)!;
      const ax = pd.x + pd.pod.author.x; const ay = pd.y + pd.pod.author.y;
      body.push(
        <g key={pd.key}>
          <rect x={pd.x - 2} y={pd.y - 2} width={pd.pod.w + 4} height={pd.pod.h + 4} rx={2} fill={sel?.key === pd.key ? '#14b8a622' : '#00000008'} stroke={sel?.key === pd.key ? '#14b8a6' : '#00000018'} strokeWidth={1} style={{ cursor: 'pointer' }} onClick={() => onGroup(pd.key)}><title>리뷰 그룹 — 눌러서 작업·참여자·상태 보기</title></rect>
          {pieces(sh(pd.pod.back), 'b')}
          {pd.shown.map((r) => actor(r.key, byKey(r.key).external ? 'sit' : 'review', r.x, r.y, habitsFor(r.key, 'review').map((h) => (h.mod === 'glanceR' ? { ...h, mod: 'glanceL' as const } : h))))}
          {pieces(sh(pd.pod.front), 'f')}
          {pd.pod.laptops.map((l, i) => <Pix key={`l${i}`} r={kit.laptop()} x={pd.x + l.x} y={pd.y + l.y} />)}
          {g.author && (kit.id === 'B'
            ? <g className={waving === g.author && !still ? 'ofc-wave' : undefined}><Pix r={charSide(byKey(g.author).char, 'sit')} x={ax} y={ay} /><rect x={ax} y={ay} width={36} height={46} fill="transparent" style={{ cursor: 'pointer' }} onClick={() => onPick(g.author!)} />{sel?.key === g.author && <rect x={ax - 1} y={ay - 1} width={38} height={48} fill="none" stroke="#14b8a6" />}</g>
            : actor(g.author, 'sit', ax, ay, [{ mod: 'blink', period: 6, delay: 1 }]))}
        </g>,
      );
      if (g.author) tags.push({ key: g.author, x: ax + (kit.id === 'B' ? 18 : kit.cw / 2), y: pd.y + pd.pod.h + 1, role: 'author' });
      pd.shown.forEach((r) => tags.push({ key: r.key, x: r.x + kit.cw / 2, y: pd.y + pd.pod.h + 1, role: byKey(r.key).external ? 'codex' : 'reviewer' }));
    });
  }
  if (zone === 'desk') {
    const work: [string, ArtPose, 'code' | 'doc' | 'wait' | 'off'][] = [['s03', 'type', 'code'], ['s06', 'sit', 'doc'], ['s01', 'sit', 'wait'], ['', 'sit', 'off']];
    const dw = kit.desk.w + (kit.id === 'B' ? 6 : 3);
    const x0 = Math.floor((LW - Math.min(work.length, Math.floor((LW - 2 * pad) / dw)) * dw) / 2);
    work.slice(0, Math.floor((LW - 2 * pad) / dw)).forEach(([k, pose, scr], i) => {
      const dx = x0 + i * dw; const dy = box.y + (kit.id === 'B' ? 16 : 8);
      body.push(<g key={`d${i}`}><Pix r={kit.deskBack(!k)} x={dx} y={dy} />{k && actor(k, pose, dx + kit.desk.seat.x, dy + kit.desk.seat.y, habitsFor(k, pose), pose === 'type')}<Pix r={kit.deskFront(scr, 'clipboard', i)} x={dx} y={dy} /></g>);
      if (k) tags.push({ key: k, x: dx + kit.desk.w / 2, y: dy + kit.desk.h + 1 });
    });
  }
  const over = lounge ? lounge.overflow : review ? review.overflow.flatMap((g) => [g.author, ...g.reviewers.map((r) => r.key)].filter((x): x is string => !!x)) : [];
  const hiddenInPods = review ? review.pods.flatMap((p) => p.hidden.map((k) => ({ k, pod: p }))) : [];
  return (
    <div className="ofc-cmp-stage" style={{ width: LW * s, height: LH * s }}>
      <svg viewBox={`0 0 ${LW} ${LH}`} width={LW * s} height={LH * s} shapeRendering="crispEdges">{floor}{body}</svg>
      <div className="ofc-overlay">
        {tags.map((t) => { const p = byKey(t.key); return <button key={`t${t.key}`} className={`ofc-tag is-sm ofc-cmp-tag${t.role ? ` is-${t.role}` : ''}${sel?.key === t.key ? ' is-on' : ''}`} style={{ left: t.x * s, top: t.y * s, transform: 'translate(-50%, 0)' }} onClick={() => onPick(t.key)} title={`${p.code} ${p.name}`}>{t.role === 'author' ? '리뷰받음 ' : ''}{p.code}</button>; })}
        {hiddenInPods.map(({ k, pod }, i) => i === hiddenInPods.findIndex((x) => x.pod === pod) && <button key={`h${pod.key}`} className="ofc-zone ofc-zone-sm" style={{ left: (pod.x + pod.pod.w - 10) * s, top: (pod.y - 2) * s }} onClick={() => onGroup(pod.key)}>검토자 +{pod.hidden.length}명</button>)}
        {over.length > 0 && <button className="ofc-zone ofc-cmp-more" style={{ right: 6, bottom: 6 }} onClick={() => setShowMore((v) => !v)}>자리 밖 {over.length}명 · 목록</button>}
        {showMore && over.length > 0 && <div className="ofc-cmp-list" style={{ right: 6, bottom: 36 }}>{over.map((k) => <button key={k} onClick={() => onPick(k)}>{byKey(k).code} {byKey(k).name}</button>)}</div>}
        {lounge && <span className="ofc-zone ofc-zone-sm" style={{ left: 6, top: 4 }}>휴식 {restKeys.length}명 · 자리 {lounge.capacity}</span>}
        {review && <span className="ofc-zone ofc-zone-sm" style={{ left: 6, top: 4 }}>리뷰 {groups.length}건</span>}
      </div>
    </div>
  );
}

function Floor({ kit, w, h, zone }: { kit: Kit; w: number; h: number; zone: Zone }) {
  const ph = kit.id === 'B' ? 7 : 4; const pl = kit.id === 'B' ? 56 : 28;
  const rows: JSX.Element[] = [];
  if (zone === 'review') {
    rows.push(<rect key="bg" width={w} height={h} fill="#dfe5dc" />);
    const t = kit.id === 'B' ? 16 : 9;
    for (let y = t - 1; y < h; y += t) rows.push(<rect key={`y${y}`} x={0} y={y} width={w} height={1} fill="#ccd4ca" />);
    for (let x = t - 1; x < w; x += t) rows.push(<rect key={`x${x}`} x={x} y={0} width={1} height={h} fill="#ccd4ca" />);
    return <g>{rows}</g>;
  }
  rows.push(<rect key="bg" width={w} height={h} fill="#cfa26e" />);
  for (let y = 0, r = 0; y < h; y += ph, r++) {
    rows.push(<rect key={`l${y}`} x={0} y={y + ph - 1} width={w} height={1} fill="#b38552" />);
    for (let x = -((r * 29) % pl); x < w; x += pl) rows.push(<rect key={`j${y}-${x}`} x={x + pl - 1} y={y} width={1} height={ph - 1} fill="#b38552" />);
    if (r % 3 === 1) rows.push(<rect key={`s${y}`} x={0} y={y} width={w} height={ph - 1} fill="#d6ab78" opacity={0.5} />);
  }
  return <g>{rows}</g>;
}

/** 전체 사무실(A안)을 예시 상태로: 실제 사무실 장면 그대로에 예시 인원만 넣는다(휴식 n명, 리뷰 경우, 나머지는 작업·대기) */
function FullSample({ w, rest, rc, still, sel, waving, onPick, onGroup }: { w: number; rest: number; rc: ReviewCase; still: boolean; sel: string | null; waving: string | null; onPick: (k: string) => void; onGroup: (k: string) => void }) {
  const groups = REVIEW_CASES[rc].groups;
  const inReview = new Set(groups.flatMap((g) => [g.author, ...g.reviewers.map((r) => r.key)]).filter(Boolean) as string[]);
  const reviewOf = new Map<string, string>(); groups.forEach((g) => g.reviewers.forEach((r) => { if (g.author) reviewOf.set(r.key, g.author); }));
  const others = STAFF.filter((s) => !inReview.has(s.key));
  const restSet = new Set(others.slice(Math.max(0, others.length - rest)).map((s) => s.key));
  const workPoses: Pose[] = ['plan', 'code', 'doc', 'wait', 'code', 'doc'];
  const people: Person[] = [...STAFF, ...(inReview.has(CODEX.key) ? [CODEX] : [])].map((s, i) => {
    const pose: Pose = groups.some((g) => g.author === s.key) ? 'reviewed' : inReview.has(s.key) ? 'review' : restSet.has(s.key) ? 'rest' : workPoses[i % workPoses.length];
    const state = pose === 'rest' ? 'rest' : pose === 'review' || pose === 'reviewed' ? 'review' : pose === 'wait' ? 'wait' : 'work';
    const g = groups.find((x) => x.author === s.key || x.reviewers.some((r) => r.key === s.key));
    return { key: s.key, agent: null, code: s.code, name: s.name, role: s.role, char: s.char, prop: 'plant', state, pose, task: g?.task ?? '예시 작업', since: null, external: !!s.external, blocked: [], blockedSteps: [], asks: false, reviewOf: reviewOf.get(s.key) ?? null } as Person;
  });
  const staff = people.filter((p) => !p.external);
  const h = 560;
  const { scale, layout } = pickScale(w, h, 1, staff.length, 0, groups.map((g) => g.reviewers.length));
  const plan = placePeople(people, staff, layout);
  return (
    <section className="ofc-cmp-panel">
      <h4>전체 사무실 · A안 <span className="muted small">· {scale}배 · 예시 상태(휴식 {rest}명 · {REVIEW_CASES[rc].label})</span></h4>
      <div className="ofc-cmp-stage" style={{ width: layout.W * scale, height: layout.H * scale }}>
        <Scene people={people} staff={staff} layout={layout} plan={plan} mood={moodAt(10.5)} selected={sel} waving={waving} still={still} selectedGroup={null} onGroup={onGroup} />
        <div className="ofc-overlay">
          {plan.placed.map((pl) => <button key={pl.p.key} className={`ofc-tag is-sm${sel === pl.p.key ? ' is-on' : ''}`} style={{ left: (pl.x + pl.w / 2) * scale, top: (pl.zone === 'review' ? (plan.review.pods.find((q) => q.key === pl.group)!.y + plan.review.pods.find((q) => q.key === pl.group)!.pod.h + 1) : pl.y + pl.h + 1) * scale, transform: 'translate(-50%,0)' }} onClick={() => onPick(pl.p.key)}>{pl.p.code}</button>)}
          {plan.overflow.lounge.length > 0 && <span className="ofc-zone ofc-zone-sm" style={{ right: 6, bottom: 6 }}>휴식 자리 밖 {plan.overflow.lounge.length}명</span>}
          {plan.overflow.review.length > 0 && <span className="ofc-zone ofc-zone-sm" style={{ right: 6, top: (layout.review.y + 1) * scale }}>리뷰 자리 밖 {plan.overflow.review.length}명</span>}
        </div>
      </div>
    </section>
  );
}
