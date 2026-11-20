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
export type ToolName = 'Read' | 'Grep' | 'Glob' | 'Edit' | 'Write' | 'Bash' | 'WebFetch' | 'Skill';

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
  effort?: string; // 추론 강도(low·medium·high·xhigh·max). 빈 값이면 CLI 기본
  maxBudgetUsd: number | null; // CLI --max-budget-usd
  timeoutSec: number;
  maxRetries: number;
  active: boolean;
  character?: string; // 화면에 쓰는 캐릭터 번호(C01~C20). 없으면 직군 기본값. 역할·권한과 별개
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
  autoAssist?: boolean; // 자동 처리(기본 켬): 작업 브랜치 자동 생성, 저장소 시험 명령 허용, 프로젝트 스킬·쓰기 직원 스킬, 문서 저장소 최신화
  commandLevel?: 'low' | 'medium' | 'high'; // 직원 명령 허용 범위(기본 중간). 격리·네트워크 없음 안에서 묻지 않고 허용할 명령의 폭
  devSync?: boolean; // 매일 dev 반영(기본 켬): 하루 한 번 비밀값을 뺀 변경을 커밋해 dev에 합치고 push. main 병합은 하지 않는다
  devSyncHour?: number; // 매일 dev 반영 시각(0~23시, 기본 22)
  techAuto?: boolean; // 기술 권한 요청(명령 허용·경로 읽기)을 사용자에게 묻지 않고 앱·오퍼레이터가 처리(기본 켬). 보호 규칙은 그대로
  paceEnabled?: boolean; // 사용량 속도 조절(기본 켬): 주간·5시간 사용 한도를 초기화까지 나눠 쓰도록 새 사이클 시작을 미룬다
  paceReservePct?: number; // 주간 한도 중 앱이 쓰지 않고 남길 몫(%, 기본 10). 사람이 직접 쓰는 Claude 몫과 여유
  testLocalSockets?: boolean; // 자동 처리 시험 명령에 로컬 소켓 허용(기본 끔). 켜면 격리 실행에서도 이 PC의 로컬 서비스에 접속할 수 있다
  skillDirs?: string[]; // 'Skill' 도구를 켠 직원이 쓸 스킬 폴더(이 PC의 절대 경로). 없으면 ~/.claude/skills·~/.agents/skills 중 있는 것
}

/** 설정 화면용: 스킬 폴더에서 찾은 스킬 */
export interface SkillSource { path: string; ok: boolean; skills: string[]; note: string | null }

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
  | { type: 'learning' }
  | { type: 'telegram' }
  | { type: 'devSync' };

