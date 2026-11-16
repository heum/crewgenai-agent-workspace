// 결과물 열기(미션 화면·사무실 공용): 화면 주소는 이 컴퓨터(localhost)만 기본 브라우저로,
// 이미지·HTML·PDF는 격리 미리보기 창, 문서·코드는 앱 안 보기, 그 밖(docx·xlsx 등)은 기본 앱으로 연다.
import { useState, type ReactNode } from 'react';
import { ws } from '../api';
import { Markdown } from '../markdown';
import { Modal } from './common';

export const PREVIEW_EXT = /\.(png|jpe?g|gif|webp|svg|html?|pdf)$/i;
// 앱 안에서 글로 보여 줄 형식(문서·코드·설정·기록)
export const TEXT_EXT = /\.(md|markdown|txt|log|csv|tsv|json|jsonc|ya?ml|toml|ini|properties|xml|gradle|kts?|java|scala|groovy|py|rb|go|rs|swift|c|h|cc|cpp|hpp|cs|php|sql|sh|bash|zsh|ts|tsx|js|jsx|mjs|cjs|css|scss|less|vue|svelte|graphql|proto|dockerfile)$/i;

export async function openDefaultApp(path: string) {
  const err = await ws().openPath(path);
  if (err) throw new Error(`기본 앱으로 열지 못했습니다(이 형식에 연결된 앱이 없음): ${err}`);
}

/** 결과물 열기 동작과 앱 안 보기 창. open()은 예외를 던지므로 useAction().run 안에서 부른다. */
export function useFileOpener(): { open: (path: string, kind?: 'file' | 'url', title?: string) => Promise<void>; viewer: ReactNode } {
  const [view, setView] = useState<{ title: string; path: string; text: string; md: boolean } | null>(null);
  const open = async (path: string, kind: 'file' | 'url' = 'file', title?: string) => {
    if (kind === 'url') { await ws().openLocalUrl(path); return; }
    if (PREVIEW_EXT.test(path)) { await ws().previewFile(path); return; }
    if (!TEXT_EXT.test(path)) { await openDefaultApp(path); return; }
    const text = await ws().readTextFile(path);
    setView({ title: title || path.split('/').pop() || path, path, text, md: /\.(md|markdown)$/i.test(path) });
  };
  const viewer = view ? (
    <Modal title={view.title} wide onClose={() => setView(null)}>
      <div className="row gap"><span className="muted small mono">{view.path}</span><button className="btn-link small" onClick={() => void openDefaultApp(view.path).catch(() => {})}>기본 앱으로 열기</button></div>
      <div className="result-view">{view.md ? <Markdown text={view.text} /> : <pre className="pre small">{view.text}</pre>}</div>
    </Modal>
  ) : null;
  return { open, viewer };
}
