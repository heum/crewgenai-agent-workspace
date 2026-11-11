// 최소 마크다운 렌더러 — React 요소로만 만들며 HTML 문자열을 주입하지 않는다(자동 이스케이프).
import { Fragment, type ReactNode } from 'react';

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // `code`, **bold**, [label](url) — 링크는 텍스트로만 표시(외부 이동 없음)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      out.push(
        <span key={k} className="md-link" title={lm?.[2]}>
          {lm?.[1] ?? tok}
        </span>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, images }: { text: string; images?: Record<string, string> }) {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      blocks.push(<pre key={key++} className="md-pre">{buf.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 1, 6);
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={key++}>{inline(h[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div className="md-table-wrap" key={key++}>
          <table className="md-table">
            {head && (
              <thead>
                <tr>{head.map((c, j) => <th key={j}>{inline(c, `th${key}-${j}`)}</th>)}</tr>
              </thead>
            )}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `td${key}-${ri}-${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i++;
      }
      const L = ordered ? 'ol' : 'ul';
      blocks.push(
        <L key={key++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `li${key}-${j}`)}</li>
          ))}
        </L>,
      );
      continue;
    }
    // 이미지: 한 줄 전체가 ![설명](images/파일.png)일 때만. 앱이 넘겨 준 목록에 있는 이름만 표시한다.
    const img = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line.trim());
    if (img) {
      const src = images?.[img[2]];
      blocks.push(
        <figure className="md-figure" key={key++}>
          {src ? <img src={src} alt={img[1]} loading="lazy" /> : <div className="md-figure-missing">이미지 없음: {img[2]}</div>}
          {img[1] && <figcaption>{img[1]}</figcaption>}
        </figure>,
      );
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      blocks.push(<blockquote key={key++}>{inline(line.replace(/^>\s?/, ''), `q${key}`)}</blockquote>);
      i++;
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const para: string[] = [lines[i++]]; // 어떤 블록에도 해당하지 않는 줄은 문단으로 소비해 반복이 항상 진행되게 한다
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|```|\s*\||\s*([-*]|\d+\.)\s|>)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join(' '), `p${key}`)}</p>);
  }
  return <div className="md">{blocks.map((b, j) => <Fragment key={j}>{b}</Fragment>)}</div>;
}