// ───────── preload가 노출하는 API ─────────
export interface WorkspaceApi {
  // 프로젝트
  listProjects(): Promise<Project[]>;
  createProject(plan: PlanFields): Promise<Project>;
  updatePlan(projectId: ID, plan: PlanFields): Promise<Project>;
  planHistory(projectId: ID): Promise<PlanVersion[]>;
  pickFolder(): Promise<string | null>;
  pickSkillFolder(): Promise<string | null>;
  skillSources(dirs: string[] | null): Promise<{ dirs: string[]; sources: SkillSource[] }>;
  pickFiles(): Promise<string[]>;
  pickSubfolder(base: string): Promise<string | null>; // base 하위 폴더를 상대 경로로
  revealInFinder(path: string): Promise<void>;
  openPath(path: string): Promise<string>;
  openLocalUrl(url: string): Promise<void>; // 이 컴퓨터(localhost)의 화면 주소만 기본 브라우저로 연다
  demoInfo(projectId: ID): Promise<DemoInfo>;
  demoApprove(projectId: ID, serviceId: string, shownHash: string): Promise<DemoInfo>; // 승인 창에 보여 준 명령의 확인값
  demoStart(projectId: ID, serviceId: string): Promise<DemoInfo>;
  demoStop(projectId: ID, serviceId: string): Promise<DemoInfo>;
  demoLog(projectId: ID, serviceId: string): Promise<string>;
  demoRequest(projectId: ID, serviceId: string, req: { method: string; path: string; headers: Record<string, string>; body: string; capture?: Record<string, string> }): Promise<DemoResponse>;
  demoReset(projectId: ID, serviceId: string): Promise<void>;
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
  helpDocs(): Promise<{ guide: string; verification: string; changelog: string; images: Record<string, string> }>; // images: 'images/파일.png' → data URL(앱에 포함된 PNG만)
  // 운영(오퍼레이터 루프)
  codexStatus(refresh: boolean): Promise<CodexStatus>;
  listMissions(projectId: ID): Promise<Mission[]>;
  attention(): Promise<Attention>;
  pendingDecisions(all?: boolean): Promise<PendingDecision[]>;
  applyDecisions(picks: { key: string; choice: string; version?: string }[]): Promise<{ applied: number; stale: number; lines: string[] }>;
  /** 확인함의 비밀값(API 키 등)을 연결 폴더의 .env 파일에 저장하고 그 결정을 '넣었음'으로 처리한다. 값은 어디에도 기록하지 않는다 */
  saveSecret(input: { key: string; file: string; name: string; value: string }): Promise<{ ok: true; line: string } | { ok: false; error: string }>;
  // 텔레그램(토큰은 넣기만 하고 화면으로 돌려받지 않는다)
  telegramStatus(): Promise<TgStatusView>;
  telegramSetToken(token: string | null): Promise<TgStatusView>;
  telegramTest(): Promise<{ ok: boolean; bot: string | null; detail: string }>;
  telegramSetOptions(o: Partial<TgOptionsView>): Promise<TgStatusView>;
  telegramLinkCode(): Promise<TgStatusView>;
  telegramLinkConfirm(accept: boolean, expectUserId?: number): Promise<TgStatusView>;
  telegramUnlink(): Promise<TgStatusView>;
  telegramSendTest(): Promise<string>;
  pauseMission(missionId: ID): Promise<Mission>;
  /** 진척 메뉴: 작업 목록·변경을 사용자가 확인함 */
  reviewWorkPlan(missionId: ID): Promise<Mission>;
  resumeMission(missionId: ID): Promise<Mission>;
  /** 승인 커밋: 화면에 보여 줄 내용, 승인(보여 준 hash가 지금과 같을 때만), 거절 */
  commitPreview(missionId: ID, requestId: string): Promise<CommitPreview>;
  commitApprove(missionId: ID, requestId: string, shownHash: string): Promise<MissionCommitRequest>;
  commitDecline(missionId: ID, requestId: string): Promise<MissionCommitRequest>;
  listLearnings(): Promise<Learning[]>;
  saveLearning(id: ID | null, fields: LearningFields & { active?: boolean }): Promise<Learning>;
  deleteLearning(id: ID): Promise<void>;
  markLearningsReviewed(ids: ID[]): Promise<void>;
  missionReadiness(projectId: ID, refresh?: boolean): Promise<MissionReadiness>;
  startMission(projectId: ID, prompt: string, limits?: MissionLimits | null): Promise<Mission>;
  /** eventLimit: 최근 기록 몇 개만(기본 150, 0이면 전부) */
  missionDetail(missionId: ID, eventLimit?: number): Promise<MissionDetail>;
  /** keepPending: 질문에만 답하고 보류한 업무·근거 부족 항목은 그대로 둔다(선택지 버튼) */
  answerMission(missionId: ID, text: string, action: 'continue' | 'stop', keepPending?: boolean): Promise<Mission>;
  /** 검토 지점 답변: 고른 결정과 묶은 피드백을 한 번에 보내고 이어서 진행(또는 종료) */
  reviewMission(missionId: ID, picks: { doc: string; question: string; choice: string }[], feedback: string, action: 'continue' | 'stop'): Promise<Mission>;
  /** 진행 중인 미션에 추가 지시: next = 다음 사이클 계획에 반영, now = 진행 중인 작업을 멈추고 바로 다시 계획 */
  addDirective(missionId: ID, text: string, mode: 'next' | 'now' | 'priority'): Promise<Mission>;
  listPromptTemplates(): Promise<PromptTemplate[]>;
  /** 프로젝트 완성 문서 세트(상태 포함) */
  projectDocs(projectId: ID): Promise<ProjectDoc[]>;
  saveProjectDocs(projectId: ID, items: DocItem[]): Promise<ProjectDoc[]>;
  reviewProjectDoc(projectId: ID, docId: string, reviewed: boolean): Promise<ProjectDoc[]>;
  resetProjectDocs(projectId: ID): Promise<ProjectDoc[]>;
  /** 파일을 골라 프로젝트 폴더의 문서 경로로 복사한다(취소하면 null) */
  uploadProjectDoc(projectId: ID, docId: string): Promise<ProjectDoc[] | null>;
  stopMission(missionId: ID): Promise<Mission>;
  /** 보류한 업무를 사용자가 해결함: 다음 계획부터 다시 시도할 수 있게 보류를 푼다 */
  retryParked(missionId: ID, sigs?: string[]): Promise<Mission>;
  /** 확인 필요 항목에 선택한 결정을 반영한다. resume이면(확인 대기 중일 때) 바로 이어서 진행 */
  decideMission(missionId: ID, picks: MissionPick[], resume: boolean): Promise<Mission>;
  /** 확인 필요 항목의 근거 위치를 읽기 전용으로 미리 본다(프로젝트 폴더·참고 자료 안의 텍스트 파일만) */
  refSnippet(missionId: ID, path: string, line: number | null): Promise<RefSnippet>;
  /** 직원 제안 적용(edit가 있으면 고친 내용으로) 또는 무시. 적용하면 직원 목록에 바로 반영되고 다음 계획부터 쓴다 */
  resolveStaffProposal(missionId: ID, proposalId: ID, action: 'apply' | 'dismiss', edit: StaffEdit | null): Promise<Mission>;
  /** 사용 한도 대기 중인 미션을 기다리지 않고 지금 다시 시도한다 */
  retryMissionLimit(missionId: ID): Promise<Mission>;
  /** 지시 첨부 파일 고르기: 앱 데이터 폴더로 복사한 경로(비밀값·큰 파일은 skipped) */
  pickAttachments(projectId: ID): Promise<{ name: string; path: string; size: number; skipped?: string }[]>;
  /** 붙여 넣은 클립보드 파일·이미지 저장 */
  saveAttachmentData(projectId: ID, name: string, data: Uint8Array): Promise<{ name: string; path: string; size: number; skipped?: string }>;
  /** 매일 dev 반영 상태와 지금 실행 */
  devSyncStatus(): Promise<DevSyncView>;
  devSyncNow(): Promise<DevSyncView>;
  /** 사용량 속도 조절 상태: CLI가 마지막으로 알려 준 주간·5시간 사용률과 지금 판단 */
  usagePace(): Promise<UsagePaceView>;
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

/** 작업이 끝날 때 사용자가 바로 열어 볼 결과물: 파일(문서·스크린샷·코드) 또는 이 컴퓨터의 화면 주소 */
export interface MissionResult {
  task: string; // 어떤 작업의 결과인지
  title: string;
  kind: 'file' | 'url';
  path: string; // 파일은 절대 경로, 화면은 http://localhost… 주소
  relPath: string; // 파일은 프로젝트 기준 경로, 화면은 주소 그대로
  exists: boolean;
  changed: string; // 무엇이 달라졌는지
  check: string; // 무엇을 확인하면 되는지
  verified?: string; // 실제로 실행해 확인한 것과 결과, 또는 '미검증 — 이유'
  remaining?: string; // 남은 사항
  demo?: ResultDemo | null; // 실행 가능한 기능의 시연(없으면 문서·파일 보기)
  /** 어디까지 됐는지: 구현됨 → 실행됨 → 실제 기능 검증됨 → 사용자 검토 가능 → 사용자 피드백 반영됨 */
  status?: ResultStatus;
}
export type ResultStatus = 'implemented' | 'ran' | 'verified' | 'reviewable' | 'feedback_applied';
export const RESULT_STATUS_LABEL: Record<ResultStatus, string> = { implemented: '구현됨', ran: '실행됨', verified: '실제 기능 검증됨', reviewable: '사용자 검토 가능', feedback_applied: '피드백 반영됨' };
/** 검토 지점: 의미 있는 결과가 준비됐을 때 사용자가 한곳에서 보고 판단한다 */
export interface MissionCheckpoint {
  cycle: number; at: string;
  title: string; // 이번에 검토할 큰 기능·흐름
  features: { name: string; changed: string; status: ResultStatus }[];
  steps: string; // 사용자가 눌러 볼 순서와 예상 결과
  verified: string; // 실제로 확인한 범위
  unverified: string; // 미완성·미검증 부분
  decisions: { doc: string; question: string; choices: MissionChoice[] }[]; // 사용자 판단이 필요한 핵심(최대 3). doc+question이 원래 항목의 식별자
  assumptions: string[]; // 문서가 부족해 가정하고 진행한 세부(되돌리기 쉬운 것)
  reason: 'ready' | 'budget' | 'blocked'; // 결과가 준비돼서 / 정기 결과 보고(진행은 계속) / 실행 준비·전체 막힘
  blocking?: boolean; // 이 결정 없이는 진행할 작업이 없어 미션이 기다림(아니면 개발은 계속)
  blocked?: string[]; // 막힌 것(무엇이·직접 확인한 원인·시도한 방법), 사용자에게 필요한 최소 결정·권한
  usage?: string; // 지금까지 사용량(CLI 보고값만, 미보고는 미보고로)
}
/** source 'pace': 한도에 걸린 것이 아니라 사용량 속도 조절로 새 사이클을 미루는 중 */
export interface MissionLimitWait { source: 'operator' | 'run' | 'pace'; reason: string; resetKnown: boolean; nextAt: string; tries: number; lastAt: string | null; lastResult: string | null; target: string }
/** 미션 실행 범위(시작할 때 정함): 참여 직원. 전체 시간·사이클 상한은 두지 않는다 */
export interface MissionLimits { staff: string[] | null }
/** 미션 사용량: CLI가 보고한 값만 더한다(미보고 호출 수는 따로 셈, 추정하지 않음) */
export interface MissionUsage { calls: number; reported: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
/** 결과물의 시연: 시연 목록의 서비스 화면 경로 또는 API 항목으로 바로 연다 */
export interface ResultDemo { service: string; path: string; api: string; steps: string; expected: string; data: DemoData }
export type DemoData = 'api+db' | 'screen-only' | 'mock';
export interface DemoService {
  id: string; name: string; kind: 'web' | 'api' | 'admin' | 'app'; repo: string; cwd: string; start: string[]; port: number | null; health: string;
  env: Record<string, string>; data: DemoData; needs: string[]; note: string; startupSec: number;
}
export interface DemoApi { service: string; id: string; group: string; title: string; method: string; path: string; headers: Record<string, string>; body: string; description: string; expect: string; capture: Record<string, string> }
export interface DemoState { service: DemoService; hash: string; status: 'running' | 'starting' | 'stopped' | 'needs_approval'; approved: boolean; ours: boolean; url: string | null; exitCode: number | null; startedAt: string | null }
export interface DemoInfo { manifestPath: string; relPath: string; exists: boolean; services: DemoState[]; apis: DemoApi[]; errors: string[] }
export interface DemoResponse { status: number; ms: number; headers: Record<string, string>; body: string; cookies: string[]; vars: string[] }

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
  /** 사용자가 확인 필요 항목에 고른 결정(누적) */
  decisions?: MissionDecision[];
  /** 문서가 부족해 가정하고 진행한 세부(누적, 검토 지점에서 보여 줌) */
  assumptions?: { cycle: number; doc: string; text: string }[];
  /** 지금 열려 있는 검토 지점(있으면 미션 화면 맨 위에 검토 카드) */
  checkpoint?: MissionCheckpoint | null;
  /** 지난 검토 이후 자동으로 진행한 사이클 수 */
  sinceReview?: number;
  /** 멈춘 이유가 사용자 결정이 아닌 경우(앱 재시작 등): 팝업 대신 미션 화면 알림 */
  pauseKind?: 'restart' | null;
  /** 사용자가 일시정지함(진행 중 단계는 마저 끝내고 새 배정·다음 계획을 멈춤). 중지·결정 대기·한도 대기와 구분 */
  paused?: boolean;
  /** 실행 범위(참여 직원). 없으면 활성 직원 전체 */
  limits?: MissionLimits | null;
  /** 사용량을 이미 더한 사이클 실행(재시작 후 중복 집계 방지) */
  countedRuns?: string[];
  /** 사용량(오퍼레이터·직원 CLI 보고값) */
  usage?: MissionUsage | null;
  /** 실행 준비 확인을 통과했는지(통과 전에는 직원에게 작업을 배정하지 않는다) */
  readyChecked?: boolean;
  /** 오퍼레이터의 직원 제안(적용·무시한 것도 기록으로 남김) */
  staffProposals?: StaffProposal[];
  /** 오퍼레이터가 직접 물은 질문이면 배열(선택형이면 선택지, 아니면 빈 배열). 앱이 만든 안내 문구면 null */
  questionOptions?: string[] | null;
  questionChoices?: MissionChoice[] | null; // 선택지 설명(고르면 달라지는 것·추천과 이유). 추천은 안내일 뿐 자동으로 고르지 않는다
  denials?: MissionDenial[] | null; // 권한 거부로 멈춘 경우 거부 항목
  denialSigs?: string[]; // 직전 사이클의 거부 항목(반복 판별)
  /** 앱이 처리한 기술 권한 막힘(사용자에게 묻지 않음): 오퍼레이터가 다른 방법으로 계획하도록 알린다 */
  techNotes?: string[] | null;
  /** 앱이 처리해 봤지만 꼭 필요한 명령·경로 허용 요청: 확인함 팝업으로 사용자에게 묻는다(미션은 멈추지 않음) */
  permAsks?: MissionPermAsk[] | null;
  /** 같은 막힘이 몇 개 사이클에서 났는지(sig별) — 반복되면 사용자에게 허용을 묻는다 */
  techSeen?: Record<string, number> | null;
  /** 사용자가 허용하지 않기로 한 요청(sig) — 다시 묻지 않는다 */
  permDeclined?: string[] | null;
  blockers?: MissionBlocker[] | null; // 에이전트가 스스로 풀 수 없는 실패로 멈춘 경우
  failSigs?: string[]; // 직전 사이클의 실패 원인(반복 판별)
  /** 보류한 업무의 거부·실패 표식. 보류한 업무는 사용자가 해결하기 전까지 다시 계획하지 않고, 다시 막히면 미션을 멈춘다 */
  parkedSigs?: string[];
  results?: MissionResult[]; // 마지막 판단의 '열어 볼 결과물'(작업별)
  /** 오퍼레이터가 요청한 커밋(이미 있는 미커밋 변경). 사용자가 팝업에서 파일·메시지를 보고 승인해야만 앱이 커밋한다 */
  commitRequests?: MissionCommitRequest[];
  /** 큰 단원이 끝나 오퍼레이터가 판단한 main 병합 요청(사용자 승인 뒤 앱이 dev → main 병합·push) */
  mergeRequest?: MissionMergeRequest | null;
  /** 앱이 저장한 참고 사이트 스냅샷(화면 사진·본문·링크, 앱 데이터 폴더). 직원은 읽기만 한다 */
  refSnapshots?: { url: string; title: string; dir: string; at: string; error?: string }[];
  resultsCycle?: number;
  resultsHistory?: { cycle: number; results: MissionResult[] }[]; // 최근 회차별 결과물(최신 먼저, 최대 6회차)
  idleCycles?: number; // 반영된 변경 없이 끝난 사이클이 연속 몇 번인가(상한에 넣지 않음, 이어지면 멈추고 물음)
  learnedSeq?: number; // 배운 것을 정리한 마지막 기록 번호
  /** 사용 한도 해제를 기다리는 중이면 자동으로 이어서 진행할 시각(ISO). 아니면 null/없음 */
  limitUntil?: string | null;
  /** Claude 한도 대기 상태(앱이 예약·관리): 사유, 해제 시각을 알았는지, 다음 확인 시각, 재시도 횟수·마지막 결과, 재개할 작업 */
  limitWait?: MissionLimitWait | null;
  /** 작업 목록(단원·완료 기준·상태): 오퍼레이터가 판단 때마다 갱신, 진척 메뉴에서 본다 */
  workPlan?: MissionWorkPlan | null;
  createdAt: string;
  updatedAt: string;
}

/** 작업 목록 단원 상태: 시작 전 / 진행 / 검증 중 / 완료(확인 근거 필수) / 막힘 */
export type WorkStatus = 'todo' | 'doing' | 'verifying' | 'done' | 'blocked';
export interface WorkItem { id: string; title: string; criteria: string; status: WorkStatus; evidence: string; note: string; addedCycle: number; updatedCycle: number }
export interface WorkChange { cycle: number; at: string; kind: 'create' | 'add' | 'remove' | 'edit'; id: string; title: string; reason: string }
export interface MissionWorkPlan {
  items: WorkItem[];
  /** 계획에서 뺀 단원(이유는 changes에) */ removed: WorkItem[];
  /** 계획 생성·단원 추가·제외·완료 기준 변경 기록(최신이 끝) */ changes: WorkChange[];
  createdCycle: number;
  /** 사용자가 확인한 변경 수(changes.length보다 작으면 확인하지 않은 변경이 있음) */ reviewedChanges: number;
  reviewedAt: string | null;
}

/** 근거 문서 보완 요청 한 건 */
export interface MissionGap {
  doc: string; issue: string; need: string;
  /** 사용자가 고르면 되는 결정이면 오퍼레이터가 낸 선택지(2~4개) */ options?: string[];
  /** 선택지 설명(options와 같은 순서) */ choices?: MissionChoice[];
  /** 문서를 읽지 않은 사용자도 알 수 있게 쓴 쉬운 설명(배경·왜 중요한지·고르면 어떻게 되는지) */ explain?: string;
  /** 근거 위치: 프로젝트 폴더 기준 경로(또는 참고 문서 절대 경로)와 줄 번호 */ refs?: MissionRef[];
  /** decide: 사람이 정해야 하는 제품·정책 결정(검토 지점에 모아 묻는다). assume: 되돌리기 쉬운 세부라 가정하고 진행(검토 때 알림) */ kind?: 'decide' | 'assume';
  /** assume일 때 무엇으로 가정했는지 */ assumption?: string;
  /** decide 중 이것 없이는 아무 작업도 진행할 수 없는 경우만 true(즉시 묻는다) */ blocking?: boolean;
  /** API 키·접속 정보처럼 사람이 넣어야 하는 비밀값: 확인함에서 입력하면 앱이 이 .env 파일에 저장한다(값은 기록하지 않음) */ secret?: MissionSecretSpec;
}
/** 비밀값 저장 위치: 연결 폴더 기준 .env 파일과 변수 이름, 발급처 안내 */
export interface MissionSecretSpec { file: string; name: string; source?: string }
/** 사용자 승인 커밋 요청 한 건 */
export interface MissionCommitRequest {
  id: string; cycle: number;
  repo: string; // 연결 폴더 기준 저장소 경로(폴더 자체가 저장소면 빈 문자열)
  files: string[]; // 저장소 기준 경로
  message: string; why: string; task: string;
  status: 'pending' | 'approving' | 'approved' | 'declined' | 'failed'; // approving: 커밋 실행 중(앱이 꺼지면 재시작 때 실제 커밋 여부를 확인해 정리)
  sha?: string | null; branch?: string | null; error?: string | null;
  shownHash?: string | null; // 승인한 변경 묶음(보여 준 내용) 식별값
  at: string; decidedAt?: string | null;
}
export interface CommitPreviewFile { path: string; status: string; added: number | null; removed: number | null; flags: string[] }
/** 승인 화면 내용: hash는 승인할 때 그대로 돌려줘야 한다(그 사이 바뀌면 커밋하지 않음) */
export interface CommitPreview { repo: string; branch: string | null; target: string | null; files: CommitPreviewFile[]; blocked: string[]; hash: string; error: string | null; flagLabels: Record<string, string> }
/** 사용자가 고를 선택지 */
export interface MissionChoice { label: string; effect: string; recommended: boolean; why: string; action?: 'stop' } // action=stop: 고르면 미션을 종료
export interface MissionRef { path: string; line?: number | null }
/**
 * 오퍼레이터의 직원 제안: 새 직원(포지션) 추가, 기존 직원의 역할·지시 변경. 사용자가 적용해야 반영된다.
 * 도구·허용 명령 같은 권한은 제안으로 바꾸지 않는다(권한은 확인 필요의 허용 버튼으로만).
 */
export interface StaffProposal {
  id: ID; kind: 'add' | 'update';
  agentId: ID | null; // 제안할 때의 그 직원(코드는 해고 뒤 다른 직원이 이어받을 수 있어 ID로 확인)
  agentCode: string; // update: 바꿀 직원 코드, add: 비슷한 일을 하는 기존 직원 코드(도구를 그대로 씀, 없으면 빈 값)
  name: string; role: string; instructions: string; workPaths: string[];
  reason: string; cycle: number; at: string;
  status: 'pending' | 'applied' | 'dismissed'; result?: string;
}
/** 사용자가 고쳐서 적용할 때 바꾼 값 */
export interface StaffEdit { name: string; role: string; instructions: string }
/** 근거 위치 미리보기: 해당 줄 앞뒤(줄 번호 없으면 앞부분) */
export interface RefSnippet { path: string; exists: boolean; start: number; lines: string[]; target: number | null; total: number; note?: string }
/** 사용자가 확인 필요 항목에 고른 결정(이 미션 동안 오퍼레이터·직원이 그대로 따른다) */
export interface MissionDecision { doc: string; issue: string; choice: string; at: string }
/** 확인 필요 항목 하나에 대한 사용자 선택: 항목(문서·내용으로 식별)과 고른(또는 직접 적은) 내용 */
export interface MissionPick { doc: string; issue: string; choice: string }
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

/** 사용자에게 묻는 권한 허용 요청 한 건 */
export interface MissionPermAsk extends MissionDenial { why: string; cycle: number; from: 'operator' | 'repeat' }

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
  /** 기록(화면 요청이면 최근 것만) */
  events: MissionEvent[];
  /** 전체 기록 수 */
  eventsTotal?: number;
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
export interface ReadinessItem { key: string; label: string; ok: boolean; detail: string; tab: 'plan' | 'agents' | 'settings' | null; /** 참고 항목(부족해도 지시는 받음) */ info?: boolean }
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
  kind: 'checkpoint' | 'denied' | 'blocked' | 'gaps' | 'question' | 'review' | 'resume' | 'staff';
  label: string;
  missionId?: ID;
  runId?: ID;
}
export interface Attention { items: AttentionItem[]; learningsToReview: number }
/** 사용자가 버튼으로 고를 결정(어느 탭에서든 팝업으로 보여 준다) */
export interface PendingDecision {
  key: string;
  projectId: ID; projectName: string;
  missionId: ID; missionTitle: string; cycle: number;
  kind: 'question' | 'gap' | 'permission' | 'commit' | 'checkpoint' | 'merge';
  task: string; // 어떤 작업·문서의 결정인지
  question: string; // 무엇을 정해야 하는지
  explain: string; // 쉬운 설명(있을 때)
  doc: string; issue: string; // 근거 부족 항목 결정용
  choices: MissionChoice[];
  waiting: boolean; // 미션이 이 결정을 기다리며 멈춰 있는가
  denial?: MissionDenial; // 권한 보류 항목(허용하면 그 직원 설정에 넣고 다시 시도)
  commit?: MissionCommitRequest; // 승인 커밋 요청
  urgent?: boolean; // 미션 전체가 이 결정을 기다림(팝업으로 안내). 아니면 확인함에만
  held?: string; // 무엇 때문에 보류됐는지
  resumes?: string; // 정하면 재개될 작업
  grants?: string; // 권한 항목: 허용하면 무엇을 허용하는지
  secret?: MissionSecretSpec & { saved: boolean }; // 비밀값을 넣어야 하는 결정: 저장 위치와 이미 값이 들어 있는지(값 자체는 없음)
}

