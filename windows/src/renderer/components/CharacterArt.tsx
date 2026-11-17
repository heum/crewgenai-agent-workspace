// 캐릭터 그림(도트) — 직원 목록·상세·사무실·선택 팝업이 같은 그림(../art.ts)을 쓴다.
// 크기는 그림 한 칸이 화면 화소 정수 개가 되도록 맞춘다(가장자리가 고르게).
import { useState } from 'react';
import { char2, CHAR2_H, CHAR2_SIT_H, CHAR2_W, charHead, HEAD_H, HEAD_W, type ArtPose } from '../art';
import { CHARACTERS, charById, type CharDef } from '../characters';
import { toPaths } from '../pixel';
import { Modal } from './common';

/** 따로 쓰는 캐릭터 그림. size는 원하는 대략의 높이(px)로, 실제로는 그 이하의 정수 배율로 그린다. head면 얼굴만(목록용). */
export function CharSprite({ def, pose = 'stand', size, head }: { def: CharDef; pose?: ArtPose; size: number; head?: boolean }) {
  const w = head ? HEAD_W : CHAR2_W; const h = head ? HEAD_H : pose === 'stand' ? CHAR2_H : CHAR2_SIT_H;
  const k = Math.max(1, Math.floor(size / h));
  const rects = head ? charHead(def) : char2(def, pose);
  return (
    <svg className="char-sprite" width={w * k} height={h * k} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" aria-hidden="true">
      {toPaths(rects).map((p) => <path key={p.fill} fill={p.fill} d={p.d} />)}
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
              <CharSprite def={c} size={96} />
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
