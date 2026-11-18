// 확인함 항목의 내용 식별값(앱 화면·텔레그램 공통): 질문·선택지가 바뀌면 달라진다. 오래된 버튼·선택이 바뀐 항목에 적용되지 않게 한다.
export function decisionVersion(it: { key: string; question: string; choices: { label: string; effect: string }[] }): string {
  let h = 0; const s = `${it.key}\u0000${it.question}\u0000${it.choices.map((c) => `${c.label}\u0001${c.effect}`).join('\u0002')}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
