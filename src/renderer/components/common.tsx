import { useEffect, useState, type ReactNode } from 'react';
import { baseName, errMsg, isComposingEnter } from '../api';

export function Banner({ kind = 'error', children, onClose }: { kind?: 'error' | 'warn' | 'info' | 'ok'; children: ReactNode; onClose?: () => void }) {
  if (!children) return null;
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div>{children}</div>
      {onClose && (
        <button className="btn-link" onClick={onClose} aria-label="닫기">
          닫기
        </button>
      )}
    </div>
  );
}

export function Loading({ text = '불러오는 중…' }: { text?: string }) {
  return <div className="loading">{text}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <div className="sub">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** 경로 목록(선택 버튼으로 추가, 제거 가능). 직접 입력은 보조 수단으로만 */
export function PathList({
  items,
  onChange,
  onPick,
  pickLabel,
  allowTyping,
  placeholder,
  emptyText = '선택된 항목 없음',
  showFull,
}: {
  items: string[];
  onChange: (v: string[]) => void;
  onPick?: () => Promise<string[] | string | null>;
  pickLabel?: string;
  allowTyping?: boolean;
  placeholder?: string;
  emptyText?: string;
  showFull?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [pickErr, setPickErr] = useState<string | null>(null);
  const add = (vals: string[]) => {
    const next = [...items];
    for (const v of vals) if (v && !next.includes(v)) next.push(v);
    onChange(next);
  };
  return (
    <div className="pathlist">
      {pickErr && <div className="error-text small">{pickErr}</div>}
      {items.length === 0 && <div className="muted small">{emptyText}</div>}
      {items.map((p, i) => (
        <div className="pathlist-item" key={`${p}-${i}`} title={p}>
          <span className="mono">{showFull ? p : baseName(p) === p ? p : `${baseName(p)}`}</span>
          {!showFull && baseName(p) !== p && <span className="muted small ellipsis">{p}</span>}
          <button className="btn-link danger" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            제거
          </button>
        </div>
      ))}
      <div className="row gap">
        {onPick && (
          <button
            className="btn"
            onClick={async () => {
              setPickErr(null);
              try {
                const r = await onPick();
                if (!r) return;
                add(Array.isArray(r) ? r : [r]);
              } catch (e) {
                setPickErr(errMsg(e));
              }
            }}
          >
            {pickLabel ?? '선택…'}
          </button>
        )}
        {allowTyping && (
          <>
            <input
              className="input grow"
              value={draft}
              placeholder={placeholder}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingEnter(e)) return;
                if (e.key === 'Enter' && draft.trim()) {
                  add([draft.trim()]);
                  setDraft('');
                }
              }}
            />
            <button
              className="btn"
              disabled={!draft.trim()}
              onClick={() => {
                add([draft.trim()]);
                setDraft('');
              }}
            >
              추가
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** 줄 단위 텍스트 ↔ 배열 */
export function LinesInput({ value, onChange, rows = 3, placeholder }: { value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string }) {
  const [text, setText] = useState(value.join('\n'));
  const parsed = text.split('\n').map((s) => s.trim()).filter((s) => s !== '').join('\n');
  const joined = value.join('\n');
  useEffect(() => {
    // 외부에서 값이 바뀐 경우(다른 노드 선택 등)에만 동기화
    if (joined !== parsed) setText(joined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return (
    <textarea
      className="input mono"
      rows={rows}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        const arr = e.target.value.split('\n').map((s) => s.trim()).filter((s) => s !== '');
        onChange(arr);
      }}
    />
  );
}

export function NumberInput({ value, onChange, min = 0, step = 1, allowNull }: { value: number | null; onChange: (v: number | null) => void; min?: number; step?: number; allowNull?: boolean }) {
  return (
    <input
      className="input"
      type="number"
      min={min}
      step={step}
      value={value ?? ''}
      placeholder={allowNull ? '제한 없음' : undefined}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(allowNull ? null : min);
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'mock'; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Collapsible({ title, children, defaultOpen }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="collapsible" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
