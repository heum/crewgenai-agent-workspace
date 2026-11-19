// 참고 사이트 스냅샷: 주소 검사와 저장 위치(앱 데이터 폴더 안, 저장소에 들어가지 않음)
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** 참고 사이트 주소인가: 공개 http(s) 주소만(이 컴퓨터·사설망 주소는 막는다) */
export function publicWebUrl(u: string): boolean {
  let x: URL; try { x = new URL(u); } catch { return false; }
  if (x.protocol !== 'https:' && x.protocol !== 'http:') return false;
  if (x.username || x.password) return false;
  const h = x.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)) return false;
  if (h.includes(':')) return false; // IPv6 주소 직접 지정은 막는다
  return true;
}

/** 스냅샷 폴더: <참고 자료 폴더>/<미션 앞 8자리>/<호스트>-<주소 해시> */
export function refDirFor(root: string, missionId: string, url: string): string {
  let host = 'site'; try { host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_').slice(0, 60); } catch { /* 기본값 */ }
  return join(root, missionId.slice(0, 8), `${host}-${createHash('sha256').update(url).digest('hex').slice(0, 8)}`);
}
