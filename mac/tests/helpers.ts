// 시험 도구 — 모의 CLI(resources/mock-claude.cjs)로 흐름·오류·복구를 검사한다. 실제 Claude 연결 검사와 구분한다.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentFields, GraphEdge, GraphNode, LiveEvent, PlanFields, Run } from '../src/shared/types';
import { Service } from '../src/main/service';

export const MOCK = resolve(__dirname, '../resources/mock-claude.cjs');
export const MOCK_CODEX = resolve(__dirname, '../resources/mock-codex.cjs');

export function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'crewgenai 시험 '));
  const proj = join(root, '프로젝트 폴더 A');
  mkdirSync(proj, { recursive: true });
  return proj;
}

export function plan(folder: string, extra: Partial<PlanFields> = {}): PlanFields {
  return { name: '시험 프로젝트', goal: '시험 목표', folder, referenceDocs: [], priorOutputs: [], deliverable: '결과 보고서', doneCriteria: '산출물 존재',
    writablePaths: ['docs', 'src'], scope: '시험', outputDir: 'out', ...extra };
}

export function mkService(dir: string, events: LiveEvent[] = [], extra: Partial<ConstructorParameters<typeof Service>[0]> = {}) {
  const svc = new Service({ dbFile: join(dir, '..', `db-${randomUUID().slice(0, 6)}.sqlite`), mockScript: MOCK, mockCodexScript: MOCK_CODEX, emit: (e) => events.push(e), ...extra });
  svc.saveSettings({ executor: 'mock', maxConcurrent: 3 });
  return svc;
}

export function agentFields(code: string, name: string, extra: Partial<AgentFields> = {}): AgentFields {
  return { code, name, role: name, instructions: `${name} 지시`, references: [], workPaths: [], tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], allowedCommands: [],
    expectedOutput: '', doneCriteria: '산출물 작성', reviewerAgentId: null, model: '', maxBudgetUsd: null, timeoutSec: 60, maxRetries: 0, active: true, ...extra };
}

export function n(kind: GraphNode['kind'], label: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id: `${kind}-${label}`, kind, label, position: { x: 0, y: 0 }, agentId: null, reviewerAgentId: null, instructions: `${label} 지시`, inputs: [], useUpstreamOutputs: true,
    outputs: [], doneCriteria: '', command: [], writeScope: [], maxRetries: 0, maxVisits: 3, timeoutSec: 60, condition: null, entryCondition: 'all', ...extra };
}
export function e(s: GraphNode, t: GraphNode, kind: GraphEdge['kind'] = 'next'): GraphEdge { return { id: randomUUID(), source: s.id, target: t.id, kind }; }

export async function waitRun(svc: Service, runId: string, statuses: Run['status'][], ms = 40000): Promise<Run> {
  const t0 = Date.now();
  for (;;) {
    const r = svc.store.getRun(runId);
    if (statuses.includes(r.status) && !svc.engine.isActive(runId)) return r;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: 상태 ${r.status} (${r.reason})`);
    await new Promise((res) => setTimeout(res, 50));
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

/** 시험 프로젝트를 git 저장소로 만들고 첫 커밋을 남긴다(운영 지시 필수 항목). */
export function gitInit(dir: string) {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const { writeFileSync } = require('node:fs') as typeof import('node:fs');
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'tester@example.com'); g('config', 'user.name', '시험 사용자');
  writeFileSync(require('node:path').join(dir, 'README.md'), '# 시험 저장소\n');
  g('add', '-A'); g('commit', '-q', '-m', '초기');
  return g;
}
