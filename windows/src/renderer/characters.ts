// 직원 캐릭터 20종(이 앱에서 직접 만든 도트 그림). 같은 화풍·같은 크기(32×46칸)·같은 광원(왼쪽 위)으로 그린다.
// 색만 바꾼 것이 아니라 머리 모양·옷 종류·안경·헤드셋·수염으로 작은 크기에서도 구분되게 했다.
import { defaultCharacter } from '../shared/characterIds';
export { defaultCharacter };
// 자세: stand(서 있기), sit(앉기·대기), type(타자 — 손 두 장면), review(문서 들고 검토), rest(눈 감고 쉼).

export type Hair = 'short' | 'sidepart' | 'messy' | 'long' | 'wavy' | 'ponytail' | 'bun' | 'bob' | 'afro' | 'curly' | 'bald' | 'braid' | 'curlbun' | 'spiky';
export type Top = 'jacket' | 'hoodie' | 'knit' | 'shirt' | 'cardigan' | 'vest' | 'blouse';
export type Extra = 'glassesRound' | 'glassesSquare' | 'headset' | 'beard' | 'mustache' | 'clip';
export interface CharDef { id: string; name: string; skin: string; hair: string; hairStyle: Hair; top: string; topStyle: Top; pants: string; extras: Extra[]; inner?: string }

export const CHARACTERS: CharDef[] = [
  { id: 'C01', name: '네이비 재킷', skin: '#f2c6a0', hair: '#2a2a33', hairStyle: 'sidepart', top: '#2c3e6b', topStyle: 'jacket', inner: '#f4f1ea', pants: '#2f3442', extras: [] },
  { id: 'C02', name: '코랄 후디', skin: '#f4cdb0', hair: '#a8492e', hairStyle: 'wavy', top: '#ec7a64', topStyle: 'hoodie', pants: '#3a3f4c', extras: [] },
  { id: 'C03', name: '민트 니트', skin: '#f0c49c', hair: '#1f2a33', hairStyle: 'messy', top: '#7fcfae', topStyle: 'knit', pants: '#2f3a4f', extras: [] },
  { id: 'C04', name: '크림 가디건', skin: '#f4cdb0', hair: '#6b3f24', hairStyle: 'long', top: '#efe3c4', topStyle: 'cardigan', inner: '#7d5a3c', pants: '#5a4634', extras: [] },
  { id: 'C05', name: '올리브 셔츠', skin: '#b67a52', hair: '#2a1d16', hairStyle: 'bald', top: '#6f7d3c', topStyle: 'shirt', pants: '#c9b38a', extras: ['beard'] },
  { id: 'C06', name: '라벤더 셔츠', skin: '#f0c8a6', hair: '#b9b7b4', hairStyle: 'short', top: '#b8a6dc', topStyle: 'shirt', pants: '#3a3f4c', extras: ['glassesRound'] },
  { id: 'C07', name: '데님 재킷', skin: '#f2c6a0', hair: '#5a3420', hairStyle: 'ponytail', top: '#4f78b0', topStyle: 'jacket', inner: '#f4f1ea', pants: '#2f3442', extras: [] },
  { id: 'C08', name: '머스터드 니트', skin: '#8a5636', hair: '#1c1512', hairStyle: 'afro', top: '#e0a63a', topStyle: 'knit', pants: '#3a3f4c', extras: ['glassesRound'] },
  { id: 'C09', name: '스카이 셔츠', skin: '#f2c6a0', hair: '#24242c', hairStyle: 'bun', top: '#9fcbea', topStyle: 'shirt', pants: '#3a4152', extras: [] },
  { id: 'C10', name: '와인 가디건', skin: '#f4cdb0', hair: '#a5432a', hairStyle: 'wavy', top: '#7d2a3c', topStyle: 'cardigan', inner: '#f1ece2', pants: '#3a3f4c', extras: [] },
  { id: 'C11', name: '차콜 후디', skin: '#f0c49c', hair: '#1a1d24', hairStyle: 'spiky', top: '#3b3f48', topStyle: 'hoodie', pants: '#55595f', extras: ['headset'] },
  { id: 'C12', name: '세이지 조끼', skin: '#f2c6a0', hair: '#7a4a2a', hairStyle: 'sidepart', top: '#8fa77a', topStyle: 'vest', inner: '#f4f1ea', pants: '#b59c74', extras: [] },
  { id: 'C13', name: '피치 블라우스', skin: '#f4cdb0', hair: '#3a2420', hairStyle: 'bob', top: '#f2b29a', topStyle: 'blouse', pants: '#3a3f4c', extras: ['clip'] },
  { id: 'C14', name: '인디고 셔츠', skin: '#9a6440', hair: '#1c1512', hairStyle: 'curly', top: '#3d4f9c', topStyle: 'shirt', pants: '#c9b38a', extras: [] },
  { id: 'C15', name: '아이보리 셔츠', skin: '#f0c8a6', hair: '#c9c6c0', hairStyle: 'short', top: '#f1ece0', topStyle: 'shirt', pants: '#3a3f4c', extras: ['mustache'] },
  { id: 'C16', name: '테라코타 셔츠', skin: '#8a5636', hair: '#2a1a12', hairStyle: 'curlbun', top: '#c8643c', topStyle: 'shirt', pants: '#f1ece0', extras: [] },
  { id: 'C17', name: '틸 재킷', skin: '#f2c6a0', hair: '#18181e', hairStyle: 'braid', top: '#2a8a86', topStyle: 'jacket', inner: '#f4f1ea', pants: '#2f3442', extras: [] },
  { id: 'C18', name: '베이지 니트', skin: '#f4cdb0', hair: '#e6c06a', hairStyle: 'messy', top: '#dcc9a4', topStyle: 'knit', pants: '#3a4b6e', extras: [] },
  { id: 'C19', name: '플럼 니트', skin: '#f0c49c', hair: '#5a3a6e', hairStyle: 'short', top: '#7a3f66', topStyle: 'knit', pants: '#3a3f4c', extras: ['glassesRound'] },
  { id: 'C20', name: '블루 후디', skin: '#f2c6a0', hair: '#1a1d24', hairStyle: 'messy', top: '#3f72c8', topStyle: 'hoodie', pants: '#c9b38a', extras: ['glassesSquare'] },
];
// 외부 Codex 리뷰어(직원 아님): 후드를 쓴 모습으로 직원과 구분
export const EXTERNAL: CharDef[] = [
  { id: 'X1', name: 'Codex 리뷰어', skin: '#f2c6a0', hair: '#5b4bb5', hairStyle: 'short', top: '#5b4bb5', topStyle: 'hoodie', pants: '#2a2a33', extras: ['glassesSquare'] },
  { id: 'X2', name: 'Codex 리뷰어', skin: '#c48a5e', hair: '#1f8f8f', hairStyle: 'short', top: '#1f8f8f', topStyle: 'hoodie', pants: '#2a2a33', extras: ['glassesSquare'] },
  { id: 'X3', name: 'Codex 리뷰어', skin: '#e3ad86', hair: '#b5603b', hairStyle: 'short', top: '#b5603b', topStyle: 'hoodie', pants: '#2a2a33', extras: ['glassesSquare'] },
];
export const charById = (id: string | undefined | null) => CHARACTERS.find((c) => c.id === id) ?? EXTERNAL.find((c) => c.id === id) ?? null;

export function characterOf(a: { code: string; name: string; role: string; character?: string | null }): CharDef {
  return charById(a.character) ?? charById(defaultCharacter(a))!;
}

// 그림은 ../art.ts(char2)가 그린다.
