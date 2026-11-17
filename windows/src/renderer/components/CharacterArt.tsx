// 캐릭터 그림(도트) — 직원 목록·상세·사무실·선택 팝업이 같은 그림을 쓴다.
import { useState } from 'react';
import { CHARACTERS, CHAR_H, CHAR_W, SIT_H, charById, charRects, type CharDef, type Pose } from '../characters';
import { Modal } from './common';

/** 장면 안에 넣는 캐릭터(<g>). x,y는 그림 왼쪽 위(테두리 포함). */
export function CharG({ def, pose, frame = 0, x, y, className }: { def: CharDef; pose: Pose; frame?: number; x: number; y: number; className?: string }) {
  // 움직임(CSS transform)은 바깥 g에, 자리(translate)는 안쪽 g에 — CSS 애니메이션이 자리 이동을 덮어쓰지 않게
  const body = <g transform={`translate(${x} ${y})`}>{charRects(def, pose, frame).map(([rx, ry, w, h, c], i) => <rect key={i} x={rx} y={ry} width={w} height={h} fill={c} />)}</g>;
  return className ? <g className={className}>{body}</g> : body;
}
/** 따로 쓰는 캐릭터 그림. head면 얼굴만(목록용). */
export function CharSprite({ def, pose = 'stand', size, head }: { def: CharDef; pose?: Pose; size: number; head?: boolean }) {
  const h = head ? 14 : pose === 'stand' ? CHAR_H : SIT_H;
  return (
    <svg className="char-sprite" width={(size * CHAR_W) / h} height={size} viewBox={`0 0 ${CHAR_W} ${h}`} shapeRendering="crispEdges" aria-hidden="true">
      {charRects(def, pose).filter(([, ry]) => ry < h).map(([rx, ry, w, hh, c], i) => <rect key={i} x={rx} y={ry} width={w} height={hh} fill={c} />)}
    </svg>
  );
}

/** 캐릭터 20종 고르기. 현재 고른 것을 표시하고, '선택 적용'은 직원 화면의 저장 전 상태로만 넣는다. */
export function CharacterPicker({ value, who, onApply, onClose }: { value: string; who: string; onApply: (id: string) => void; onClose: () => void }) {
  const [sel, setSel] = useState(value);
  const cur = charById(sel) ?? CHARACTERS[0];
  return (
    <Modal title="캐릭터 선택" wide onClose={onClose}>
      <div className="char-pick">
        <div className="char-pick-sub"><span>{who}에게 사용할 캐릭터를 고르세요</span><span className="char-count">{CHARACTERS.length}종</span></div>
        <div className="char-grid" role="radiogroup" aria-label="캐릭터">
          {CHARACTERS.map((c) => (
            <button key={c.id} role="radio" aria-checked={sel === c.id} className={`char-card${sel === c.id ? ' is-on' : ''}${value === c.id ? ' is-cur' : ''}`} onClick={() => setSel(c.id)} onDoubleClick={() => onApply(c.id)}>
              <span className="char-id">{c.id}</span>
              {sel === c.id && <span className="char-badge">✓ 선택됨</span>}
              {sel !== c.id && value === c.id && <span className="char-badge char-badge-cur">지금 캐릭터</span>}
              <CharSprite def={c} size={108} />
              <span className="char-name">{c.name}</span>
            </button>
          ))}
        </div>
        <div className="char-pick-foot">
          <span className="char-pick-cur"><CharSprite def={cur} size={44} head /><span><b>선택한 캐릭터 · {cur.id} {cur.name}</b><br /><span className="muted small">직원 화면에서 저장하면 적용됩니다</span></span></span>
          <span className="row gap"><button className="btn" onClick={onClose}>취소</button><button className="btn btn-primary" onClick={() => onApply(sel)}>선택 적용</button></span>
        </div>
      </div>
    </Modal>
  );
}
