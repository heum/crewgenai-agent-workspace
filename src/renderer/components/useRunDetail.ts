import { useEffect, useRef } from 'react';
import type { LiveEvent } from '../../shared/types';
import { useLoad, ws } from '../api';

/** 실행 상세를 불러오고 실시간 이벤트가 오면 ~300ms 간격으로 다시 불러온다. */
export function useRunDetail(runId: string | null) {
  const detail = useLoad(() => (runId ? ws().runDetail(runId) : Promise.resolve(null)), [runId]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef(detail.reload);
  reloadRef.current = detail.reload;

  useEffect(() => {
    if (!runId) return;
    const off = ws().onLive((e: LiveEvent) => {
      const hit =
        (e.type === 'run' && e.run.id === runId) ||
        (e.type === 'node' && e.state.runId === runId) ||
        (e.type === 'attempt' && e.attempt.runId === runId);
      if (!hit) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reloadRef.current(), 300);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [runId]);
  return detail;
}

/** 프로젝트의 실행 목록을 실시간으로 갱신 */
export function useRunList(projectId: string) {
  const runs = useLoad(() => ws().listRuns(projectId), [projectId]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef(runs.reload);
  reloadRef.current = runs.reload;
  useEffect(() => {
    const off = ws().onLive((e: LiveEvent) => {
      if (e.type !== 'run' || e.run.projectId !== projectId) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reloadRef.current(), 300);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [projectId]);
  return runs;
}
