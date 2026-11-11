// LangSmith 추적(선택). 연결이 없거나 실패해도 로컬 실행·기록·검토는 그대로 동작한다.
// 전송 항목: 실행 ID·단계·담당 코드·상태·시간·CLI가 보고한 비용/사용량·해시. 프롬프트 원문·산출물 내용·비밀값은 보내지 않는다.
import { Client } from 'langsmith';
import { RunTree } from 'langsmith/run_trees';
import type { Attempt, Run } from '../shared/types';
import { redact } from './cli/claudeCli';
import type { Tracer } from './engine/engine';

export function createTracer(cfg: () => { enabled: boolean; apiKey: string | null; endpoint: string; project: string }, log: (m: string) => void): Tracer {
  const trees = new Map<string, RunTree>();
  let client: Client | null = null; let clientKey = '';
  const getClient = () => {
    const c = cfg();
    if (!c.enabled || !c.apiKey) return null;
    const k = `${c.endpoint}|${c.apiKey.length}|${c.apiKey.slice(-4)}`;
    if (!client || k !== clientKey) { client = new Client({ apiKey: c.apiKey, apiUrl: c.endpoint || undefined, autoBatchTracing: false }); clientKey = k; }
    return client;
  };
  const safe = async (f: () => Promise<void>) => { try { await f(); } catch (e) { log(`LangSmith 전송 실패(로컬 기록은 유지): ${redact((e as Error).message)}`); } };
  return {
    runStarted(run: Run, meta: Record<string, unknown>) {
      const cl = getClient(); if (!cl) return;
      const t = new RunTree({ name: 'crewgenai-run', run_type: 'chain', id: run.id, project_name: cfg().project || 'crewgenai-agent-workspace', client: cl,
        inputs: { run_id: run.id, graph_version: run.graphVersion, plan_version: run.planVersion, executor: run.executor }, metadata: { ...meta, project: undefined } });
      trees.set(run.id, t);
      void safe(() => t.postRun());
    },
    attemptFinished(run: Run, a: Attempt, nodeLabel: string) {
      const t = trees.get(run.id); if (!t) return;
      const child = t.createChild({ name: `${nodeLabel}#${a.visit}-${a.attemptNo}`, run_type: a.role === 'check' ? 'tool' : 'llm',
        inputs: { node_id: a.nodeId, role: a.role, agent_version: a.agentVersion, prompt_sha256: a.promptHash },
        start_time: Date.parse(a.startedAt), metadata: { session_id: a.sessionId } });
      void safe(async () => {
        await child.postRun();
        await child.end({ status: a.status, exit_code: a.exitCode, result_subtype: a.resultSubtype, is_error: a.isError, cost_usd_reported: a.costUsd, usage: a.usage,
          permission_denials: a.permissionDenials.length, out_of_scope: a.outOfScopeChanges.length, changed_files: a.changedFiles.length,
          acceptance: a.acceptance?.checks.map((c) => ({ name: c.name, ok: c.ok })) }, a.status === 'succeeded' ? undefined : redact(a.error).slice(0, 300), Date.parse(a.finishedAt ?? new Date().toISOString()));
        await child.patchRun();
      });
    },
    runEnded(run: Run) {
      const t = trees.get(run.id); if (!t) return;
      if (['running', 'paused', 'queued'].includes(run.status)) return;
      if (run.status === 'review_wait' || run.status === 'on_hold' || run.status === 'needs_resume') return; // 진행 중인 실행은 열어 둔다
      trees.delete(run.id);
      void safe(async () => { await t.end({ status: run.status }, run.status === 'succeeded' ? undefined : redact(run.reason).slice(0, 300)); await t.patchRun(); });
    },
  };
}
