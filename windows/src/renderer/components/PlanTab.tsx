import { useState } from 'react';
import type { PlanFields, Project } from '../../shared/types';
import { fmtDate, useAction, useLoad, ws } from '../api';
import { Badge, Banner, Field, Loading, PathList } from './common';
import { DocSetLauncher } from './DocSetPanel';

const EMPTY: PlanFields = {
  name: '',
  goal: '',
  folder: '',
  referenceDocs: [],
  priorOutputs: [],
  deliverable: '',
  doneCriteria: '',
  writablePaths: [],
  scope: '',
  outputDir: 'crewgenai-output',
};

const FIELD_LABEL: Record<string, string> = {
  name: '이름',
  goal: '목표',
  folder: '연결 폴더',
  referenceDocs: '참고 문서',
  priorOutputs: '기존 Claude 산출물',
  deliverable: '최종 결과물',
  doneCriteria: '완료 조건',
  writablePaths: '자동 수정 허용 경로',
  scope: '작업 범위',
  outputDir: '산출물 위치',
};

export default function PlanTab({ project, onSaved, onUseTemplate }: { project: Project | null; onSaved: (p: Project) => void; onUseTemplate?: (instruction: string) => void }) {
  const [plan, setPlan] = useState<PlanFields>(project ? { ...EMPTY, ...project.plan } : EMPTY);
  const act = useAction();
  const [saved, setSaved] = useState<string | null>(null);
  const set = <K extends keyof PlanFields>(k: K, v: PlanFields[K]) => {
    setPlan((p) => ({ ...p, [k]: v }));
    setSaved(null);
  };
  const dirty = project ? JSON.stringify({ ...EMPTY, ...project.plan }) !== JSON.stringify(plan) : true;
  const canSave = plan.name.trim() !== '' && plan.folder !== '';

  const save = () =>
    act.run(async () => {
      const p = project ? await ws().updatePlan(project.id, plan) : await ws().createProject(plan);
      setSaved(project ? `기획 v${p.planVersion}로 저장했습니다. 이미 실행 중인 작업은 시작 당시 버전을 계속 사용합니다.` : '프로젝트를 만들었습니다.');
      onSaved(p);
    });

  return (
    <div className="split">
      <section className="panel grow">
        {act.error && <Banner>{act.error}</Banner>}
        {saved && <Banner kind="ok">{saved}</Banner>}
        <div className="form-grid">
          <Field label="프로젝트 이름 *">
            <input className="input" value={plan.name} onChange={(e) => set('name', e.target.value)} placeholder="예: 조달크루 G1 무료 서비스" />
          </Field>
          <Field label="연결할 로컬 폴더·저장소 *" hint="폴더 선택 창에서 고릅니다. 저장소 하나 또는 여러 저장소를 담은 상위 폴더(예: GitHub)를 고를 수 있습니다. 상위 폴더에는 git init을 하지 마세요.">
            <div className={`path-box mono ${plan.folder ? '' : 'muted'}`} title={plan.folder}>
              {plan.folder || '선택된 폴더 없음'}
            </div>
            <div className="row gap path-actions">
              <button
                className="btn"
                onClick={() =>
                  act.run(async () => {
                    const f = await ws().pickFolder();
                    if (f) set('folder', f);
                  })
                }
              >
                폴더 선택…
              </button>
              {plan.folder && (
                <button className="btn" onClick={() => act.run(() => ws().revealInFinder(plan.folder))}>
                  탐색기에서 열기
                </button>
              )}
              {plan.folder && (
                <button className="btn" onClick={() => act.run(() => navigator.clipboard.writeText(plan.folder))}>
                  경로 복사
                </button>
              )}
            </div>
          </Field>
          <Field label="목표">
            <textarea className="input" rows={3} value={plan.goal} onChange={(e) => set('goal', e.target.value)} placeholder="이번 프로젝트로 이루려는 것" />
          </Field>
          <Field label="원하는 최종 결과물">
            <textarea className="input" rows={3} value={plan.deliverable} onChange={(e) => set('deliverable', e.target.value)} />
          </Field>
          <Field label="완료 조건">
            <textarea className="input" rows={3} value={plan.doneCriteria} onChange={(e) => set('doneCriteria', e.target.value)} placeholder="예: npm test 통과, 보고서에 검증 근거 포함" />
          </Field>
          <Field label="작업 범위">
            <textarea className="input" rows={3} value={plan.scope} onChange={(e) => set('scope', e.target.value)} placeholder="포함·제외할 작업" />
          </Field>
          <Field label="참고 문서">
            <PathList items={plan.referenceDocs} onChange={(v) => set('referenceDocs', v)} onPick={() => ws().pickFiles()} pickLabel="파일 선택…" />
          </Field>
          <Field label="기존 Claude 산출물" hint="직접 선택한 문서·코드·보고서만 연결합니다. 대화 기록·인증 자료는 수집하지 않습니다.">
            <PathList items={plan.priorOutputs} onChange={(v) => set('priorOutputs', v)} onPick={() => ws().pickFiles()} pickLabel="파일 선택…" />
          </Field>
          <Field label="자동 수정 허용 경로" hint="프로젝트 폴더 기준 상대 경로. Agent의 파일 수정은 실행 단계에서 이 범위로 제한됩니다. 상위 폴더를 연결했다면 jodalCrew/src처럼 저장소 이름부터 적습니다.">
            <PathList
              items={plan.writablePaths}
              onChange={(v) => set('writablePaths', v)}
              showFull
              onPick={async () => {
                if (!plan.folder) throw new Error('먼저 프로젝트 폴더를 선택하세요.');
                return ws().pickSubfolder(plan.folder);
              }}
              pickLabel="하위 폴더 선택…"
              emptyText="없음 — Agent가 파일을 수정할 수 없습니다"
            />
          </Field>
          <Field label="산출물 기본 위치" hint="프로젝트 폴더 기준 상대 경로">
            <input className="input mono" value={plan.outputDir} onChange={(e) => set('outputDir', e.target.value)} />
          </Field>
        </div>
        <div className="row gap end sticky-bottom">
          {project && <span className="grow"><DocSetLauncher project={project} /></span>}
          {!canSave && <span className="muted small">이름과 폴더를 입력해야 저장할 수 있습니다.</span>}
          <button className="btn btn-primary" disabled={!canSave || !dirty || act.busy} onClick={save}>
            {act.busy ? '저장 중…' : project ? '기획 저장(새 버전)' : '프로젝트 만들기'}
          </button>
        </div>
      </section>
      {project && <PlanHistory projectId={project.id} version={project.planVersion} />}
    </div>
  );
}

function PlanHistory({ projectId, version }: { projectId: string; version: number }) {
  const hist = useLoad(() => ws().planHistory(projectId), [projectId, version]);
  return (
    <aside className="panel side-panel">
      <h3>변경 이력</h3>
      {hist.loading && <Loading />}
      {hist.error && <Banner>{hist.error}</Banner>}
      {hist.data && hist.data.length === 0 && <div className="muted small">이력이 없습니다.</div>}
      <ol className="history">
        {hist.data
          ?.slice()
          .sort((a, b) => b.version - a.version)
          .map((h) => (
            <li key={h.version}>
              <div className="row gap">
                <Badge tone={h.version === version ? 'info' : 'neutral'}>v{h.version}</Badge>
                <span className="small muted">{fmtDate(h.createdAt)}</span>
              </div>
              <div className="small">
                {h.changedFields.length ? h.changedFields.map((f) => FIELD_LABEL[f] ?? f).join(', ') : '최초 작성'}
              </div>
            </li>
          ))}
      </ol>
    </aside>
  );
}
