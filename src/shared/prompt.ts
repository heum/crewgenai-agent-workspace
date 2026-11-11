// 권장 문서 템플릿 본문 해석 — 화면과 메인 프로세스가 같은 규칙을 쓴다.

/** 템플릿 본문에서 '운영 탭에 붙여넣을 지시문' 부분만 뽑는다(없으면 전체) */
export function instructionPart(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+운영 탭에 붙여넣을 지시문/.test(l.trim()));
  if (start < 0) return body.trim();
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  let part = lines.slice(start + 1, end);
  const f1 = part.findIndex((l) => l.trim().startsWith('```'));
  if (f1 >= 0) {
    const rest = part.slice(f1 + 1);
    const f2 = rest.findIndex((l) => l.trim().startsWith('```'));
    part = f2 >= 0 ? rest.slice(0, f2) : rest;
  }
  return part.join('\n').trim();
}
