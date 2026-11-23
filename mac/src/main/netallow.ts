// 직원의 격리 실행 환경에서 나가는 접속을 허용할 주소(호스트 이름) 검사.
// 기본은 모두 막힘이다. 사용자가 확인함에서 직원 한 명에게 주소 하나씩 허용한 것만 연다.
// 넓게 여는 표기(와일드카드·IP·내부망 이름·포트·경로)는 받지 않는다: "전부 허용"으로 가는 길을 만들지 않는다.

/** 직원 한 명에게 허용할 수 있는 주소 수 */
export const MAX_DOMAINS = 10;

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const INTERNAL = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|example|invalid|onion)$/;

/** 입력을 호스트 이름 하나로 정리한다. 허용할 수 없는 표기면 null. */
export function cleanDomain(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || s.length > 253) return null;
  if (/[\s*/:@?#\\]/.test(s)) return null; // 와일드카드·경로·포트·계정 표기는 받지 않는다(https:// 를 붙인 것도 거절)
  if (!HOST.test(s)) return null; // IP 주소와 한 단어 이름은 여기서 걸린다(끝이 글자로 된 최상위 도메인이어야 함)
  if (INTERNAL.test(s)) return null;
  return s;
}

/** 저장된 목록을 실행에 쓸 때 다시 한 번 거른다(손으로 고친 값·예전 값 대비) */
export function cleanDomains(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(cleanDomain).filter((x): x is string => !!x))].slice(0, MAX_DOMAINS);
}