/** 텔레그램 연동 화면용 상태(토큰 값은 없음) */
export interface TgOptionsView {
  enabled: boolean; projects: string[] | null; missions: string[] | null;
  kinds: { review: boolean; results: boolean; commits: boolean; failures: boolean; limit: boolean; cycle: boolean };
  batchMinutes: number; sourceDetail: Record<string, boolean>; preview: Record<string, string[]>;
}
export interface TgStatusView {
  state: 'off' | 'no-token' | 'connecting' | 'connected' | 'error' | 'conflict' | 'unavailable'; reason: string | null; lastOkAt: string | null;
  tokenSet: boolean; tokenHint: string | null; secureStore: boolean; pendingOut: number; lastDenied: string | null;
  settings: TgOptionsView & { bot: { id: number; username: string; name: string } | null; link: { userId: number; chatId: number; name: string; at: string } | null; candidate: { userId: number; chatId: number; name: string; at: string } | null; linkCode: { code: string; link: string | null; expires: number } | null; epoch: number; target: { projectId: string; missionId: string } | null };
}

/** 사용량 속도 조절 화면용 */
export interface UsagePaceView {
  enabled: boolean; reservePct: number;
  sevenDay: { utilization: number; resetsAt: string } | null; fiveHour: { utilization: number; resetsAt: string } | null; reportedAt: string | null;
  waiting: boolean; until: string | null; text: string;
}

/** 매일 dev 반영 화면용 */
export interface DevSyncRepoResult { repo: string; status: 'pushed' | 'nothing' | 'skipped' | 'failed'; note: string; committed: number; excluded: string[]; sha: string | null }
export interface DevSyncView { enabled: boolean; hour: number; running: boolean; lastDay: string | null; lastAt: string | null; results: DevSyncRepoResult[] }

/** main 병합 요청: 큰 단원이 끝났다고 오퍼레이터가 판단하면 확인함에서 묻는다 */
export interface MissionMergeRequest {
  id: string; cycle: number; title: string; summary: string; at: string;
  status: 'pending' | 'merging' | 'done' | 'declined' | 'failed';
  results?: DevSyncRepoResult[]; via?: string;
}
