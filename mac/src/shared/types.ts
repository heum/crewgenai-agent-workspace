// 공통 계약 — main(실행·저장)과 renderer(화면)가 함께 사용한다.
// 이 파일의 타입이 IPC 경계의 단일 기준이다.

export type ID = string;

// ───────── 프로젝트·기획 ─────────
export interface PlanFields {
  name: string;
  goal: string;
  folder: string; // 연결한 로컬 폴더(절대 경로)
  referenceDocs: string[]; // 참고 문서(절대 경로)
  priorOutputs: string[]; // 기존 Claude 산출물(사용자가 선택한 파일만)
  deliverable: string; // 원하는 최종 결과물
  doneCriteria: string; // 완료 조건
  writablePaths: string[]; // 자동 수정 허용 경로(프로젝트 기준 상대 경로, 예: "docs", "src/app")
  scope: string; // 작업 범위 설명
  outputDir: string; // 산출물 기본 위치(프로젝트 기준 상대 경로)
}

export interface Project {
  id: ID;
  plan: PlanFields;
  planVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanVersion {
  projectId: ID;
  version: number;
  plan: PlanFields;
  changedFields: string[];
  createdAt: string;
}

// ───────── Agent 직원 ─────────
export type ToolName = 'Read' | 'Grep' | 'Glob' | 'Edit' | 'Write' | 'Bash' | 'WebFetch';

export interface AgentFields {
  code: string; // "01" 등 표시 번호
  name: string;
  role: string;
  instructions: string;
  references: string[]; // 참조 자료(절대 경로)
  workPaths: string[]; // 작업 가능한 폴더(프로젝트 기준 상대 경로). 비어 있으면 기획의 writablePaths
  tools: ToolName[];
  allowedCommands: string[]; // Bash 허용 명령 접두어(예: "npm test", "git diff")
  expectedOutput: string;
  doneCriteria: string;
  reviewerAgentId: ID | null; // 독립 검토 담당
  model: string; // 빈 값이면 CLI 기본
  maxBudgetUsd: number | null; // CLI --max-budget-usd
  timeoutSec: number;
  maxRetries: number;
  active: boolean;
}

export interface Agent extends AgentFields {
  id: ID;
  projectId: ID;
  version: number;
  updatedAt: string;
  fired?: boolean; // 해고한 직원(기록 표시용 목록에서만 나온다)
}

// ───────── 업무 그래프 ─────────
export type NodeKind = 'input' | 'agent' | 'check' | 'review' | 'codexReview' | 'branch' | 'merge' | 'userReview';
export type EdgeKind = 'next' | 'fail' | 'true' | 'false';

export interface OutputSpec {
  path: string; // 프로젝트 기준 상대 경로
  format: 'markdown' | 'json' | 'html' | 'text' | 'code' | 'image' | 'any';
  required: boolean;
}

export interface BranchCondition {
  // 앞 단계 결과로 분기: 대상 노드의 상태, 또는 JSON 산출물의 필드 값
  sourceNodeId: ID;
  field: 'outcome' | 'json';
  jsonPath?: string; // field=json일 때 "a.b" 형태
  equals: string;
}

export interface GraphNode {
  id: ID;
  kind: NodeKind;
  label: string;
  position: { x: number; y: number };
  agentId: ID | null; // agent/review 노드 담당
  reviewerAgentId: ID | null; // agent 노드의 독립 검토자(선택)
  instructions: string;
  inputs: string[]; // 입력 자료(상대 경로)
  useUpstreamOutputs: boolean;
  outputs: OutputSpec[];
  doneCriteria: string;
  command: string[]; // check 노드: argv 배열(셸 미사용)
  writeScope: string[]; // agent 노드: 수정 가능한 상대 경로. 비면 담당 workPaths
  maxRetries: number; // 한 번 방문 안의 실행 재시도
  maxVisits: number; // 재작업으로 다시 들어올 수 있는 최대 횟수
  timeoutSec: number;
  condition: BranchCondition | null;
  entryCondition: 'all' | 'any'; // 여러 선행 단계가 있을 때 진입 조건
  skipInlineReview?: boolean; // true면 노드 안 독립 검토를 건너뛴다(다음 단계에 Codex 리뷰·Claude 재검토가 있을 때)
}

export interface GraphEdge {
  id: ID;
  source: ID;
  target: ID;
  kind: EdgeKind;
}

export interface WorkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphVersion {
  id: ID;
  projectId: ID;
  version: number;
  graph: WorkGraph;
  hash: string;
  note: string;
  createdAt: string;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: ID;
  edgeId?: ID;
}

// ───────── 실행 ─────────
export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'review_wait'
  | 'on_hold'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs_resume';

export type NodeStatus =
  | 'waiting' // 대기
  | 'running' // 실행 중
  | 'checking' // 검사 중
  | 'rework' // 재작업
  | 'review_wait' // 검토 대기
  | 'succeeded' // 완료
  | 'failed' // 실패
  | 'cancelled' // 취소
  | 'needs_resume' // 재개 확인 필요
  | 'skipped';

export interface Run {
  id: ID;
  projectId: ID;
  graphVersionId: ID;
  graphVersion: number;
  planVersion: number;
  status: RunStatus;
  executor: 'claude' | 'mock';
  parentRunId: ID | null;
  startNodeId: ID | null;
  reason: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface RunNodeState {
  runId: ID;
  nodeId: ID;
  status: NodeStatus;
  visits: number;
  lastAttemptId: ID | null;
  summary: string;
  failureReason: string;
  nextAction: string;
  updatedAt: string;
}

export type AttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'timeout';

export interface AcceptanceResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export interface Attempt {
  id: ID;
  runId: ID;
  nodeId: ID;
  visit: number;
  attemptNo: number;
  agentId: ID | null;
  agentVersion: number | null;
  role: 'author' | 'reviewer' | 'check' | 'codex' | 'operator' | 'system';
  status: AttemptStatus;
  pid: number | null;
  procStart: string | null; // 프로세스 시작 시각(ps lstart) — 복구 시 PID 재사용 구분
  commitSha?: string | null; // 이 시도의 변경을 직원 이름으로 커밋한 git 커밋(없으면 미커밋)
  commitNote?: string; // 커밋하지 않은 이유·오류
  sessionId: string | null;
  resumedFrom: string | null;
  promptHash: string;
  argvRedacted: string[];
  exitCode: number | null;
  resultSubtype: string | null;
  isError: boolean | null;
  costUsd: number | null; // CLI가 보고한 경우만. 미보고는 null
  usage: Record<string, number> | null;
  permissionDenials: string[];
  acceptance: AcceptanceResult | null;
  changedFiles: string[];
  outOfScopeChanges: string[];
  summary: string;
  error: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface AttemptEvent {
  attemptId: ID;
  seq: number;
  at: string;
  kind: 'init' | 'text' | 'tool' | 'tool_result' | 'result' | 'stderr' | 'system' | 'denied';
  summary: string;
  raw: string; // 펼쳐 볼 상세(비밀값 마스킹)
}

export type ArtifactKind = 'code' | 'document' | 'image' | 'report' | 'executable' | 'data' | 'other';

export interface Artifact {
  id: ID;
  runId: ID;
  nodeId: ID;
  attemptId: ID | null;
  path: string; // 절대 경로
  relPath: string;
  kind: ArtifactKind;
  sha256: string;
  size: number;
  createdAt: string;
}

export interface CheckResult {
  id: ID;
  runId: ID;
  nodeId: ID;
  attemptId: ID;
  name: string;
  argv: string[];
  exitCode: number | null;
  ok: boolean;
  output: string;
  durationMs: number;
  createdAt: string;
}

export interface ReviewRecord {
  id: ID;
  runId: ID;
  nodeId: ID;
  kind: 'agent' | 'codex' | 'user';
  reviewerAgentId: ID | null;
  verdict: 'approve' | 'changes_requested' | 'hold';
  comments: string;
  targetNodeId: ID | null; // 수정 요청 대상 담당 노드
  subjectHash: string; // 검토 대상 결과물·흐름 버전 해시
  graphVersionId: ID;
  stale: boolean; // 대상 해시가 바뀌어 무효
  createdAt: string;
}

export interface Deliverable {
  runId: ID;
  hash: string;
  reportPath: string;
  goal: string;
  doneCriteria: string;
  markdown: string;
  createdAt: string;
}

export interface RunDetail {
  run: Run;
  graph: WorkGraph;
  nodes: RunNodeState[];
  attempts: Attempt[];
  artifacts: Artifact[];
  checks: CheckResult[];
  reviews: ReviewRecord[];
  deliverable: Deliverable | null;
  currentSubjectHash: string | null;
  billing: Billing; // 실행 시점 로그인 방식에 따른 비용 값의 의미
}

/** subscription: 구독 플랜 로그인(비용 값은 API 환산 추정치, 실제 청구 아님) · api: API 키(추정 청구액) · mock: 모의 · unknown */
export type Billing = 'subscription' | 'api' | 'mock' | 'unknown';
export function billingLabel(b: Billing): string {
  return b === 'subscription' ? '플랜 사용량(API 환산 추정, 청구 아님)' : b === 'api' ? 'API 사용 추정 비용' : b === 'mock' ? '모의 실행(비용 없음)' : '사용량 추정치(로그인 방식 미확인)';
}

// ───────── CLI 준비 상태 ─────────
export interface CliStatus {
  checkedAt: string;
  path: string | null;
  source: string; // 'setting' | 'PATH' | '데스크톱 앱 포함' 등
  version: string | null;
  loggedIn: boolean | null;
  authMethod: string | null;
  ready: boolean;
  problem: string | null; // 사용자에게 보여줄 원인
  fix: string | null; // 해결 방법
  candidates: { path: string; source: string; version: string | null }[];
}

export interface AppSettings {
  cliPath: string | null;
  executor: 'claude' | 'mock';
  maxConcurrent: number;
  langsmithEnabled: boolean;
  langsmithProject: string;
  langsmithEndpoint: string;
  langsmithKeySet: boolean; // 키 존재 여부만(값은 노출하지 않음)
  codexPath: string | null; // Codex CLI 경로(없으면 자동 탐색)
  codexModel: string; // 리뷰 모델(기본 gpt-6.1-sol)
  codexEffort: string; // 추론 강도(기본 high)
  missionMaxCycles: number; // 오퍼레이터 루프가 사용자 확인 없이 도는 최대 사이클 수
  learning?: boolean; // 대화에서 배우기(기본 켬): 지시·답변에서 배운 것을 저장해 다음 지시·다른 프로젝트에 반영
  gitCommits: boolean; // 직원별 git 커밋·미션 스냅샷 사용
}

// ───────── 실시간 이벤트(main → renderer) ─────────
export type LiveEvent =
  | { type: 'run'; run: Run }
  | { type: 'node'; state: RunNodeState }
  | { type: 'attempt'; attempt: Attempt }
  | { type: 'event'; event: AttemptEvent }
  | { type: 'queue'; running: number; waiting: number; max: number; paused: string[] }
  | { type: 'cli'; status: CliStatus }
  | { type: 'mission'; mission: Mission }
  | { type: 'missionEvent'; event: MissionEvent }
  | { type: 'learning' };

// ───────── preload가 노출하는 API ─────────
export interface WorkspaceApi {
  // 프로젝트
  listProjects(): Promise<Project[]>;
  createProject(plan: PlanFields): Promise<Project>;
  updatePlan(projectId: ID, plan: PlanFields): Promise<Project>;
  planHistory(projectId: ID): Promise<PlanVersion[]>;
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  pickSubfolder(base: string): Promise<string | null>; // base 하위 폴더를 상대 경로로
  revealInFinder(path: string): Promise<void>;
  openPath(path: string): Promise<string>;
  previewFile(path: string): Promise<void>; // 격리 창 미리보기
  readTextFile(path: string): Promise<string>;
  // 직원
  listAgents(projectId: ID, includeFired?: boolean): Promise<Agent[]>;
  saveAgent(projectId: ID, agentId: ID | null, fields: AgentFields): Promise<Agent>;
  duplicateAgent(agentId: ID): Promise<Agent>;
  setAgentActive(agentId: ID, active: boolean): Promise<Agent>;
  loadAgentTemplates(projectId: ID, setId?: AgentTemplateSetId): Promise<Agent[]>;
  agentTemplateSets(): Promise<AgentTemplateSetInfo[]>;
  fireAgent(agentId: ID): Promise<{ cleared: string[] }>;
  // 그래프
  latestGraph(projectId: ID): Promise<GraphVersion | null>;
  listGraphVersions(projectId: ID): Promise<GraphVersion[]>;
  validateGraph(projectId: ID, graph: WorkGraph): Promise<ValidationIssue[]>;
  saveGraph(projectId: ID, graph: WorkGraph, note: string): Promise<{ version: GraphVersion | null; issues: ValidationIssue[] }>;
  defaultGraph(projectId: ID): Promise<WorkGraph>;
  // 실행
  startRun(projectId: ID, graphVersionId: ID): Promise<Run>;
  rerunFrom(runId: ID, nodeId: ID): Promise<Run>;
  pauseRun(runId: ID): Promise<void>;
  resumeRun(runId: ID): Promise<void>;
  cancelRun(runId: ID): Promise<void>;
  resolveInterrupted(runId: ID, nodeId: ID, action: 'retry' | 'continue_session' | 'verify_only'): Promise<void>;
  listRuns(projectId: ID): Promise<Run[]>;
  /** 프로젝트에서 지금 일하는 직원 */
  workingNow(projectId: ID): Promise<WorkingItem[]>;
  runDetail(runId: ID): Promise<RunDetail>;
  attemptEvents(attemptId: ID): Promise<AttemptEvent[]>;
  // 검토
  submitReview(runId: ID, nodeId: ID, verdict: 'approve' | 'changes_requested' | 'hold', comments: string, targetNodeId: ID | null, subjectHash: string): Promise<ReviewRecord>;
  // 설정·상태
  cliStatus(refresh: boolean): Promise<CliStatus>;
  pickCliPath(): Promise<CliStatus>;
  openLoginTerminal(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(s: Partial<AppSettings>, langsmithKey?: string | null): Promise<AppSettings>;
  helpDocs(): Promise<{ guide: string; verification: string; images: Record<string, string> }>; // images: 'images/파일.png' → data URL(앱에 포함된 PNG만)
  // 운영(오퍼레이터 루프)
  codexStatus(refresh: boolean): Promise<CodexStatus>;
  listMissions(projectId: ID): Promise<Mission[]>;
  attention(): Promise<Attention>;
  listLearnings(): Promise<Learning[]>;
  saveLearning(id: ID | null, fields: LearningFields & { active?: boolean }): Promise<Learning>;
  deleteLearning(id: ID): Promise<void>;
  markLearningsReviewed(ids: ID[]): Promise<void>;
  missionReadiness(projectId: ID, refresh?: boolean): Promise<MissionReadiness>;
  startMission(projectId: ID, prompt: string): Promise<Mission>;
  missionDetail(missionId: ID): Promise<MissionDetail>;
  answerMission(missionId: ID, text: string, action: 'continue' | 'stop'): Promise<Mission>;
  /** 진행 중인 미션에 추가 지시: next = 다음 사이클 계획에 반영, now = 진행 중인 작업을 멈추고 바로 다시 계획 */
  addDirective(missionId: ID, text: string, mode: 'next' | 'now'): Promise<Mission>;
  listPromptTemplates(): Promise<PromptTemplate[]>;
  /** 프로젝트 완성 문서 세트(상태 포함) */
  projectDocs(projectId: ID): Promise<ProjectDoc[]>;
  saveProjectDocs(projectId: ID, items: DocItem[]): Promise<ProjectDoc[]>;
  reviewProjectDoc(projectId: ID, docId: string, reviewed: boolean): Promise<ProjectDoc[]>;
  resetProjectDocs(projectId: ID): Promise<ProjectDoc[]>;
  /** 파일을 골라 프로젝트 폴더의 문서 경로로 복사한다(취소하면 null) */
  uploadProjectDoc(projectId: ID, docId: string): Promise<ProjectDoc[] | null>;
  stopMission(missionId: ID): Promise<Mission>;
  /** 사용 한도 대기 중인 미션을 기다리지 않고 지금 다시 시도한다 */
  retryMissionLimit(missionId: ID): Promise<Mission>;
  missionSnapshots(missionId: ID): Promise<MissionSnapshot[]>;
  rollbackMission(missionId: ID, tag: string): Promise<{ ok: boolean; reverted: string[]; error: string | null }>;
  onLive(cb: (e: LiveEvent) => void): () => void;
}

export const NODE_KIND_LABEL: Record<NodeKind, string> = {
  input: '기획·입력',
  agent: 'Agent 작업',
  check: '명령 기반 검사',
  review: '독립 교차검토',
  branch: '조건 분기',
  merge: '결과물 취합',
  userReview: '사용자 검토',
  codexReview: 'Codex 리뷰',
};

export const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
  waiting: '대기',
  running: '실행 중',
  checking: '검사 중',
  rework: '재작업',
  review_wait: '검토 대기',
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소',
  needs_resume: '재개 확인 필요',
  skipped: '건너뜀',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: '대기',
  running: '실행 중',
  paused: '새 배정 일시정지',
  review_wait: '검토 대기',
  on_hold: '보류',
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소',
  needs_resume: '재개 확인 필요',
};

// ───────── 운영: 오퍼레이터 루프(미션) ─────────
// 사용자 지시 → 오퍼레이터 계획 → 담당 Agent 수행 → Codex 리뷰 → Claude 재검토 → 오퍼레이터 판단 → (반복 | 사용자 질문 | 완료)
export type MissionStatus = 'planning' | 'running' | 'evaluating' | 'waiting_user' | 'done' | 'stopped' | 'failed';
/** 루프 다이어그램에서 강조할 현재 단계 */
export type MissionStage = 'instruction' | 'plan' | 'execute' | 'codex' | 'claude_review' | 'judge' | 'ask_user' | 'done' | 'stopped';

export interface Mission {
  id: ID;
  projectId: ID;
  prompt: string; // 사용자 지시 원문
  status: MissionStatus;
  stage: MissionStage;
  cycle: number; // 현재 사이클(1부터)
  maxCycles: number; // 이 수만큼 돌면 사용자에게 계속 여부를 묻는다
  currentRunId: ID | null;
  question: string | null; // 사용자에게 묻는 내용(waiting_user일 때)
  summary: string; // 오퍼레이터의 최근 판단 요약
  /** 오퍼레이터가 근거 문서가 빈약·애매하다고 판단해 멈췄을 때, 채워야 할 부분 */
  gaps?: MissionGap[] | null;
  denials?: MissionDenial[] | null; // 권한 거부로 멈춘 경우 거부 항목
  denialSigs?: string[]; // 직전 사이클의 거부 항목(반복 판별)
  blockers?: MissionBlocker[] | null; // 에이전트가 스스로 풀 수 없는 실패로 멈춘 경우
  failSigs?: string[]; // 직전 사이클의 실패 원인(반복 판별)
  learnedSeq?: number; // 배운 것을 정리한 마지막 기록 번호
  /** 사용 한도 해제를 기다리는 중이면 자동으로 이어서 진행할 시각(ISO). 아니면 null/없음 */
  limitUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 근거 문서 보완 요청 한 건 */
export interface MissionGap { doc: string; issue: string; need: string }
/** 에이전트가 스스로 풀 수 없는 실패: 내 PC 환경 문제(명령·프로그램 없음, 접근 거부, 네트워크·로그인)이거나 같은 실패의 반복 */
export interface MissionBlocker { step: string; reason: string; kind: 'environment' | 'repeated' }
/** 직원이 권한 때문에 막힌 행위(명령·경로). 앱 설정으로만 허용할 수 있다. */
export interface MissionDenial {
  agentId: ID | null;
  agent: string; // 예: '09 시험·품질'
  tool: string; // Bash, Read, Glob, Grep …
  kind: 'command' | 'path' | 'other';
  target: string; // 거부된 명령 또는 경로
  suggestion: string | null; // 허용 명령 접두어(명령) 또는 참고 문서로 넣을 경로(경로)
  sig: string; // 반복 판별용
}

export interface MissionEvent {
  missionId: ID;
  seq: number;
  at: string;
  kind: 'user' | 'operator_plan' | 'operator_judge' | 'question' | 'answer' | 'directive' | 'cycle_start' | 'cycle_end' | 'system';
  cycle: number;
  text: string; // 사람이 읽는 요약
  data: string; // 상세(JSON 문자열, 계획·판단 원본 — 비밀값 마스킹)
}

export interface MissionCycle { cycle: number; runId: ID; status: RunStatus; graphVersion: number }

export interface MissionDetail {
  mission: Mission;
  events: MissionEvent[];
  cycles: MissionCycle[];
  currentRun: RunDetail | null; // 현재(또는 마지막) 사이클 실행 — 실시간 다이어그램용
  /** 이 미션이 만든 결과물·기록에 나온 프로젝트 안 파일(바로 열기용). 최신 사이클 먼저 */
  files: MissionFile[];
  /** 이 미션의 프로젝트에서 지금 일하는 직원 */
  working: WorkingItem[];
}
/** 지금 일하는 직원(실행 중인 Claude·Codex·검사 프로세스, 오퍼레이터 호출) */
export interface WorkingItem {
  agentId: ID | null;
  who: string; // 예: '03 기획 담당', 'Codex 리뷰', '00 총괄(오퍼레이터)'
  kind: 'author' | 'reviewer' | 'codex' | 'check' | 'operator';
  task: string; // 단계 이름 또는 오퍼레이터 단계
  runId: ID | null;
  missionId: ID | null;
  since: string; // 시작 시각(ISO)
  reviewOf?: ID | null; // 검토·Codex 리뷰·검사일 때 그 대상 작업을 한 직원(리뷰 받는 직원)
  mode?: 'code' | 'doc'; // 작성 작업의 산출물 종류(코드 / 문서)
}
export interface MissionFile { relPath: string; path: string; cycle: number | null; kind: string | null; exists: boolean; createdAt: string | null }

export interface CodexStatus { path: string | null; version: string | null; loggedIn: boolean | null; ready: boolean; problem: string | null; fix: string | null }

export const MISSION_STATUS_LABEL: Record<MissionStatus, string> = {
  planning: '계획 중', running: '수행 중', evaluating: '판단 중', waiting_user: '사용자 확인 대기', done: '완료 보고', stopped: '중단', failed: '실패',
};
export const MISSION_STAGE_LABEL: Record<MissionStage, string> = {
  instruction: '사용자 지시', plan: '오퍼레이터 계획', execute: '담당 Agent 수행', codex: 'Codex 리뷰', claude_review: 'Claude 재검토',
  judge: '오퍼레이터 판단', ask_user: '사용자 확인', done: '완료', stopped: '중단',
};

/** 운영 지시 전 필수 준비 항목. 하나라도 빠지면 지시할 수 없다(서버에서도 같은 기준으로 막는다). */
export interface ReadinessItem { key: string; label: string; ok: boolean; detail: string; tab: 'plan' | 'agents' | 'settings' | null }
export interface MissionReadiness {
  ready: boolean;
  items: ReadinessItem[];
  /** 지금 작동 중이거나 이 프로젝트에서 열려 있는 미션(있으면 새 지시 대신 그 미션에 추가 지시) */
  activeMission: { id: ID; projectId: ID; projectName: string; status: MissionStatus; sameProject: boolean } | null;
}
/** 권장 기획 문서 프롬프트 템플릿(resources/docs/prompts/*.md) */
export interface PromptTemplate { id: string; title: string; summary: string; output: string; body: string }

/** 프로젝트 완성 문서 세트의 한 항목(저장되는 값) */
export interface DocItem {
  id: string;
  title: string;
  path: string; // 프로젝트 폴더 기준 상대 경로
  templateId: string | null; // 표준 세트(권장 문서 템플릿)에서 온 문서면 템플릿 ID
  instruction: string; // 직접 쓴 지시문(비어 있으면 템플릿 지시문)
  excluded: boolean; // 이 프로젝트에는 필요 없음
  reviewedSha: string | null; // 사용자가 '검토 완료'로 표시할 때의 파일 내용 해시
  reviewedAt: string | null;
}
/** 화면용: 저장 값 + 실제 파일 상태 */
export interface ProjectDoc extends DocItem {
  order: number;
  status: 'excluded' | 'missing' | 'draft' | 'changed' | 'reviewed';
  exists: boolean;
  absPath: string;
  summary: string;
  body: string; // 문서를 만드는 프롬프트(템플릿 원문, 경로 반영) — 복사해 각자 환경에서 산출물을 만든다
  resolvedInstruction: string; // 운영 탭에 넣을 지시문(경로 반영)
  missingBefore: string[]; // 앞 순서에서 아직 없는 문서 제목
}

/** 미션 스냅샷: 시작 시점과 사이클 종료마다 git 태그. 되돌리기는 이후 CREWGENAI 커밋만 revert(기록 보존). */
export interface MissionSnapshot { name: string; tag: string; sha: string; cycle: number; createdAt: string; repos?: string[]; commitsAfter: { sha: string; subject: string; author: string; repo?: string }[] }

export type AgentTemplateSetId = 'dev' | 'general';
export interface AgentTemplateSetInfo { id: AgentTemplateSetId; label: string; description: string; agents: { code: string; name: string; role: string }[] }

// ───────── 배운 것 ─────────
/** 사용자의 지시·답변·권한 허용에서 배운 사실. 이 PC에만 저장하고 다음 지시·다른 프로젝트에 자동 반영한다. */
export interface LearningFields { scope: 'global' | 'project'; projectId: ID | null; kind: 'preference' | 'environment' | 'rule' | 'fact'; text: string }
export interface Learning extends LearningFields { id: ID; source: string; reviewed: boolean; active: boolean; createdAt: string; updatedAt: string }

// ───────── 검토가 필요한 항목 ─────────
/** 사용자가 확인해야 진행되는 항목(에이전트가 스스로 해결할 수 없는 것) */
export interface AttentionItem {
  projectId: ID;
  kind: 'denied' | 'blocked' | 'gaps' | 'question' | 'review' | 'resume';
  label: string;
  missionId?: ID;
  runId?: ID;
}
export interface Attention { items: AttentionItem[]; learningsToReview: number }
