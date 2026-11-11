// 권장 기획 문서 템플릿 미리보기 — 기획 탭 '완성 문서 목록'에서 문서별 지시문을 보고, '지시창에 넣기'로 운영 탭 지시 칸에 채운다.
import { useState } from 'react';
import type { PromptTemplate } from '../../shared/types';

import { Modal } from './common';
import { Markdown } from '../markdown';
import { instructionPart } from '../../shared/prompt';
export { instructionPart };

export function TemplateModal({ t, onClose, onUse, onBack, instruction, useLabel = '지시창에 넣기' }: { t: PromptTemplate; onClose: () => void; onUse?: (text: string) => void; onBack?: () => void; instruction?: string; useLabel?: string }) {
  const [raw, setRaw] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(t.body);
      setMsg('복사했습니다');
    } catch (e) {
      setMsg(`복사하지 못했습니다: ${(e as Error).message}`);
    }
  };
  return (
    <Modal title={t.title} onClose={onClose} wide>
      <div className="row gap wrap template-actions">
        {onBack && <button className="btn" onClick={onBack}>← 목록</button>}
        <button className="btn btn-primary" onClick={() => void copy()}>프롬프트 복사</button>
        {onUse && <button className="btn" onClick={() => onUse(instruction ?? instructionPart(t.body))}>{useLabel}</button>}
        <button className="btn" onClick={() => setRaw((v) => !v)}>{raw ? '문서로 보기' : '원문(MD) 보기'}</button>
        {msg && <span className="small ok-line">{msg}</span>}
      </div>
      {t.output && <div className="muted small">산출물: <span className="mono">{t.output}</span></div>}
      <div className="template-preview">{raw ? <pre className="pre small">{t.body}</pre> : <Markdown text={t.body} />}</div>
    </Modal>
  );
}

