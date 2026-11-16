// 직원 캐릭터 번호(C01~C20)와 직군별 기본 배정. 직원 번호(code)와 캐릭터 번호는 따로 관리한다.
// 외형은 역할·권한·모델·업무 지시와 별개다(화면 표시에만 쓰인다).
export const CHARACTER_IDS = Array.from({ length: 20 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);

const BY_CODE: Record<string, string> = { '00': 'C01', '01': 'C04', '02': 'C06', '03': 'C03', '04': 'C07', '05': 'C08', '06': 'C12', '07': 'C17', '08': 'C15', '09': 'C20', '10': 'C09', '11': 'C11' };
const BY_WORD: [RegExp, string][] = [
  [/총괄|오퍼레이터|팀장/, 'C01'], [/기획|요구|분석|조사/, 'C04'], [/설계|아키텍/, 'C06'], [/백엔드|서버/, 'C03'], [/프런트|프론트|화면|UI/i, 'C07'],
  [/데이터|DB/i, 'C08'], [/문서/, 'C12'], [/보안|권한/, 'C17'], [/리뷰|검토|검수/, 'C15'], [/시험|품질|QA|검증/i, 'C20'], [/통합|결과물/, 'C09'], [/인프라|운영|배포/, 'C11'],
];
/** 직군에 어울리는 기본 캐릭터: 이름 → 역할 낱말 → 기본 템플릿 번호 → 이름으로 고르게 */
export function defaultCharacter(a: { code: string; name: string; role: string }): string {
  const w = BY_WORD.find(([re]) => re.test(a.name)) ?? BY_WORD.find(([re]) => re.test(a.role));
  if (w) return w[1];
  if (BY_CODE[a.code]) return BY_CODE[a.code];
  let h = 7; for (const c of `${a.code}:${a.name}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CHARACTER_IDS[h % CHARACTER_IDS.length];
}
export const isCharacterId = (v: unknown): v is string => typeof v === 'string' && CHARACTER_IDS.includes(v);
