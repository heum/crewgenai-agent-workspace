import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceApi } from '../shared/types';

export const ws = (): WorkspaceApi => {
  if (!window.workspace) throw new Error('앱 연결(preload)을 찾을 수 없습니다. 앱을 다시 실행하세요.');
  return window.workspace;
};

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    // Electron IPC 오류 접두어 정리
    return e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  return String(e);
}

/** 비동기 데이터 로딩: loading/error/data/reload */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const v = await fn();
      if (my === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(errMsg(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, setData, loading, error, reload };
}

/** 버튼 동작 실행: busy/error 관리 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errMsg(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString('ko-KR', { hour12: false });
}

export function baseName(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

export const uid = (prefix = 'n') => `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;

/** 한글 IME 조합 중 Enter 무시 */
export function isComposingEnter(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && (e.nativeEvent as KeyboardEvent).isComposing;
}
