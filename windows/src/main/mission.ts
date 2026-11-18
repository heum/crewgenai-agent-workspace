// 운영: 오퍼레이터 루프(미션)
// 사용자 지시 → 오퍼레이터 계획(Claude, 구조화 출력) → 사이클 흐름 자동 구성·실행
//   (담당 Agent 수행 → Codex 리뷰 → Claude 재검토 → [검사] → 취합)
// → 오퍼레이터 판단(계속 / 사용자 확인 / 완료) → 사용자가 멈출 때까지 반복
// 오퍼레이터는 작업 완료·검토 필요·추가 정보 필요·사이클 상한 도달 때만 사용자에게 묻는다.
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsc, existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MissionCheckpoint, MissionLimits, MissionUsage, ResultStatus } from '../shared/types';
import type { Agent, GraphEdge, GraphNode, LiveEvent, Mission, MissionDetail, MissionEvent, MissionFile, MissionGap, MissionDecision, MissionResult, MissionChoice, MissionCommitRequest, ResultDemo, MissionPick, StaffProposal, MissionDenial, MissionBlocker, ProjectDoc, WorkingItem, MissionSnapshot, MissionStage, MissionStatus, PlanFields, RunDetail, WorkGraph } from '../shared/types';
import { touchesSecretEnv } from './cli/claudeCli';
import { buildClaudeArgs, claudeLimit, cleanEnv, interpretLine, type LimitInfo, type StreamSink, isOurProcess, killGroupAndWait, processStart, redact, redactDeep, startProcess, type ProcessHandle, type ResultInfo } from './cli/claudeCli';
import { now, uid, type Store } from './db';
import type { Engine } from './engine/engine';
import { allowedRoots, escapes, normRel, validateGraph } from './engine/validate';
import { autoLayout } from '../shared/layout';
import { checkArgv } from './checks';
import { LEARN_SCHEMA, type LearningStore } from './learning';
import { missionCommitsSince, revertCommits, syncRepoFastForward, tagSnapshot, workspaceHeads, workspaceRepos } from './git';
import { docReposFor, levelAllows, repoTestCommands, workBranchName, type CommandLevel } from './autopilot';
import { DEMO_FILE, readManifest } from './demo';

/** 사용자가 고를 선택지: 고르면 무엇이 달라지는지(effect), 추천 여부와 이유. 추천은 안내일 뿐 자동으로 고르지 않는다. */
const CHOICE_ITEMS = { type: 'array', items: { type: 'object', required: ['label', 'effect', 'recommended', 'why'], properties: {
  label: { type: 'string' }, effect: { type: 'string' }, recommended: { type: 'boolean' }, why: { type: 'string' } } } };
const STAFF_ITEMS = { type: 'array', items: { type: 'object', required: ['kind', 'agentCode', 'name', 'role', 'instructions', 'reason'], properties: {
  kind: { type: 'string', enum: ['add', 'update'] }, agentCode: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, instructions: { type: 'string' },
  workPaths: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } } } };
/** 사용자에게 무엇을 묻는가: 사용자만 정할 수 있는 결정만. 자료 정합성 문제는 직원·오퍼레이터가 처리하고 기록한다. */
const ASK_RULE = '- 사용자에게 묻는 것(gaps·question)은 사용자만 정할 수 있는 결정으로 한정한다: 제품이 어떻게 보이고 동작하는지, 범위·우선순위, 병합·배포·비용·외부 공개. 문서 줄 번호·개수·파일 위치·자료끼리의 작은 불일치·검증 기록 정리 같은 자료 정합성 문제는 묻지 않는다. 근거가 더 분명한 쪽(최신 사용자 결정 > 실제 코드 > 최신 문서)을 따르고, 따른 근거를 결과 보고의 기록 칸에 남긴다.';
/** 준비·정리 작업의 끝: 완벽이 아니라 다음 일을 시작할 수 있을 만큼. */
const ENOUGH_RULE = '- 기준 정리·자료 대조·검증 같은 준비 작업은 완벽을 목표로 하지 않는다. 다음 단계(개발·구현)를 시작할 수 있을 만큼 되면 넘어가고, 남은 정리는 개발 중 필요할 때 한다. 같은 자료를 다시 검증하는 사이클을 되풀이하지 않는다.';
/** 사용자에게 수작업을 맡기지 않는다: 직원이 못 하는 일은 보류하고 다음 일로 간다. */
/** 작업마다 사용자가 바로 열어 볼 결과물을 남긴다(계획·판단 공통) */
const RESULT_RULE = [
  '- 작업마다 사용자가 바로 열어 보고 확인할 수 있는 결과물을 남긴다. 작업 성격에 맞게: 화면 작업은 결과 화면 스크린샷(png) 또는 열어 볼 수 있는 html, 기능·서버 작업은 시험 결과 요약 문서와 바뀐 코드 파일, 설계·문서 작업은 그 문서. 계획의 outputs에 이 결과물을 넣는다.',
  '- 결과물이 사용자가 볼 수 없는 준비 작업(대조·검증 기록 정리)만으로 사이클을 채우지 않는다.',
].join('\n');
/** 판단: 작업별 결과물 목록 */
const RESULTS_RULE = '- results: 이번 사이클 작업마다 사용자가 열어 볼 결과물을 넣는다. path는 프로젝트 폴더 기준 상대 경로(실제로 있는 파일만) 또는 이 컴퓨터에서 실행 중인 화면 주소(http://localhost:포트/…, 실제로 띄운 경우만). changed에는 무엇이 달라졌는지 한 문장, check에는 사용자가 열어서 확인할 것(어디를 보고 무엇이 맞으면 되는지) 한 문장, verified에는 실제로 실행해 확인한 것과 결과(예: \'시험 139건 실행, 1건 실패\') 또는 \'미검증 — 이유\', remaining에는 남은 사항(없으면 빈 문자열)을 쓴다. 실패한 작업도 확인할 결과물이 있으면 넣고 changed에 실패를 밝힌다. 진행 보고(summary)에는 결과물 목록을 다시 쓰지 않는다.';
/** 시연: 작업 완료 기준은 사용자가 로컬에서 실제 기능을 실행해 확인할 수 있는 상태 */
function demoRule(plan: PlanFields): string {
  const file = `${plan.outputDir || 'crewgenai-output'}/${DEMO_FILE}`;
  return [
    `- 완료 기준은 사용자가 로컬에서 실제 기능을 실행해 볼 수 있는 상태다. 실행 가능한 기능(웹 화면·API·DB/관리 화면·앱)을 만든 작업은 시연을 마련한다. MD·소스·시험 기록은 보조 자료다. 문서만 만드는 작업은 문서가 결과물이다.`,
    `- 시연 목록 파일: ${file}. 앱이 이 파일을 읽어 사용자가 버튼으로 서비스를 켜고 끈다(사용자는 터미널을 쓰지 않는다). 형식: {"services":[{"id":"api-server","name":"API 서버","kind":"api|web|admin|app","repo":"저장소 폴더","start":["./scripts/run.sh","인자"] 또는 ["npm","run","dev"],"port":8081,"health":"/actuator/health","env":{"SPRING_PROFILES_ACTIVE":"demo"},"needs":["먼저 켤 서비스 id"],"data":"api+db|screen-only|mock","note":"시연용 데이터 설명","startupSec":180}],"apis":[{"service":"api-server","id":"list-items","group":"항목 관리","title":"항목 목록","method":"GET","path":"/api/...","headers":{"Authorization":"Bearer {{token}}"},"body":{},"description":"무엇을 하는지","expect":"정상 200·오류 401 예","capture":{"token":"응답 JSON 경로"}}]}`,
    `- 시연 원칙: 기존 데이터에 영향이 없는 시연용 데이터(별도 시연 프로필·별도 로컬 DB·예시 계정)를 쓴다. 비밀값은 목록 env에 넣지 않는다(시연 프로필 설정 파일에). 연결된 작업은 같은 시연 환경을 함께 쓰고, 작은 수정마다 새 환경을 만들지 않는다. API는 apis 항목(앱의 API 시연 화면에서 직접 호출)에 로그인·정상·오류 예시를 넣는다. DB·ERP 변경은 조회·등록·수정이 되는 관리 화면(기존 관리 화면을 우선 활용)과 다시 조회해 저장값을 확인하는 흐름으로 보여 준다. 화면만 있고 API·DB가 연결되지 않았거나 예시·대체 응답을 쓰면 data를 screen-only·mock으로 표시한다.`,
    `- 서버 실행·시연 확인은 앱이 한다: 직원은 서비스를 직접 띄워 오래 기다리지 않는다(시간 제한에 걸림). 시연 목록을 정확히 만들고 빌드·단위 시험까지 하면, 앱이 판단 직전에 사용자가 승인한 서비스를 켜고 상태 확인·API를 보내 결과를 '앱이 직접 확인한 시연 결과'로 넘긴다. 판단은 그 결과를 검증 근거로 쓴다.`,
  ].join('\n');
}
/** 운영 흐름: 큰 기능을 먼저 만들고, 사람의 검토는 의미 있는 결과가 준비된 지점에 모은다 */
const FLOW_RULE = [
  '- 운영 흐름: 문서·기존 합의 파악 → 실행 준비 → 전체 화면과 큰 기능 구현 → 직접 시연·검증 → 사용자 검토(묶어서 한 번에) → 피드백 반영·같은 시연으로 재검증 → 다음 큰 단계. 작업 순서는 사용자가 확인할 수 있는 큰 기능·업무 흐름 기준으로 잡는다. 내부 작업을 작게 나눠도 그것을 사용자 승인 단계로 만들지 않는다.',
  '- 첫 검토 지점에서는 전체 화면 구조와 주요 사용자 흐름이 보이고, 대표 핵심 흐름 하나는 처음부터 끝까지 실제로 동작해야 한다. 아직 안 된 화면·기능은 화면에 "준비 중"으로 분명히 표시한다. 세부를 완벽하게 만들려고 큰 결과 전달을 미루지 않는다.',
  '- 합의된 범위의 일반 구현·로컬 실행·시험·오류 수정·화면 조정·문서 보완은 묻지 않고 진행한다.',
  '- 사이클 상한·연장·자동 진행 횟수는 앱이 관리한다. 질문·선택지·보고에 사이클 상한이나 연장을 쓰지 않는다.',
].join('\n');
/** 문서가 부족한 부분: 되돌리기 쉬운 세부는 가정하고 진행, 사람이 정할 것만 결정으로 모은다 */
const ASSUME_RULE = '- gaps.kind: 되돌리기 쉬운 세부(배치·문구·표현·구현 방식·작은 데이터 형식·기준 문서끼리의 작은 차이)는 kind=assume으로 쓰고 assumption에 무엇으로 가정해 진행하는지 한 문장으로 쓴다. 이 항목은 묻지 않고 그 가정대로 작업을 계획하며, 앱이 검토 지점에서 사용자에게 알린다. 제품 방향·중요한 업무 정책·범위·비용·외부 공개처럼 사람이 정해야 하는 것만 kind=decide. decide라도 그것 없이 할 수 있는 작업이 있으면 진행하고 검토 지점에서 묻는다(blocking=false). 이 결정 없이는 아무 작업도 할 수 없을 때만 blocking=true. 이미 사용자 결정·가정 목록에 있는 항목은 다시 쓰지 않는다.';
/** 판단: 검토 지점·결과 상태 */
const CHECKPOINT_RULE = [
  '- review: 사용자가 직접 보고 판단할 만한 큰 결과(전체 화면 흐름, 큰 기능의 시연)가 준비됐을 때 고른다. checkpoint에 title(이번에 검토할 큰 기능), features(name·changed·status), steps(사용자가 눌러 볼 순서와 예상 결과), verified(실제로 확인한 범위), unverified(미완성·미검증), decisions(사용자 판단이 필요한 핵심, 최대 3개, 각 choices 2~4개와 추천 하나), assumptions(가정하고 진행한 세부)를 쓴다. 작은 판단마다 review·ask_user를 고르지 않는다.',
  '- ask_user는 그 결정·정보 없이는 어떤 작업도 진행할 수 없을 때만 고른다. 진행할 수 있는 일이 남아 있으면 continue하고 결정은 다음 검토 지점(checkpoint.decisions)에 모은다.',
  '- results의 status: implemented(코드·파일만 있음), ran(실행해 봄), verified(실제 기능을 동작시켜 확인), reviewable(사용자가 시연으로 볼 수 있게 준비됨), feedback_applied(사용자 피드백을 반영하고 같은 시연으로 다시 확인). 파일 존재나 일부 단위 시험 통과만으로 verified·reviewable을 쓰지 않는다. 실행하지 못한 시험·연결되지 않은 기능은 remaining에 범위를 쓴다.',
].join('\n');
const RESULT_STATUSES = ['implemented', 'ran', 'verified', 'reviewable', 'feedback_applied'] as const;
const CHECKPOINT_SCHEMA = { type: 'object', properties: { title: { type: 'string' }, steps: { type: 'string' }, verified: { type: 'string' }, unverified: { type: 'string' },
  features: { type: 'array', items: { type: 'object', required: ['name', 'changed'], properties: { name: { type: 'string' }, changed: { type: 'string' }, status: { type: 'string', enum: [...RESULT_STATUSES] } } } },
  decisions: { type: 'array', items: { type: 'object', required: ['question'], properties: { question: { type: 'string' }, choices: CHOICE_ITEMS } } },
  assumptions: { type: 'array', items: { type: 'string' } } } };
/** 진전 없는 사이클이 이만큼 이어지면 멈추고 묻는다 */
const IDLE_LIMIT = 4;
const GAP_CAP = 40; // 미결 결정 보관 한도(답하지 않은 결정을 잘라 내 잃지 않게 넉넉히)
const NETWORK_RETRY_MS = 10 * 60_000; // 일시적인 연결 장애 뒤 다시 시도 간격
/** 오류 구분: 사용 한도는 따로(OperatorLimit) 처리하고, 로그인 만료·연결 장애·그 밖의 오류를 나눈다(모든 오류를 한도로 보지 않음) */
export function classifyError(msg: string): 'auth' | 'network' | 'other' {
  if (/\b401\b|unauthori[sz]ed|authentication|not logged in|log ?in (required|expired)|invalid (api )?key|oauth token|token (has )?expired|please run \/login/i.test(msg)) return 'auth';
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network (error|is unreachable)|\b(502|503|504|529)\b|overloaded|service unavailable|connection (error|reset|closed)/i.test(msg)) return 'network';
  return 'other';
} // 변경 없는 사이클이 이만큼 이어지면 진행 가능한 작업이 없는 것으로 본다
const COMMIT_RULE = [
  '- 앱이 할 수 있는 일(이것 말고는 계획·질문 선택지로 내지 않는다): 직원 작업이 바꾼 파일은 앱이 작업 브랜치에 자동 커밋한다. commitRequests로 요청한 커밋은 사용자가 팝업에서 파일·메시지를 보고 승인하면 앱이 그 파일만 커밋한다(push·PR·병합은 하지 않음). 시연 서비스 실행(사용자 승인), 보류한 명령·경로 허용(사용자 결정). 앱에 없는 동작(예: 반영 단계에서 문서에 적힌 파일 목록 커밋, push, PR)은 선택지로 내지 않는다.',
  '- commitRequests: 저장소에 이미 있는 미커밋 변경을 커밋해야 다음 일을 할 수 있을 때만 쓴다. repo는 프로젝트 폴더 기준 저장소 경로(폴더 자체가 저장소면 빈 문자열), files는 저장소 기준 경로로 실제로 바뀐 파일만, message는 커밋 메시지 한 줄, why는 왜 지금 필요한지 한 문장. 비밀값·.env·키 파일은 넣지 않는다. 커밋 여부를 질문 선택지로 따로 묻지 않는다. 아래 커밋 요청 목록에 이미 있는(대기·승인된) 요청은 다시 내지 않고, 거절된 요청은 사용자 결정으로 따른다.',
].join('\n');
const NO_MANUAL_RULE = '- 사용자에게 수작업을 맡기지 않는다: 앱에서 직원을 대신 실행하기, 터미널 명령 실행, 결과·원문 붙여넣기, 파일 직접 저장을 요청하거나 질문 선택지로 내지 않는다. 직원 권한·도구로 할 수 없는 일은 막힘(이유)으로 진행 보고에 남기고, 그 일 없이 할 수 있는 다음 개발 작업으로 넘어간다. 같은 막힘 때문에 같은 질문을 되풀이하지 않는다. 예외는 사용자만 할 수 있는 일(본인 계정 로그인, 비밀값 입력, 실제 메일·결제 같은 외부 발송 승인)뿐이며, 이때는 무엇을 왜 하는지 한 줄로 요청한다. 리뷰의 후속 항목([후속])은 다음 작업 목록에 기록만 하고 이번 작업을 다시 하지 않는다.';
/** 판단 summary = 사용자가 보고 판단하는 진행 보고 */
const REPORT_RULE = [
  '- summary는 사용자가 이것만 보고 진행을 판단하는 **진행 보고**다. 마크다운으로 아래 순서를 지킨다(없는 칸은 "없음"):',
  '  1. 한 줄 요약: 이번 사이클에 실제로 된 것.',
  '  2. `| 항목 | 상태 | 확인 방법 |` 표: 이번 사이클에 다룬 기능·작업 항목(문서의 ID가 있으면 ID와 쉬운 이름). 상태는 계획 / 코드 작성 / 시험 통과(직접 실행해 결과를 본 것만) / PR 필요(저장소·브랜치) / 막힘(이유) 중 하나. 확인 방법은 스크린샷·결과 파일 경로·시험 명령과 결과 수.',
  '  3. 진척: 이번 범위 전체 항목 수 대비 PR 필요·시험 통과·작업 중·막힘·시작 전 개수.',
  '  4. 사용자가 할 일: PR 병합(저장소·브랜치·한 줄 요약), 제품 결정(최대 3개, 쉬운 말).',
  '  5. 다음 사이클에 할 것(항목 3~5개).',
  '  6. 기록(접어 두는 칸): 자료 불일치를 어떻게 처리했는지 등 판단에 필요 없는 세부. 짧게.',
  '- 측정하지 않은 것은 상태를 올리지 않는다. 문서만 있는 항목을 코드·시험 통과로 쓰지 않는다.',
].join('\n');

const PLAN_SCHEMA = {
  type: 'object', required: ['summary', 'question', 'gaps', 'tasks'],
  properties: {
    summary: { type: 'string' }, question: { type: 'string' }, questionOptions: { type: 'array', items: { type: 'string' } }, questionChoices: CHOICE_ITEMS, staffProposals: STAFF_ITEMS,
    gaps: { type: 'array', items: { type: 'object', required: ['doc', 'issue', 'need'], properties: { doc: { type: 'string' }, issue: { type: 'string' }, need: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, choices: CHOICE_ITEMS, explain: { type: 'string' }, kind: { type: 'string', enum: ['decide', 'assume'] }, assumption: { type: 'string' }, blocking: { type: 'boolean' },
      refs: { type: 'array', items: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, line: { type: 'integer' } } } } } } },
    tasks: { type: 'array', items: { type: 'object', required: ['title', 'agentCode', 'instructions', 'writeScope', 'outputs', 'doneCriteria', 'checkCommand'],
      properties: { title: { type: 'string' }, agentCode: { type: 'string' }, instructions: { type: 'string' }, writeScope: { type: 'array', items: { type: 'string' } },
        outputs: { type: 'array', items: { type: 'object', required: ['path', 'format'], properties: { path: { type: 'string' }, format: { type: 'string', enum: ['markdown', 'json', 'html', 'text', 'code', 'image', 'any'] } } } },
        doneCriteria: { type: 'string' }, checkCommand: { type: 'array', items: { type: 'string' } },
        needs: { type: 'object', properties: { commands: { type: 'array', items: { type: 'string' } }, readPaths: { type: 'array', items: { type: 'string' } } } } } } },
  },
};
const JUDGE_SCHEMA = {
  type: 'object', required: ['decision', 'summary', 'question', 'nextFocus'],
  properties: { decision: { type: 'string', enum: ['continue', 'review', 'ask_user', 'done'] }, checkpoint: CHECKPOINT_SCHEMA, summary: { type: 'string' }, question: { type: 'string' }, questionOptions: { type: 'array', items: { type: 'string' } }, questionChoices: CHOICE_ITEMS, staffProposals: STAFF_ITEMS, nextFocus: { type: 'string' },
    results: { type: 'array', items: { type: 'object', required: ['task', 'title', 'path', 'changed', 'check'], properties: { task: { type: 'string' }, title: { type: 'string' }, path: { type: 'string' }, changed: { type: 'string' }, check: { type: 'string' }, verified: { type: 'string' }, remaining: { type: 'string' }, status: { type: 'string', enum: [...RESULT_STATUSES] },
      demo: { type: 'object', properties: { service: { type: 'string' }, path: { type: 'string' }, api: { type: 'string' }, steps: { type: 'string' }, expected: { type: 'string' }, data: { type: 'string', enum: ['api+db', 'screen-only', 'mock'] } } } } } },
    commitRequests: { type: 'array', items: { type: 'object', required: ['repo', 'files', 'message', 'why'], properties: { repo: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, message: { type: 'string' }, why: { type: 'string' }, task: { type: 'string' } } } } },
};
interface PlanTask { title: string; agentCode: string; instructions: string; writeScope: string[]; outputs: { path: string; format: GraphNode['outputs'][number]['format'] }[]; doneCriteria: string; checkCommand: string[]; needs?: { commands?: string[]; readPaths?: string[] } }
type RawStaff = { kind?: string; agentCode?: string; name?: string; role?: string; instructions?: string; workPaths?: string[]; reason?: string };
interface Plan { staffProposals?: RawStaff[]; summary: string; question: string; questionOptions?: string[]; questionChoices?: unknown; gaps?: MissionGap[]; tasks: PlanTask[] }
interface RawResult { status?: string; task?: string; title?: string; path?: string; changed?: string; check?: string; verified?: string; remaining?: string; demo?: { service?: string; path?: string; api?: string; steps?: string; expected?: string; data?: string } }
interface RawCommit { repo?: string; files?: string[]; message?: string; why?: string; task?: string }
interface RawCheckpoint { title?: string; steps?: string; verified?: string; unverified?: string; features?: { name?: string; changed?: string; status?: string }[]; decisions?: { question?: string; choices?: unknown }[]; assumptions?: string[] }
interface Judge { checkpoint?: RawCheckpoint; commitRequests?: RawCommit[]; results?: RawResult[]; staffProposals?: RawStaff[]; decision: 'continue' | 'review' | 'ask_user' | 'done'; summary: string; question: string; questionOptions?: string[]; questionChoices?: unknown; nextFocus: string }

/** 오퍼레이터의 커밋 요청 정리: 형식이 맞는 것만, 이미 대기·승인된 같은 요청은 빼고, 대기 요청은 최대 5개 */
export function cleanCommitRequests(raw: unknown, existing: MissionCommitRequest[], cycle: number): MissionCommitRequest[] {
  if (!Array.isArray(raw)) return [];
  const key = (repo: string, files: string[], msg: string) => JSON.stringify([repo, [...files].sort(), msg]);
  const seen = new Set(existing.filter((r) => r.status === 'pending' || r.status === 'approved').map((r) => key(r.repo, r.files, r.message)));
  let room = Math.max(0, 5 - existing.filter((r) => r.status === 'pending').length);
  const out: MissionCommitRequest[] = [];
  for (const x of raw as RawCommit[]) {
    if (!room) break;
    const r0 = String(x?.repo ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').slice(0, 300); const repo = r0 === '.' ? '' : r0;
    const files = [...new Set((Array.isArray(x?.files) ? x.files : []).map((f) => String(f ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))].slice(0, 100);
    const message = String(x?.message ?? '').trim().slice(0, 300);
    if (!files.length || !message) continue;
    const k = key(repo, files, message);
    if (seen.has(k)) continue;
    seen.add(k); room--;
    out.push({ id: uid(), cycle, repo, files, message, why: String(x?.why ?? '').trim().slice(0, 500), task: String(x?.task ?? '').trim().slice(0, 200), status: 'pending', sha: null, branch: null, error: null, at: now(), decidedAt: null });
  }
  return out;
}

/** 오퍼레이터가 낸 선택지 정리: 빈 값·중복을 빼고 최대 4개, 각 200자 */
function cleanOptions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) { const t = String(x ?? '').trim().slice(0, 200); if (t && !out.includes(t)) out.push(t); if (out.length >= 4) break; }
  return out;
}
/** 선택지 정리: 최대 4개, 추천은 하나만(처음 것). 선택지 문구가 없으면 버린다. */
export function cleanChoices(v: unknown): MissionChoice[] {
  if (!Array.isArray(v)) return [];
  const out: MissionChoice[] = []; let rec = false;
  for (const x of v as Record<string, unknown>[]) {
    const label = redact(String(x?.label ?? '').trim()).slice(0, 200);
    if (!label || out.some((c) => c.label === label)) continue;
    const recommended = !!x?.recommended && !rec; if (recommended) rec = true;
    out.push({ label, effect: redact(String(x?.effect ?? '').trim()).slice(0, 400), recommended, why: recommended ? redact(String(x?.why ?? '').trim()).slice(0, 300) : '' });
    if (out.length >= 4) break;
  }
  return out;
}
/** 질문 선택지: 설명이 있는 선택지를 우선하고, 없으면 예전 문구 목록 */
function pickChoices(choices: unknown, options: unknown): { opts: string[]; choices: MissionChoice[] } {
  const ch = cleanChoices(choices);
  return ch.length ? { opts: ch.map((c) => c.label), choices: ch } : { opts: cleanOptions(options), choices: [] };
}
const gapKey = (g: { doc: string; issue: string }) => `${g.doc.trim()}|${g.issue.trim()}`;

type Row = Record<string, unknown>;
/** Windows판은 직원이 Bash를 쓰지 않는다(OS 격리 없음): 명령이 필요한 작업은 실행 전에 사용자 확인으로 돌린다 */
const BASH_OK = false;

export interface MissionDeps {
  store: Store;
  engine: Engine;
  emit: (e: LiveEvent) => void;
  executor: () => { executor: 'claude' | 'mock'; cliPath: string | null };
  mockScript: string;
  maxCycles: () => number;
  gitCommits?: () => boolean;
  ensureAgents: (projectId: string) => Agent[];
  /** 프로젝트 완성 문서(근거 문서) — 오퍼레이터가 계획 전에 근거가 충분한지 판단한다 */
  projectDocs?: (projectId: string) => ProjectDoc[];
  /** 배운 것 — 지시·답변에서 배운 사실을 저장하고 오퍼레이터 지시에 붙인다 */
  learnings?: LearningStore;
  learnEnabled?: () => boolean;
  autoAssist?: () => boolean; // 자동 처리: 문서 저장소 최신화, 저장소 시험 명령 허용, 작업 브랜치 자동 생성
  commandLevel?: () => CommandLevel; // 명령 허용 범위
  testLocalSockets?: () => boolean; // 시험·시연용 로컬 포트 열기 허용
  /** 앱이 직접 하는 시연 확인(승인된 서비스만 켜고 상태·안전한 API 확인) */ demoVerify?: (projectId: string) => Promise<string[]>;
}

/** 오퍼레이터 호출이 사용 한도에 걸림 */
class OperatorLimit extends Error { constructor(public lim: LimitInfo) { super('오퍼레이터 호출이 사용 한도에 걸렸습니다.'); this.name = 'OperatorLimit'; } }

/** 거부된 명령에서 허용 명령 접두어 후보를 만든다: 첫 단순 명령의 이름과 그 뒤 옵션(값 포함). 예) 'shasum -a 256 /x/y' → 'shasum -a 256', 'git -C /repo log' → 'git -C' */
export function commandPrefix(command: string): string | null {
  // 'cd 폴더 && 명령'처럼 폴더 이동이 앞에 오면 실제로 필요한 것은 뒤의 명령이다(cd 허용은 의미가 없다)
  const parts = command.split(/;|&&|\|\||\|/).map((x) => x.trim()).filter(Boolean);
  const first = parts.find((x) => !/^cd(\s|$)/.test(x)) ?? parts[0] ?? '';
  const toks = first.split(/\s+/).filter(Boolean);
  // 앞에 붙은 변수 지정(F=/tmp/x cmd)은 명령 이름이 아니다. 따옴표로 시작하면 정확히 끊을 수 없으니 한 번에 허용할 명령으로 제안하지 않는다.
  while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift();
  if (!toks.length || /^["']/.test(toks[0])) return null;
  const out = [toks[0]];
  for (let i = 1; i < toks.length && out.length < 4; i++) {
    const t = toks[i];
    if (!t.startsWith('-')) break;
    out.push(t);
    const v = toks[i + 1];
    if (v && !v.startsWith('-') && /^[\w.=:-]{1,12}$/.test(v) && !/[\/\\]/.test(v) && t.length === 2 && /^-[a-z]$/i.test(t) && /^\d+$|^[a-z]+$/i.test(v) && toks[0] !== 'git') { out.push(v); i++; }
  }
  return out.join(' ');
}

/** 에이전트가 고칠 수 없는 내 PC 환경 문제로 보이는 실패(명령·프로그램 없음, 접근 거부, 네트워크·로그인) */
// 프로세스·도구 수준의 신호만 본다(앱 기능을 설명하는 'authentication' 같은 단어로 잘못 멈추지 않게)
export const ENV_FAILURE = /\b(ENOENT|EACCES|EPERM|ENOTFOUND|ECONNREFUSED|EAI_AGAIN)\b|command not found|is not recognized as an internal or external command|검사를 실행하지 못함|프로세스 시작 실패|실행 파일\(.*\)을 해석하지 못했습니다|Claude CLI가 준비되지 않았습니다|not logged in|로그인되지 않았습니다|network is unreachable/i;
/** 실패 원인을 비교용 문자열로: 숫자·경로·해시를 지워 같은 원인이면 같은 값이 되게 */
export function failureSig(reason: string, step = ''): string {
  const exit = /종료 코드 (-?\d+|없음)/.exec(reason)?.[1] ?? '';
  return `${step.replace(/\d+/g, '').trim()}|${exit}|` + reason.toLowerCase().replace(/[a-z]:\\[^\s]+|\/[^\s]+/gi, '<경로>').replace(/[0-9a-f]{7,}/g, '<값>').replace(/\d+/g, '<수>').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export class MissionRunner {
  private loops = new Set<string>();
  private demoChecks = new Map<string, string[]>(); // 미션별 최근 앱 시연 확인 결과
  private procs = new Map<string, ProcessHandle>();
  private closed = false;
  private replan = new Set<string>(); // '지금 반영' 추가 지시를 받은 미션
  private wakeLimit = new Set<string>(); // 사용 한도 대기 중 '지금 다시 시도'

  constructor(private d: MissionDeps) {
    d.store.db.exec(`CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, project_id TEXT, data TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS mission_events (mission_id TEXT, seq INTEGER, data TEXT, PRIMARY KEY(mission_id, seq));
      CREATE TABLE IF NOT EXISTS mission_cycles (mission_id TEXT, cycle INTEGER, run_id TEXT, PRIMARY KEY(mission_id, cycle));
      CREATE TABLE IF NOT EXISTS mission_procs (mission_id TEXT PRIMARY KEY, pid INTEGER, proc_start TEXT, marker TEXT);
      CREATE TABLE IF NOT EXISTS mission_snapshots (mission_id TEXT, tag TEXT, name TEXT, sha TEXT, cycle INTEGER, created_at TEXT, PRIMARY KEY(mission_id, tag));
      CREATE TABLE IF NOT EXISTS mission_snapshot_repos (mission_id TEXT, tag TEXT, repo TEXT, sha TEXT, PRIMARY KEY(mission_id, tag, repo));`);
  }

  // ───── 저장 ─────
  get(id: string): Mission {
    const r = this.d.store.db.prepare('SELECT data FROM missions WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new Error('미션을 찾을 수 없습니다.');
    return JSON.parse(String(r.data)) as Mission;
  }
  list(projectId: string): Mission[] {
    return (this.d.store.db.prepare('SELECT data FROM missions WHERE project_id=? ORDER BY updated_at DESC').all(projectId) as Row[]).map((r) => redactDeep(JSON.parse(String(r.data)) as Mission));
  }
  private save(m: Mission): Mission {
    m.updatedAt = now();
    this.d.store.db.prepare('INSERT INTO missions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at').run(m.id, m.projectId, JSON.stringify(m), m.updatedAt);
    this.d.emit({ type: 'mission', mission: redactDeep(m) });
    return m;
  }
  private set(id: string, patch: Partial<Mission>): Mission {
    return this.save({ ...this.get(id), ...patch });
  }
  private event(m: Mission, kind: MissionEvent['kind'], text: string, data: unknown = null): void {
    const r = this.d.store.db.prepare('SELECT COALESCE(MAX(seq),0) s FROM mission_events WHERE mission_id=?').get(m.id) as Row;
    const ev: MissionEvent = { missionId: m.id, seq: Number(r.s) + 1, at: now(), kind, cycle: m.cycle, text: redact(text), data: data === null ? '' : JSON.stringify(redactDeep(data), null, 2) };
    this.d.store.db.prepare('INSERT INTO mission_events VALUES(?,?,?)').run(m.id, ev.seq, JSON.stringify(ev));
    this.d.emit({ type: 'missionEvent', event: ev });
  }
  events(id: string): MissionEvent[] {
    return (this.d.store.db.prepare('SELECT data FROM mission_events WHERE mission_id=? ORDER BY seq').all(id) as Row[]).map((r) => JSON.parse(String(r.data)) as MissionEvent);
  }
  detail(id: string): MissionDetail {
    const mission = this.get(id);
    const cycles = (this.d.store.db.prepare('SELECT cycle, run_id FROM mission_cycles WHERE mission_id=? ORDER BY cycle').all(id) as Row[]).map((r) => {
      const run = this.d.store.getRun(String(r.run_id));
      return { cycle: Number(r.cycle), runId: run.id, status: run.status, graphVersion: run.graphVersion };
    });
    const runId = mission.currentRunId ?? cycles.at(-1)?.runId ?? null;
    let currentRun: RunDetail | null = null;
    if (runId) { try { currentRun = this.d.engine.detail(runId); } catch { currentRun = null; } }
    const events = this.events(id);
    return { mission: redactDeep(mission), events, cycles, currentRun, files: this.files(mission, cycles, events), working: this.working(mission.projectId) };
  }

  /** 프로젝트에서 지금 일하는 직원: 실행 중인 시도(작성·검토·Codex·검사)와 진행 중인 오퍼레이터 호출 */
  working(projectId: string): WorkingItem[] {
    const out: WorkingItem[] = [];
    const agents = new Map(this.d.store.listAgents(projectId).map((a) => [a.id, a]));
    const op = [...agents.values()].find((a) => a.code === '00');
    for (const m of this.list(projectId)) {
      if (!this.procs.has(m.id) || !['planning', 'evaluating'].includes(m.status)) continue;
      out.push({ agentId: op?.id ?? null, who: `${op ? `${op.code} ${op.name}` : '00 총괄'}(오퍼레이터)`, kind: 'operator', task: m.status === 'planning' ? `사이클 ${m.cycle} 계획` : `사이클 ${m.cycle} 판단`, runId: null, missionId: m.id, since: m.updatedAt });
    }
    for (const r of this.d.store.listRuns(projectId)) {
      if (!this.d.engine.isActive(r.id)) continue;
      let labels = new Map<string, string>();
      let graph: WorkGraph | null = null;
      try { graph = this.d.store.getGraphVersion(r.graphVersionId).graph; labels = new Map(graph.nodes.map((n) => [n.id, n.label])); } catch { /* 그대로 */ }
      const nodeOf = (id: string) => graph?.nodes.find((n) => n.id === id);
      // 검토·리뷰·검사 단계에서 앞쪽으로 거슬러 올라가 대상 작성 단계의 담당을 찾는다
      const authorOf = (id: string): string | null => {
        const seen = new Set<string>(); let cur = [id];
        while (cur.length && graph) {
          const next: string[] = [];
          for (const c of cur) for (const e of graph.edges.filter((x) => x.target === c && x.kind !== 'fail')) {
            if (seen.has(e.source)) continue; seen.add(e.source);
            const n = nodeOf(e.source);
            if (n?.kind === 'agent') return n.agentId;
            if (n && n.kind !== 'input') next.push(n.id);
          }
          cur = next;
        }
        return null;
      };
      const DOC = /\.(md|markdown|txt|html?|pdf|docx?|rtf|csv)$/i;
      const missionId = (this.d.store.db.prepare("SELECT value FROM run_meta WHERE run_id=? AND key='mission'").get(r.id) as Row | undefined)?.value;
      for (const a of this.d.store.runAttempts(r.id).filter((x) => x.status === 'running')) {
        const ag = a.agentId ? agents.get(a.agentId) : undefined;
        const kind = (a.role === 'author' || a.role === 'reviewer' || a.role === 'codex' || a.role === 'check') ? a.role : 'author';
        const who = kind === 'codex' ? 'Codex 리뷰' : kind === 'check' ? '자동 검사' : ag ? `${ag.code} ${ag.name}` : '(직원 정보 없음)';
        const node = nodeOf(a.nodeId);
        const outs = node?.outputs.map((o) => o.path) ?? [];
        const mode = kind === 'author' ? (outs.length && outs.every((p) => DOC.test(p)) ? 'doc' as const : 'code' as const) : undefined;
        const reviewOf = kind === 'author' ? null : authorOf(a.nodeId);
        out.push({ agentId: ag?.id ?? null, who, kind, task: labels.get(a.nodeId) ?? a.nodeId, runId: r.id, missionId: missionId ? String(missionId) : null, since: a.startedAt, reviewOf, ...(mode ? { mode } : {}) });
      }
    }
    return out;
  }

  /** 결과물 파일 목록: 사이클 실행의 등록 산출물 + 진행 기록 문장에 나온 프로젝트 안 실제 파일. 프로젝트 폴더 밖은 넣지 않는다. */
  private files(m: Mission, cycles: { cycle: number; runId: string }[], events: MissionEvent[]): MissionFile[] {
    let folder = '';
    try { folder = this.d.store.getProject(m.projectId).plan.folder; } catch { return []; }
    if (!folder || !existsSync(folder)) return [];
    let root = folder; try { root = realpathSync(folder); } catch { /* 그대로 */ }
    const inside = (abs: string) => { try { const r = relative(root, realpathSync(abs)); return !!r && !r.startsWith('..') && !isAbsolute(r); } catch { return false; } };
    const out = new Map<string, MissionFile>();
    for (const c of [...cycles].reverse()) {
      for (const a of this.d.store.artifacts(c.runId).reverse()) {
        if (out.has(a.relPath)) continue;
        const ok = existsSync(a.path);
        if (ok && !inside(a.path)) continue;
        out.set(a.relPath, { relPath: a.relPath, path: a.path, cycle: c.cycle, kind: a.kind, exists: ok, createdAt: a.createdAt });
      }
    }
    // 기록 문장 속 상대 경로(예: docs/mission/cycle-1.md) — 실제로 있는 파일만
    const re = /(?:^|[\s`'"(（「])((?:[\w가-힣.@-]+\/)*[\w가-힣@-][\w가-힣.@-]*\.[A-Za-z0-9]{1,8})(?=$|[\s`'"),.:;)）」])/g;
    for (const e of events) {
      for (const mm of e.text.matchAll(re)) {
        const rel = mm[1].replace(/^\.\//, '');
        if (out.has(rel) || rel.includes('..') || rel.length > 300) continue;
        const abs = join(folder, ...rel.split('/'));
        try { if (!statSync(abs).isFile() || !inside(abs)) continue; } catch { continue; }
        out.set(rel, { relPath: rel, path: abs, cycle: e.cycle, kind: null, exists: true, createdAt: null });
        if (out.size > 200) break;
      }
    }
    return [...out.values()];
  }

  // ───── 사용자 조작 ─────
  /** 미션은 한 번에 하나만: 앱 전체에서 작동 중인 미션, 또는 이 프로젝트에서 열려 있는(확인 대기·완료 보고) 미션 */
  blocking(projectId: string): Mission | null {
    const all = (this.d.store.db.prepare('SELECT data FROM missions').all() as Row[]).map((r) => JSON.parse(String(r.data)) as Mission);
    return all.find((m) => ['planning', 'running', 'evaluating'].includes(m.status))
      ?? all.find((m) => m.projectId === projectId && ['waiting_user', 'done'].includes(m.status)) ?? null;
  }

  start(projectId: string, prompt: string, limitsIn?: Partial<MissionLimits> | null): Mission {
    if (!prompt.trim()) throw new Error('지시 내용을 입력하세요.');
    const limits = cleanLimits(limitsIn, this.d.store.listAgents(projectId).filter((a) => a.active));
    const b = this.blocking(projectId);
    if (b) throw new Error(b.projectId === projectId
      ? `이 프로젝트에 열려 있는 미션이 있습니다(${b.status === 'done' ? '완료 보고' : b.status === 'waiting_user' ? '확인 대기' : '작동 중'}). 그 미션에 추가 지시하거나 종료한 뒤 새로 지시하세요.`
      : '다른 프로젝트에서 미션이 작동 중입니다. 미션은 한 번에 하나만 작동합니다. 그 미션을 마치거나 중단한 뒤 지시하세요.');
    const t = now();
    const m = this.save({ id: uid(), projectId, prompt: prompt.trim(), status: 'planning', stage: 'instruction', cycle: 1, maxCycles: Math.max(1, this.d.maxCycles()), currentRunId: null, question: null, summary: '', createdAt: t, updatedAt: t, limits, usage: emptyUsage(), readyChecked: false });
    this.event(m, 'user', prompt.trim());
    if (limits) { const names = limits.staff ? this.d.store.listAgents(projectId).filter((a) => limits.staff!.includes(a.id)).map((a) => `${a.code} ${a.name}`) : null;
      this.event(m, 'system', `참여 직원: ${names!.join(', ')}(오퍼레이터 외 다른 직원은 배정하지 않음)`, { limits }); }
    void this.loop(m.id);
    return m;
  }

  answer(id: string, text: string, action: 'continue' | 'stop', keep?: Partial<Mission> | 'pending'): Mission {
    const m = this.get(id);
    // 중단한 미션도 '이어서 다시 시작'할 수 있다(같은 미션 기록·스냅샷을 이어받아 다음 사이클부터 다시 계획)
    if (!['waiting_user', 'done', 'failed', 'stopped'].includes(m.status)) throw new Error('지금은 답변을 기다리는 상태가 아닙니다.');
    if (m.status === 'stopped' && action === 'stop') return m;
    if (action === 'continue') {
      // 미션은 한 번에 하나만: 다른 미션이 작동 중이거나, 같은 프로젝트에 다른 열린 미션이 있으면 이어서 진행하지 않는다
      const all = (this.d.store.db.prepare('SELECT data FROM missions').all() as Row[]).map((r) => JSON.parse(String(r.data)) as Mission);
      if (all.find((x) => x.id !== id && ['planning', 'running', 'evaluating'].includes(x.status))) throw new Error('다른 미션이 작동 중입니다. 미션은 한 번에 하나만 작동합니다. 그 미션을 마치거나 중단한 뒤 계속하세요.');
      if (all.find((x) => x.id !== id && x.projectId === m.projectId && ['waiting_user', 'done'].includes(x.status))) throw new Error('이 프로젝트에 열려 있는 다른 미션이 있습니다. 그 미션을 종료한 뒤 다시 시작하세요.');
    }
    if (text.trim()) this.event(m, m.status === 'stopped' ? 'directive' : 'answer', text.trim());
    if (m.status === 'stopped') this.event(m, 'system', `중단했던 미션을 이어서 다시 시작합니다(이전 판단·답변·추가 지시와 스냅샷을 이어받음).`);
    if (action === 'stop') { this.event(m, 'system', '사용자가 미션을 종료했습니다.'); const st = this.set(id, { status: 'stopped', stage: 'stopped', question: null }); void this.learn(id); return st; }
    // 이번 사이클에 실행이 있었으면 다음 사이클로, 계획 단계 질문이었으면 같은 사이클을 다시 계획한다. 상한은 사용자 승인만큼 늘린다.
    const ran = !!this.d.store.db.prepare('SELECT 1 FROM mission_cycles WHERE mission_id=? AND cycle=?').get(id, m.cycle);
    const cycle = ran ? m.cycle + 1 : m.cycle;
    const next = this.set(id, { ...(m.checkpoint?.reason === 'blocked' ? { readyChecked: false } : {}), checkpoint: null, pauseKind: null, sinceReview: 0, status: 'planning', stage: 'plan', question: null, questionOptions: null, questionChoices: null, gaps: null, denials: null, blockers: null, parkedSigs: [], idleCycles: 0, cycle, maxCycles: Math.max(m.maxCycles, cycle + this.d.maxCycles() - 1), ...(keep === 'pending' ? { gaps: m.gaps ?? null, denials: m.denials ?? null, blockers: m.blockers ?? null, parkedSigs: m.parkedSigs ?? [] } : keep ?? {}) });
    void this.loop(id);
    return next;
  }

  /** 검토 지점 없이 자동으로 진행할 사이클 수(설정). 비용·시간 한도 역할을 한다. */
  reviewBudget(): number { return Math.max(1, this.d.maxCycles()); }

  /**
   * 검토 지점 답변: 고른 결정은 미션 결정으로 쌓아 다시 묻지 않고, 피드백은 다음 사이클의 최우선 지시로 넘긴 뒤 이어서 진행한다.
   * 고르지 않은 결정은 남겨 다음 검토 지점에 다시 보여 준다(침묵·닫기를 승인으로 보지 않음).
   */
  review(id: string, picks: { doc?: string; question: string; choice: string }[], feedback: string, action: 'continue' | 'stop'): Mission {
    const m = this.get(id);
    if (!m.checkpoint || !['waiting_user', 'done', 'planning', 'running', 'evaluating'].includes(m.status)) throw new Error('지금 열린 검토 지점이 없습니다.');
    // 미션을 멈추게 한 검토 카드(blocking)이거나 완료 보고 뒤면 답과 함께 이어서 진행한다. 그 밖(진행 중이거나, 다른 질문으로 기다리는 중의 정기 카드)은 기록만 하고 지금 상태를 바꾸지 않는다.
    const live = !(m.status === 'done' || (m.status === 'waiting_user' && m.checkpoint.blocking)); // 개발이 계속 진행 중인 검토 카드(멈추지 않은 상태)
    const at = now();
    const cp = m.checkpoint;
    // 검토 카드에 보여 준 항목(doc+질문)과 정확히 같은 것만 결정으로 기록한다(원래 항목의 식별자를 그대로 써서 다시 묻지 않게)
    const shown = new Map(cp.decisions.map((d) => [`${d.doc}|${d.question}`, d]));
    const made: MissionDecision[] = [];
    for (const p of Array.isArray(picks) ? picks : []) {
      const key = `${String(p?.doc ?? '검토 지점')}|${String(p?.question ?? '')}`; const choice = redact(String(p?.choice ?? '').trim()).slice(0, 600);
      const d = shown.get(key); if (!d || !choice) continue;
      made.push({ doc: d.doc, issue: d.question, choice, at });
    }
    if (made.length) this.event(m, 'answer', `검토 지점 결정:\n${made.map((d) => `- ${d.issue} → ${d.choice}`).join('\n')}`, { decisions: made });
    const fb = redact(String(feedback ?? '').trim()).slice(0, 4000);
    if (fb) this.event(m, 'directive', `[검토 피드백 · 사이클 ${cp.cycle}] ${fb}`);
    // 결정·피드백 없이 넘겨도 사용자가 직접 확인했다는 기록을 남긴다(자동 진행과 구분)
    if (!made.length && !fb) this.event(m, 'answer', action === 'stop' ? `검토 지점 확인(사이클 ${cp.cycle}): 여기서 종료` : `검토 지점 확인(사이클 ${cp.cycle}): 피드백 없이 이어서 진행`);
    const answered = new Set(made.map((d) => gapKey(d)));
    // 고르지 않은 결정은 미결 항목으로 남겨 다음 검토 지점에 다시 보여 준다(침묵·닫기를 승인으로 보지 않음)
    // 같은 내용을 다른 문서 이름으로 다시 묻지 않게: 답한 결정과 같은 대상(따옴표로 인용한 문구가 같음)인 미결 항목도 닫는다
    const leftGaps = (m.gaps ?? []).filter((g) => !answered.has(gapKey(g)) && !made.some((d) => sameSubject(d.issue, g.issue)));
    for (const d of cp.decisions) {
      const g: MissionGap = { doc: d.doc, issue: d.question, need: '', kind: 'decide', ...(d.choices.length ? { choices: d.choices, options: d.choices.map((c) => c.label) } : {}) };
      if (!answered.has(gapKey(g)) && !leftGaps.some((x) => gapKey(x) === gapKey(g))) leftGaps.push(g);
    }
    this.set(id, { decisions: [...(m.decisions ?? []), ...made] });
    if (live) {
      // 진행 중: 결정·피드백은 다음 계획부터 반영하고, 지금 실행은 그대로 둔다. 종료를 고르면 미션을 중지한다.
      if (action === 'stop') { void this.stop(id); return this.get(id); }
      return this.set(id, { checkpoint: null, gaps: leftGaps.length ? leftGaps.slice(0, GAP_CAP) : null });
    }
    return this.answer(id, '', action, { gaps: leftGaps.length ? leftGaps.slice(0, GAP_CAP) : null, denials: m.denials ?? null, blockers: m.blockers ?? null, parkedSigs: m.parkedSigs ?? [] });
  }

  /** 보류한 업무를 사용자가 해결함(권한 허용·환경 수정 등): 보류를 풀어 다음 계획부터 다시 시도할 수 있게 한다 */
  retryParked(id: string, sigs?: string[]): Mission {
    const m = this.get(id);
    if (Array.isArray(sigs) && sigs.length) {
      // 사용자가 정한 권한 항목만 푼다(다른 보류·결정 항목은 그대로)
      const set = new Set(sigs.map(String));
      const denials = (m.denials ?? []).filter((d) => !set.has(d.sig));
      if (denials.length === (m.denials ?? []).length) return m;
      this.event(m, 'answer', `보류한 업무 ${(m.denials ?? []).length - denials.length}건의 권한을 정했습니다. 다음 계획부터 다시 시도하세요.`);
      return this.set(id, { denials: denials.length ? denials : null, parkedSigs: (m.parkedSigs ?? []).filter((x) => !set.has(x)), denialSigs: (m.denialSigs ?? []).filter((x) => !set.has(x)) });
    }
    if (!m.denials?.length && !m.blockers?.length && !m.gaps?.length && !m.parkedSigs?.length) return m;
    this.event(m, 'answer', '보류한 업무를 해결했습니다. 다음 계획부터 다시 시도하세요.');
    return this.set(id, { denials: null, blockers: null, gaps: null, parkedSigs: [], denialSigs: [], failSigs: [] });
  }

  /**
   * 확인 필요 항목에 사용자가 고른 결정을 반영한다: 결정은 미션에 쌓여 다음 계획·판단에서 '사용자 결정'으로 그대로 따르고,
   * 결정한 항목은 확인 필요 목록에서 뺀다. resume이면(확인 대기 중일 때) 바로 이어서 진행한다.
   */
  decide(id: string, picks: MissionPick[], resume: boolean): Mission {
    const m = this.get(id);
    if (['planning', 'running', 'evaluating', 'waiting_user', 'done'].indexOf(m.status) < 0) throw new Error('끝난 미션에는 결정을 반영할 수 없습니다. 이어서 다시 시작한 뒤 결정하세요.');
    const gaps = m.gaps ?? [];
    // 항목은 순번이 아니라 문서·내용으로 찾는다: 화면이 새로 고쳐지기 전에 목록이 바뀌어도 다른 항목에 결정이 붙지 않게
    const seen = new Set<number>(); const made: MissionDecision[] = []; const at = new Date().toISOString();
    let stale = false;
    for (const p of Array.isArray(picks) ? picks : []) {
      const choice = String(p?.choice ?? '').trim().slice(0, 600);
      if (!choice) continue;
      const i = gaps.findIndex((g) => gapKey(g) === gapKey({ doc: String(p?.doc ?? ''), issue: String(p?.issue ?? '') }));
      if (i < 0) { stale = true; continue; }
      if (seen.has(i)) continue;
      seen.add(i); made.push({ doc: gaps[i].doc, issue: gaps[i].issue, choice: redact(choice), at });
    }
    if (!made.length) throw new Error(stale ? '확인 필요 목록이 바뀌었습니다. 화면을 새로 고친 뒤 다시 고르세요.' : '결정할 항목을 하나 이상 고르세요.');
    this.event(m, 'answer', `확인 필요 항목 결정:\n${made.map((d) => `- [${d.doc || '문서 미지정'}] ${d.issue} → ${d.choice}`).join('\n')}`, { decisions: made });
    const keys = new Set(made.map(gapKey));
    const decisions = [...(m.decisions ?? []).filter((d) => !keys.has(gapKey(d))), ...made]; // 결정은 지우지 않는다(같은 항목은 새 결정으로 바꿈)
    const rest = gaps.filter((_, i) => !seen.has(i));
    const next = this.set(id, { decisions, gaps: rest.length ? rest : null });
    // 확인 대기 중이면 바로 이어서 계획한다. 고르지 않은(나중에) 항목은 확인 필요로 그대로 남긴다.
    // 결정은 근거 부족 항목만 푼다: 고르지 않은 항목과 보류한 업무(권한·환경)는 그대로 둔다
    if (resume && next.status === 'waiting_user') return this.answer(id, '', 'continue', { gaps: rest.length ? rest : null, denials: m.denials ?? null, blockers: m.blockers ?? null, parkedSigs: m.parkedSigs ?? [] });
    return next;
  }

  /**
   * 실행 전 권한 점검: 작업마다 오퍼레이터가 적은 필요 명령·읽을 경로가 담당 직원에게 허용돼 있는지 본다.
   * 허용되지 않은 작업은 이번 사이클에서 빼고(돌려 봐야 같은 거부로 실패) 확인 필요 항목으로 돌려준다.
   */
  private preflight(plan: PlanFields, agents: Agent[], tasks: PlanTask[]): { keep: PlanTask[]; held: { task: PlanTask; denials: MissionDenial[] }[] } {
    const by = (code: string) => agents.find((a) => a.code === code) ?? agents.find((a) => a.code === '00');
    const folder = resolve(plan.folder);
    const refs = [...plan.referenceDocs, ...plan.priorOutputs].map((r) => resolve(folder, r));
    const inside = (p: string, r: string) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
    const readable = (p: string, ag: Agent) => { const a = resolve(folder, p); return inside(a, folder) || [...refs, ...ag.references.map((r) => resolve(folder, r))].some((r) => inside(a, r)); }; // 직원에게 준 참조 자료도 읽을 수 있다
    const toks = (c: string) => c.trim().split(/\s+/).filter(Boolean);
    const auto = this.d.autoAssist?.() ? repoTestCommands(plan.folder).map((c) => c.prefix) : []; // 자동 처리: 저장소 시험 명령은 실행 때 허용된다
    const level: CommandLevel = BASH_OK ? (this.d.commandLevel?.() ?? 'low') : 'low';
    const hasBash = (a: Agent) => a.tools.includes('Bash') || (level !== 'low' && (a.tools.includes('Edit') || a.tools.includes('Write'))); // 중간·높음이면 쓰기 직원도 Bash를 받는다
    const allowed = (a: Agent, c: string) => BASH_OK && hasBash(a) && levelAllows(level, c, [...a.allowedCommands, ...auto]); // 묶은 명령은 부분마다 범위·직원 허용 명령으로 본다
    const keep: PlanTask[] = []; const held: { task: PlanTask; denials: MissionDenial[] }[] = [];
    for (const t of tasks) {
      const a = by(t.agentCode);
      if (!a) { keep.push(t); continue; }
      const ds: MissionDenial[] = [];
      for (const c of (t.needs?.commands ?? []).map(String).filter((x) => x.trim()).slice(0, 10)) {
        if (allowed(a, c)) continue;
        const suggestion = BASH_OK ? commandPrefix(c) : null;
        ds.push({ agentId: a.id, agent: `${a.code} ${a.name}`, tool: '실행 전 점검 · 명령', kind: BASH_OK ? 'command' : 'other', target: c.slice(0, 300), suggestion, sig: `pre|${a.id}|cmd|${suggestion ?? c}` });
      }
      for (const p of (t.needs?.readPaths ?? []).map(String).filter((x) => x.trim()).slice(0, 10)) {
        if (readable(p, a)) continue;
        const abs = resolve(folder, p);
        ds.push({ agentId: a.id, agent: `${a.code} ${a.name}`, tool: '실행 전 점검 · 읽기', kind: 'path', target: abs, suggestion: abs, sig: `pre|${a.id}|path|${abs}` });
      }
      if (ds.length) held.push({ task: t, denials: ds }); else keep.push(t);
    }
    return { keep, held };
  }

  /**
   * 이번 실행에서 직원이 권한 때문에 막힌 행위를 모은다: CLI가 보고한 권한 거부 목록 + 작업 폴더 밖 경로 거부(--restricted) 기록.
   * 권한은 지시문으로 바뀌지 않으므로, 같은 설정으로 다시 시도하지 않도록 미션을 멈추는 근거로 쓴다.
   */
  private permissionBlocks(runId: string): MissionDenial[] {
    const out: MissionDenial[] = [];
    const seen = new Set<string>();
    const agents = new Map(this.d.store.listAgents(this.d.store.getRun(runId).projectId, true).map((a) => [a.id, a]));
    const add = (agentId: string | null, tool: string, kind: MissionDenial['kind'], target: string) => {
      const t = target.trim().slice(0, 300);
      if (!t) return;
      // 비밀값 환경 파일(.env·.env.local 등)을 읽으려다 막힌 명령은 허용 명령을 더해도 풀리지 않는다(보호 규칙). 허용 후보를 내지 않는다.
      const secret = kind === 'command' && touchesSecretEnv(t);
      const suggestion = secret ? null : kind === 'command' ? commandPrefix(t) : kind === 'path' ? t : null;
      const sig = `${agentId ?? ''}|${tool}|${kind === 'command' && !secret ? suggestion : t}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      const a = agentId ? agents.get(agentId) : undefined;
      out.push({ agentId, agent: a ? `${a.code} ${a.name}` : '(직원 정보 없음)', tool, kind, target: t, suggestion, sig });
    };
    const field = (s: string, k: string) => (new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)`).exec(s)?.[1] ?? '').replace(/\\(["\\/])/g, '$1');
    for (const a of this.d.store.runAttempts(runId)) {
      if (a.role !== 'author' && a.role !== 'reviewer') continue;
      for (const d of a.permissionDenials) {
        const tool = d.split(' ')[0];
        const rest = d.slice(tool.length + 1);
        if (tool === 'Bash') add(a.agentId, tool, 'command', field(rest, 'command') || rest);
        else { const p = field(rest, 'file_path') || field(rest, 'path') || field(rest, 'notebook_path'); add(a.agentId, tool, p ? 'path' : 'other', p || rest); }
      }
      for (const e of this.d.store.events(a.id)) {
        if (e.kind !== 'denied') continue;
        const m = /([A-Za-z]:\\[^\s]+|\/[^\s]+) is outside /.exec(e.summary);
        if (m) add(a.agentId, '파일 도구', 'path', m[1]);
      }
    }
    return out.slice(0, 20);
  }

  // ───── 배운 것 ─────
  private learningNow = new Set<string>();
  private learnAgain = new Set<string>();
  private learnedSection(projectId: string): string[] {
    if (!this.d.learnings || !(this.d.learnEnabled?.() ?? true)) return [];
    const s = this.d.learnings.promptSection(projectId);
    return s ? [s, ''] : [];
  }
  /**
   * 이 미션에서 사용자가 한 말(지시·추가 지시·답변)과 그 맥락을 오퍼레이터가 읽고, 다음 지시·다른 프로젝트에 쓸 사실만 뽑아 저장한다.
   * 저장한 것은 바로 반영하고 '검토 필요'로 표시한다. 실패해도 미션 진행에는 영향이 없다.
   */
  private async learn(id: string) {
    if (!this.d.learnings || !(this.d.learnEnabled?.() ?? true) || this.closed) return;
    // 정리 중이면 끝난 뒤 한 번 더 정리한다(그사이 들어온 답변을 놓치지 않게)
    if (this.learningNow.has(id)) { this.learnAgain.add(id); return; }
    const m = this.get(id);
    const evs = this.events(id).filter((e) => e.seq > (m.learnedSeq ?? 0));
    if (!evs.some((e) => ['user', 'directive', 'answer'].includes(e.kind))) return;
    this.learningNow.add(id);
    try {
      const project = this.d.store.getProject(m.projectId);
      const label: Record<string, string> = { user: '사용자 지시', directive: '사용자 추가 지시', answer: '사용자 답변', question: '오퍼레이터 질문', operator_judge: '오퍼레이터 판단' };
      // 대화는 앞에서부터 8,000자까지 보내고, 보낸 기록까지만 정리한 것으로 표시한다(잘린 뒤쪽은 다음에 이어서 정리)
      // 사용자가 한 말(지시·추가 지시·답변)은 잘라내지 않고 그대로 보낸다(맥락용 질문·판단만 600자로 줄임)
      const mine = new Set(['user', 'directive', 'answer']);
      const lines: string[] = []; let used = 0; let lastSent = m.learnedSeq ?? 0;
      for (const e of evs) {
        if (!label[e.kind]) { lastSent = e.seq; continue; }
        const line = `- [${label[e.kind]}] ${mine.has(e.kind) ? e.text : e.text.slice(0, 600)}`;
        if (used + line.length > 24000 && lines.length) break;
        lines.push(line); used += line.length + 1; lastSent = e.seq;
      }
      const convo = lines.join('\n');
      const known = this.d.learnings.applicable(m.projectId).map((l) => `- ${l.text}`).join('\n') || '- (없음)';
      const prompt = [
        '# 학습 정리', '',
        '당신은 CREWGENAI 개발팀의 00 총괄 오퍼레이터다. 아래는 이번 미션에서 사용자와 주고받은 내용이다. 다음 지시와 다른 프로젝트에서 사용자를 더 잘 이해하는 데 쓸 사실만 뽑는다. 파일은 수정하지 않는다.', '',
        `## 프로젝트: ${project.plan.name}`, '',
        '## 이번 미션의 대화', convo, '',
        '## 이미 알고 있는 것(중복으로 넣지 않는다)', known, '',
        '## 규칙',
        '- 사용자가 직접 말했거나 분명히 보여 준 것만 쓴다. 추측하지 않는다.',
        '- 이번 한 번에만 해당하는 작업 내용은 빼고, 반복해서 쓸 수 있는 것만 쓴다: 선호(문체·형식·진행 방식)=preference, 내 PC 환경(설치된 도구·허용된 명령·경로)=environment, 하지 말 것=rule, 프로젝트 사실=fact.',
        '- 모든 프로젝트에 해당하면 scope=global, 이 프로젝트에만 해당하면 scope=project.',
        '- 한 항목은 한 문장, 80자 안팎. 비밀값·개인 정보·고객 원문은 쓰지 않는다. 최대 6개. 없으면 빈 배열.',
      ].join('\n');
      const out = await this.callOperator<{ items: { scope: 'global' | 'project'; kind: 'preference' | 'environment' | 'rule' | 'fact'; text: string }[] }>(m, project.plan, prompt, LEARN_SCHEMA, `${id}:learn`);
      let n = 0;
      for (const it of (Array.isArray(out?.items) ? out.items : []).slice(0, 6)) {
        if (!it || typeof it.text !== 'string') continue;
        const r = this.d.learnings.add({ scope: it.scope === 'project' ? 'project' : 'global', projectId: m.projectId, kind: it.kind, text: it.text }, { source: `미션: ${redact(m.prompt).slice(0, 60)}`, reviewed: false });
        if (r) n++;
      }
      this.set(id, { learnedSeq: lastSent });
      if (lastSent < Math.max(...evs.map((e) => e.seq))) this.learnAgain.add(id);
      if (n) {
        this.event(this.get(id), 'system', `배운 것 ${n}개를 저장했습니다. 다음 지시부터 반영하며, 왼쪽 아래 '배운 것'에서 검토·수정할 수 있습니다.`);
        this.d.emit({ type: 'learning' });
      }
    } catch { /* 학습 정리 실패는 미션에 영향 없음 */ } finally {
      this.learningNow.delete(id);
      if (this.learnAgain.delete(id) && !this.closed) void this.learn(id);
    }
  }

  // ───── 문서 저장소 최신화(자동 처리) ─────
  /**
   * 사이클 시작 때 이 프로젝트가 쓰는 문서 저장소만 fast-forward로 최신화한다. 실패는 기록만 하고 진행한다.
   * 대상: 빌드 파일이 없는 저장소 중 참고 문서·이전 결과물·수정 허용 경로가 그 저장소 안을 가리키거나 스킬을 가져오는 저장소.
   * 연결 폴더 전체처럼 저장소를 포함하는 상위 경로는 대상을 정하는 근거로 보지 않는다(관련 없는 저장소를 건드리지 않게).
   */
  private async syncDocs(m: Mission, plan: PlanFields) {
    if (!this.d.autoAssist?.() || !(this.d.gitCommits?.() ?? true) || this.closed) return;
    const docs = docReposFor(plan.folder, [...plan.referenceDocs, ...plan.priorOutputs, ...plan.writablePaths]);
    const moved: string[] = []; const skipped: string[] = [];
    for (const r of docs.slice(0, 20)) {
      if (this.closed) return;
      const res = await syncRepoFastForward(r.abs);
      if (res.moved) moved.push(`${r.rel || '연결 폴더'} ${res.note}`);
      else if (res.note) skipped.push(`${r.rel || '연결 폴더'}: ${res.note}`);
    }
    if (moved.length || skipped.length) this.event(m, 'system', [moved.length ? `문서 저장소 최신화: ${moved.join(', ')}` : '', skipped.length ? `최신화하지 않음: ${skipped.join(' / ')}` : ''].filter(Boolean).join('\n'));
  }

  // ───── 스냅샷·되돌리기 ─────
  private hasSnapshot(id: string) { return !!this.d.store.db.prepare('SELECT 1 FROM mission_snapshots WHERE mission_id=?').get(id); }
  private async snapshot(m: Mission, folder: string, key: string, name: string) {
    if (!(this.d.gitCommits?.() ?? true) || this.closed) return;
    const tag = `crewgenai/m-${m.id.slice(0, 8)}/${key}`;
    const ws = await workspaceRepos(folder);
    if (this.closed) return;
    if (ws.mode === 'multi') {
      // 여러 저장소: 저장소마다 현재 커밋을 앱 기록에 남긴다(태그는 만들지 않음)
      const heads = await workspaceHeads(folder);
      if (this.closed) return;
      if (!heads.length) { this.event(m, 'system', '스냅샷을 남기지 못했습니다: 커밋이 있는 하위 저장소가 없습니다.'); return; }
      this.d.store.tx(() => {
        this.d.store.db.prepare('INSERT OR REPLACE INTO mission_snapshots VALUES(?,?,?,?,?,?)').run(m.id, tag, name, heads[0].sha, m.cycle, now());
        this.d.store.db.prepare('DELETE FROM mission_snapshot_repos WHERE mission_id=? AND tag=?').run(m.id, tag);
        for (const h of heads) this.d.store.db.prepare('INSERT INTO mission_snapshot_repos VALUES(?,?,?,?)').run(m.id, tag, h.repo, h.sha);
      });
      this.event(m, 'system', `스냅샷 저장: ${name} (하위 저장소 ${heads.length}개의 현재 커밋 기록)`);
      return;
    }
    const r = await tagSnapshot(folder, tag);
    if (this.closed) return;
    if (r.sha) {
      this.d.store.db.prepare('INSERT OR REPLACE INTO mission_snapshots VALUES(?,?,?,?,?,?)').run(m.id, tag, name, r.sha, m.cycle, now());
      this.event(m, 'system', `스냅샷 저장: ${name} (git 태그 ${tag}, ${r.sha.slice(0, 8)})`);
    } else this.event(m, 'system', `스냅샷을 남기지 못했습니다: ${r.error}`);
  }

  /** 스냅샷의 저장소별 기준점. 한 저장소 모드는 연결 폴더 하나. */
  private snapshotRepos(id: string, tag: string, folder: string, sha: string): { repo: string; abs: string; sha: string }[] {
    const rows = this.d.store.db.prepare('SELECT repo, sha FROM mission_snapshot_repos WHERE mission_id=? AND tag=? ORDER BY repo').all(id, tag) as Row[];
    if (!rows.length) return [{ repo: '', abs: folder, sha }];
    return rows.map((r) => ({ repo: String(r.repo), abs: join(folder, String(r.repo)), sha: String(r.sha) }));
  }

  private async commitsAfter(id: string, repos: { repo: string; abs: string; sha: string }[]) {
    const out: { sha: string; subject: string; author: string; repo?: string; abs: string }[] = [];
    for (const r of repos) if (existsSync(r.abs)) for (const c of await missionCommitsSince(r.abs, r.sha, id)) out.push({ ...c, ...(r.repo ? { repo: r.repo } : {}), abs: r.abs });
    return out;
  }

  async snapshots(id: string): Promise<MissionSnapshot[]> {
    const m = this.get(id);
    const folder = this.d.store.getProject(m.projectId).plan.folder;
    const rows = this.d.store.db.prepare('SELECT * FROM mission_snapshots WHERE mission_id=? ORDER BY created_at').all(id) as Row[];
    const out: MissionSnapshot[] = [];
    for (const r of rows) {
      const repos = this.snapshotRepos(id, String(r.tag), folder, String(r.sha));
      const after = await this.commitsAfter(id, repos);
      out.push({ name: String(r.name), tag: String(r.tag), sha: String(r.sha), cycle: Number(r.cycle), createdAt: String(r.created_at),
        repos: repos.some((x) => x.repo) ? repos.map((x) => x.repo) : undefined,
        commitsAfter: after.map(({ abs: _a, ...c }) => c) });
    }
    return out;
  }

  /** 스냅샷 시점으로 되돌리기: 그 이후 이 미션의 CREWGENAI 커밋만 최신부터 revert(기록 보존). 여러 저장소면 저장소마다 따로 한다. 작동 중에는 먼저 중단해야 한다. */
  async rollback(id: string, tag: string) {
    const m = this.get(id);
    if (['planning', 'running', 'evaluating'].includes(m.status)) throw new Error('미션이 작동 중입니다. 먼저 중단한 뒤 되돌리세요.');
    const row = this.d.store.db.prepare('SELECT * FROM mission_snapshots WHERE mission_id=? AND tag=?').get(id, tag) as Row | undefined;
    if (!row) throw new Error('스냅샷을 찾을 수 없습니다.');
    const folder = this.d.store.getProject(m.projectId).plan.folder;
    const repos = this.snapshotRepos(id, tag, folder, String(row.sha));
    const multi = repos.some((x) => x.repo);
    const plan: { repo: string; abs: string; shas: string[] }[] = [];
    const missing = repos.filter((r) => !existsSync(r.abs)).map((r) => r.repo);
    if (missing.length) throw new Error(`스냅샷에 기록된 저장소를 찾을 수 없어 되돌리지 않았습니다: ${missing.join(', ')}. 폴더 이름·위치를 원래대로 돌린 뒤 다시 시도하세요.`);
    for (const r of repos) { const cs = await missionCommitsSince(r.abs, r.sha, id); if (cs.length) plan.push({ repo: r.repo, abs: r.abs, shas: cs.map((c) => c.sha) }); }
    const total = plan.reduce((n, p) => n + p.shas.length, 0);
    this.event(m, 'system', `되돌리기 시작: '${row.name}' 이후 커밋 ${total}개${multi ? ` (저장소 ${plan.length}개: ${plan.map((p) => p.repo).join(', ')})` : ''}`);
    const reverted: string[] = []; const errors: string[] = []; const done: string[] = [];
    for (const p of plan) {
      const r = await revertCommits(p.abs, p.shas);
      reverted.push(...r.reverted.map((s) => (multi ? `${p.repo}@${s}` : s)));
      if (r.ok) done.push(p.repo); else errors.push(multi ? `${p.repo}: ${r.error}` : String(r.error));
    }
    const ok = errors.length === 0;
    const error = ok ? null : `${errors.join(' / ')}${multi && done.length ? ` (되돌리기를 마친 저장소: ${done.join(', ')})` : ''}`;
    this.event(m, 'system', ok ? `되돌리기 완료: '${row.name}' 시점으로 ${reverted.length}개 커밋을 revert했습니다(기록은 남아 있어 다시 되돌릴 수 있음).` : `되돌리기 실패: ${error}`, { tag, reverted });
    return { ok, reverted, error };
  }

  /** 작동 중인 미션에 추가 지시. now면 진행 중인 오퍼레이터 호출·실행을 실제로 멈추고 바로 다시 계획한다. */
  async addDirective(id: string, text: string, mode: 'next' | 'now'): Promise<Mission> {
    const m = this.get(id);
    if (!text.trim()) throw new Error('추가 지시 내용을 입력하세요.');
    if (!['planning', 'running', 'evaluating'].includes(m.status)) throw new Error('작동 중인 미션에만 추가 지시할 수 있습니다. 확인 대기·완료 상태에서는 답변 칸을 쓰세요.');
    this.event(m, 'directive', `${mode === 'now' ? '[지금 반영] ' : '[다음 사이클 반영] '}${text.trim()}`);
    if (mode === 'now') {
      this.replan.add(id);
      this.procs.get(id)?.cancel();
      if (m.currentRunId && (this.d.engine.isActive(m.currentRunId) || this.d.engine.limitOf(m.currentRunId))) await this.d.engine.cancel(m.currentRunId);
    }
    return this.get(id);
  }

  /** 오퍼레이터 호출이 사용 한도에 걸리면 해제 시각까지 기다렸다가 같은 호출을 다시 한다(중단·종료·'지금 반영'이면 멈춤). */
  private async patient<T>(id: string, call: () => Promise<T>): Promise<T> {
    for (;;) {
      this.guardLoop(id);
      try {
        const v = await call();
        const w = this.get(id).limitWait;
        if (w?.source === 'operator') { this.event(this.get(id), 'system', `${w.reason.includes('장애') ? '연결이 회복돼' : 'Claude 한도가 풀려'} 자동으로 이어서 진행합니다(다시 확인 ${w.tries + 1}회째에 성공).`); this.set(id, { limitWait: null }); }
        return v;
      } catch (e) {
        if (!(e instanceof OperatorLimit)) throw e;
        const until = this.d.engine.limitWaitUntil(e.lim);
        const m = this.get(id);
        const prev = m.limitWait?.source === 'operator' ? m.limitWait : null;
        const known = !!(e.lim.resetsAt && e.lim.resetsAt > 0);
        // 처음 한도에 걸렸을 때만 알린다(같은 한도로 다시 확인할 때마다 알리지 않음)
        if (!prev) this.event(m, 'system', `Claude 한도 대기 — ${known ? `해제 시각 ${new Date(until).toLocaleString('ko-KR')}에` : '해제 시각을 알 수 없어 1시간 뒤'} 앱이 한 번 다시 확인하고 자동으로 이어서 진행합니다. (${redact(e.lim.text).slice(0, 200)})`, { until });
        this.set(id, { limitUntil: new Date(until).toISOString(), limitWait: { source: 'operator', reason: redact(e.lim.text).slice(0, 200), resetKnown: known, nextAt: new Date(until).toISOString(), tries: prev ? prev.tries + 1 : 0, lastAt: prev ? now() : null, lastResult: prev ? '다시 확인했지만 아직 한도' : null, target: '오퍼레이터 계획·판단(멈춘 사이클부터)' } });
        this.wakeLimit.delete(id);
        while (Date.now() < until && !this.wakeLimit.has(id)) {
          if (this.closed) throw new Error('앱 종료');
          if (this.get(id).status === 'stopped') throw new Error('사용자가 중단했습니다.');
          if (this.replan.has(id)) { this.set(id, { limitUntil: null }); throw new Error('추가 지시 반영'); }
          await new Promise((res) => setTimeout(res, 300));
        }
        this.wakeLimit.delete(id);
        this.set(id, { limitUntil: null });
        this.guardLoop(id);
      }
    }
  }

  /** 오퍼레이터 호출 직전 확인: 앱 종료·중단·'지금 반영'이면 호출하지 않는다. */
  private guardLoop(id: string) {
    if (this.closed) throw new Error('앱 종료');
    if (this.get(id).status === 'stopped') throw new Error('사용자가 중단했습니다.');
    if (this.replan.has(id)) throw new Error('추가 지시 반영');
  }

  /** 사용 한도 대기 중인 미션: 기다리지 않고 지금 다시 시도한다. */
  retryLimitNow(id: string): Mission {
    const m = this.get(id);
    if (!m.limitUntil) throw new Error('사용 한도를 기다리는 미션이 아닙니다.');
    this.event(m, 'system', '사용자가 사용 한도 대기를 건너뛰고 지금 다시 시도합니다.');
    if (m.currentRunId && this.d.engine.limitOf(m.currentRunId)) this.d.engine.resumeAfterLimit(m.currentRunId);
    else this.wakeLimit.add(id);
    return this.get(id);
  }

  async stop(id: string): Promise<Mission> {
    const m = this.get(id);
    this.procs.get(id)?.cancel();
    if (m.currentRunId && (this.d.engine.isActive(m.currentRunId) || this.d.engine.limitOf(m.currentRunId))) await this.d.engine.cancel(m.currentRunId);
    this.event(m, 'system', '사용자가 미션을 중단했습니다. 진행 중이던 작업을 취소했습니다.');
    const st = this.set(id, { status: 'stopped', stage: 'stopped', question: null, limitUntil: null, limitWait: null }); // 사용자 중지: 자동 재개 예약도 끈다
    void this.learn(id);
    return st;
  }

  /** 앱 종료: 오퍼레이터 호출을 취소하고 루프가 새 작업을 시작하지 않게 한다. */
  async shutdown(timeoutMs = 6000) {
    this.closed = true;
    const hs = [...this.procs.values()];
    for (const h of hs) h.cancel();
    await Promise.race([Promise.all(hs.map((h) => h.done)), new Promise((r) => setTimeout(r, timeoutMs))]);
    const t0 = Date.now();
    while (this.loops.size && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 50));
  }

  /** 앱 재시작: 앱이 시작한 오퍼레이터 고아 프로세스를 정리하고, 진행 중이던 미션은 사용자 확인 대기로 둔다(조용히 다시 돌지 않는다). */
  async recoverProcesses() {
    for (const r of this.d.store.db.prepare('SELECT * FROM mission_procs').all() as Row[]) {
      const pid = Number(r.pid);
      if (pid && r.proc_start && await isOurProcess(pid, String(r.marker), String(r.proc_start))) await killGroupAndWait(pid);
    }
    this.d.store.db.exec('DELETE FROM mission_procs');
  }
  recoverOnStartup() {
    for (const r of this.d.store.db.prepare('SELECT data FROM missions').all() as Row[]) {
      const m = JSON.parse(String(r.data)) as Mission;
      // 앱 재시작은 사용자 결정이 필요한 일이 아니다: 멈춘 지점부터 자동으로 이어서 진행한다(사용자 중지·결정 대기는 그대로 둠).
      // 실행 중이던 사이클은 다시 계획하지 않고 그 실행을 이어 가며, 사용 한도 대기는 저장한 해제 시각까지 기다린다.
      // 이전 버전이 만든 '멈춘 검토 카드': 정할 결정이 있으면 그대로 기다리고(미션을 멈춘 카드로 표시), 결정이 없으면 멈추지 않고 이어서 진행한다
      if (m.status === 'waiting_user' && m.checkpoint && m.checkpoint.blocking === undefined) {
        if (m.checkpoint.decisions.length) { this.save({ ...m, checkpoint: { ...m.checkpoint, blocking: true } }); continue; }
        const next = this.save({ ...m, checkpoint: { ...m.checkpoint, blocking: false }, status: 'planning', stage: 'plan', question: null, cycle: m.cycle + 1 });
        this.event(next, 'system', '이전 버전에서 검토 카드로 멈춰 있던 미션을 이어서 진행합니다(검토 카드는 확인함에 남아 있음).');
        void this.loop(m.id);
        continue;
      }
      const restartPaused = m.status === 'waiting_user' && m.pauseKind === 'restart'; // 이전 버전이 재시작 때 멈춰 둔 미션
      if (['planning', 'running', 'evaluating'].includes(m.status) || restartPaused) {
        const status = restartPaused ? (m.currentRunId ? 'running' : 'planning') : m.status;
        const next = this.save({ ...m, status, pauseKind: null, question: restartPaused ? null : m.question });
        this.event(next, 'system', `앱 재시작 — 멈춘 지점부터 자동으로 이어서 진행합니다${m.limitUntil && Date.parse(m.limitUntil) > Date.now() ? `(Claude 한도 대기: ${new Date(m.limitUntil).toLocaleString('ko-KR')}에 다시 확인)` : ''}.`);
        void this.loop(m.id);
      } else {
        // 진행 중이 아닌 미션(사용자 중지·완료·결정 대기)의 실행이 한도 대기 예약을 들고 있으면 끈다(중지한 미션이 저절로 다시 돌지 않게)
        for (const c of this.d.store.db.prepare('SELECT run_id FROM mission_cycles WHERE mission_id=?').all(m.id) as { run_id: string }[]) {
          if (this.d.engine.limitOf(c.run_id)) this.d.engine.dropLimitSchedule(c.run_id, m.status === 'stopped' ? '사용자가 미션을 중지해 자동 재개하지 않습니다.' : '미션이 진행 중이 아니라 자동 재개하지 않습니다.');
        }
      }
    }
  }

  /** 실행 노드 상태 변화로 루프 다이어그램의 현재 단계를 갱신한다. */
  onLive(e: LiveEvent) {
    if (e.type !== 'node' || !['running', 'checking', 'rework'].includes(e.state.status)) return;
    const r = this.d.store.db.prepare("SELECT data FROM missions WHERE json_extract(data,'$.currentRunId')=?").get(e.state.runId) as Row | undefined;
    if (!r) return;
    const m = JSON.parse(String(r.data)) as Mission;
    const run = this.d.store.getRun(e.state.runId);
    const node = this.d.store.getGraphVersion(run.graphVersionId).graph.nodes.find((n) => n.id === e.state.nodeId);
    const stage: MissionStage | null = node?.kind === 'agent' ? 'execute' : node?.kind === 'codexReview' ? 'codex' : node?.kind === 'review' ? 'claude_review' : null;
    if (stage && stage !== m.stage) this.save({ ...m, stage });
  }

  // ───── 루프 ─────
  private async loop(id: string) {
    if (this.loops.has(id)) return;
    this.loops.add(id);
    let restart = false;
    try {
      for (;;) {
        let m = this.get(id);
        if (this.closed || !['planning', 'running', 'evaluating'].includes(m.status)) return;
        const project = this.d.store.getProject(m.projectId);
        const agents = this.staffFor(m);
        // 실행 준비 확인: 통과 전에는 직원에게 개발 작업을 배정하지 않는다
        if (!m.readyChecked) {
          const rc = await this.readyCheck(m, project.plan, agents);
          if (this.closed || this.get(id).status === 'stopped') return;
          if (rc.fail.length) { await this.pauseReport(id, 'blocked', rc.fail); return; }
          m = this.set(id, { readyChecked: true });
        }

        // 오퍼레이터 호출이 사용 한도에 걸려 기다리던 중(앱 재시작 포함)이면, 해제 시각까지 Claude를 부르지 않고 기다린다
        await this.waitOperatorLimit(id);
        if (this.closed || this.get(id).status === 'stopped') return;
        m = this.get(id);

        // 재시작·한도 대기로 멈춘 사이클 실행이 있으면 다시 계획하지 않고 그 실행을 이어서 진행한다(완료 단계는 다시 실행하지 않음)
        const resumeId = this.resumableRun(m);
        let run: ReturnType<Engine['startRun']>;
        let graphNodes: GraphNode[];
        if (resumeId) {
          run = this.d.store.getRun(resumeId);
          graphNodes = this.d.engine.detail(resumeId).graph.nodes;
          if (!this.d.engine.limitOf(resumeId) && !this.d.engine.isActive(resumeId)) this.d.engine.resumeInterrupted(resumeId);
          m = this.set(id, { status: 'running', stage: 'execute' });
          this.event(m, 'system', `사이클 ${m.cycle} 실행을 멈춘 지점부터 이어서 진행합니다(완료한 단계는 다시 실행하지 않음).`, { runId: resumeId });
        } else {
        // 1) 오퍼레이터 계획
        m = this.set(id, { status: 'planning', stage: 'plan', currentRunId: null });
        await this.syncDocs(m, project.plan);
        if (this.closed || this.get(id).status === 'stopped') return;
        const plan = await this.patient(id, () => this.callOperator<Plan>(this.get(id), project.plan, this.planPrompt(this.get(id), project.plan, agents), PLAN_SCHEMA));
        if (this.get(id).status === 'stopped') return;
        this.event(m, 'operator_plan', `사이클 ${m.cycle} 계획: ${plan.summary} (작업 ${plan.tasks.length}개)`, plan);
        this.collectStaff(id, plan.staffProposals, agents);
        const gaps = (Array.isArray(plan.gaps) ? plan.gaps : []).filter((g) => g && (String(g.issue ?? '').trim() || String(g.need ?? '').trim()))
          .slice(0, 12).map((g): MissionGap => {
            const pc = pickChoices((g as { choices?: unknown }).choices, g.options); const o = pc.opts; const explain = String(g.explain ?? '').trim().slice(0, 1200);
            const refs = (Array.isArray(g.refs) ? g.refs : []).filter((r) => r && String(r.path ?? '').trim()).slice(0, 4)
              .map((r) => ({ path: String(r.path).trim().slice(0, 500), line: Number.isInteger(r.line) && Number(r.line) > 0 ? Number(r.line) : null }));
            const kind = g.kind === 'assume' ? 'assume' as const : 'decide' as const; const assumption = String(g.assumption ?? '').trim().slice(0, 400);
            return { doc: String(g.doc ?? '').slice(0, 200), issue: String(g.issue ?? '').slice(0, 600), need: String(g.need ?? '').slice(0, 600), kind, ...(assumption ? { assumption } : {}), ...(g.blocking === true ? { blocking: true } : {}), ...(o.length ? { options: o } : {}), ...(pc.choices.length ? { choices: pc.choices } : {}), ...(explain ? { explain } : {}), ...(refs.length ? { refs } : {}) };
          })
          .filter((g) => !(this.get(id).decisions ?? []).some((d) => gapKey(d) === gapKey(g))); // 이미 결정한 항목은 다시 묻지 않는다(계획 중에 고른 결정 포함)
        // 사용자가 '나중에'로 남긴 항목은 새 계획이 다른 항목을 내도 결정·해결 전까지 유지한다
        { const cur = this.get(id); const kept = (cur.gaps ?? []).filter((g) => !(cur.decisions ?? []).some((d) => gapKey(d) === gapKey(g)));
          const fresh = gaps.filter((g) => !kept.some((k) => gapKey(k) === gapKey(g)));
          gaps.splice(0, gaps.length, ...kept, ...fresh.slice(0, Math.max(0, 12 - kept.length))); }
        // 되돌리기 쉬운 세부는 묻지 않고 가정하고 진행한다(검토 지점에서 알림). 사람이 정할 결정만 남긴다.
        { const as = gaps.filter((g) => g.kind === 'assume');
          if (as.length) {
            const cur = this.get(id); const prev = cur.assumptions ?? [];
            const add = as.map((g) => ({ cycle: m.cycle, doc: g.doc, text: (g.assumption || g.issue).slice(0, 400) })).filter((a) => !prev.some((p) => p.text === a.text));
            if (add.length) { this.set(id, { assumptions: [...prev, ...add].slice(-40) }); this.event(m, 'system', `문서가 부족한 세부는 가정하고 진행합니다(검토 때 알려 드립니다).\n${add.map((a) => `- ${a.text}`).join('\n')}`, { assumptions: add }); }
          }
          const rest = gaps.filter((g) => g.kind !== 'assume'); gaps.splice(0, gaps.length, ...rest);
          // 작업이 있으면 오퍼레이터 질문도 멈추지 않고 다음 검토 지점의 결정으로 모은다
          if (plan.tasks.length && plan.question.trim()) {
            const pq = pickChoices(plan.questionChoices, plan.questionOptions);
            const g: MissionGap = { doc: '오퍼레이터 질문', issue: plan.question.trim().slice(0, 600), need: '', kind: 'decide', ...(pq.opts.length ? { options: pq.opts } : {}), ...(pq.choices.length ? { choices: pq.choices } : {}) };
            if (!gaps.some((x) => gapKey(x) === gapKey(g)) && !(this.get(id).decisions ?? []).some((d) => gapKey(d) === gapKey(g))) gaps.push(g);
            plan.question = '';
          } }
        if (gaps.length && plan.tasks.length) {
          // 근거가 부족한 부분이 있어도 기존 문서·결과물로 할 수 있는 일은 진행한다. 부족한 부분은 확인 필요로만 남긴다.
          this.event(m, 'system', `사람이 정할 결정 ${gaps.length}건은 다음 검토 지점에 모아 묻고, 할 수 있는 작업부터 진행합니다.\n${gaps.map((g) => `- [${g.doc || '문서 미지정'}] ${g.issue}`).join('\n')}`, { gaps });
          this.set(id, { gaps });
        } else if (gaps.length) {
          // 근거가 없어 시작할 수 있는 작업이 하나도 없음: 채워야 할 부분을 알려 주고 멈춘다(문서를 보완한 뒤 이어서 진행)
          const q = `근거 문서를 보완해 주세요.${plan.question.trim() ? ` ${plan.question.trim()}` : ''}\n${gaps.map((g) => `- [${g.doc || '문서 미지정'}] ${g.issue}${g.need ? ` → 채울 내용: ${g.need}` : ''}`).join('\n')}`;
          const qc = plan.question.trim() ? pickChoices(plan.questionChoices, plan.questionOptions) : null; const qo = qc ? qc.opts : null; // 오퍼레이터가 함께 물은 질문은 근거 부족 항목과 같이 보여 준다
          this.event(m, 'question', q, { gaps });
          this.set(id, { status: 'waiting_user', stage: 'ask_user', question: q, gaps, questionOptions: qo, questionChoices: qc?.choices.length ? qc.choices : null });
          return;
        }
        if (plan.question.trim() || plan.tasks.length === 0) {
          const pq = plan.question.trim() ? pickChoices(plan.questionChoices, plan.questionOptions) : { opts: [], choices: [] }; const opts = pq.opts;
          this.event(m, 'question', plan.question.trim() || '진행할 작업을 정하지 못했습니다. 추가 지시가 필요합니다.', opts.length ? { options: opts } : undefined);
          this.set(id, { status: 'waiting_user', stage: 'ask_user', question: plan.question.trim() || '진행할 작업을 정하지 못했습니다. 무엇을 할지 알려 주세요.', questionOptions: opts, questionChoices: pq.choices.length ? pq.choices : null });
          return;
        }

        // 2) 실행 전 권한 점검: 허용되지 않은 명령·경로가 필요한 작업은 돌리지 않고 확인 필요로 뺀다
        const pre = this.preflight(project.plan, agents, plan.tasks);
        if (pre.held.length) {
          const ds = pre.held.flatMap((h) => h.denials);
          const list = pre.held.map((h) => `- ${h.task.title}: ${h.denials.map((d) => d.target).join(', ')}`).join('\n');
          const cur = this.get(id);
          const merged = [...(cur.denials ?? []).filter((d) => !ds.some((x) => x.sig === d.sig)), ...ds].slice(0, 30);
          if (!pre.keep.length) {
            const q = `계획한 작업이 모두 허용되지 않은 명령·경로를 필요로 해서 실행하지 않았습니다. 아래 항목을 허용하거나 지시를 바꿔 주세요.\n${list}`;
            this.event(m, 'question', q, { denials: ds });
            this.set(id, { status: 'waiting_user', stage: 'ask_user', question: q, denials: merged });
            return;
          }
          this.event(m, 'system', `실행 전 점검: 허용되지 않은 명령·경로가 필요한 작업은 이번 사이클에서 빼고 확인 필요로 남깁니다. 나머지 작업은 진행합니다.\n${list}`, { denials: ds });
          this.set(id, { denials: merged, parkedSigs: [...new Set([...(cur.parkedSigs ?? []), ...ds.map((d) => d.sig)])] });
          plan.tasks = pre.keep;
        }

        // 3) 사이클 흐름 구성·실행
        const built = this.buildCycleGraph(m, project.plan, agents, plan);
        if ('error' in built) {
          this.event(m, 'question', `계획을 실행 가능한 흐름으로 만들지 못했습니다: ${built.error}`);
          this.set(id, { status: 'waiting_user', stage: 'ask_user', question: `오퍼레이터 계획에 문제가 있습니다(${built.error}). 지시를 보완해 주세요.` });
          return;
        }
        const saved = this.d.store.saveGraph(m.projectId, built.graph, `미션 ${m.id.slice(0, 8)} 사이클 ${m.cycle}`);
        if (!this.hasSnapshot(id)) await this.snapshot(m, project.plan.folder, 'start', '미션 시작 전');
        // 스냅샷을 기다리는 동안 중단·종료·'지금 반영' 추가 지시가 들어왔으면 이 계획으로 실행하지 않는다
        if (this.closed || this.get(id).status === 'stopped') return;
        if (this.replan.delete(id)) { this.event(m, 'system', '추가 지시가 들어와 이 계획으로 실행하지 않고 다시 계획합니다.'); this.set(id, { status: 'planning', stage: 'plan' }); continue; }
        run = this.d.engine.startRun(m.projectId, saved.id, { missionId: id, cycle: m.cycle });
        graphNodes = built.graph.nodes;
        this.d.store.db.prepare('INSERT OR REPLACE INTO mission_cycles VALUES(?,?,?)').run(id, m.cycle, run.id);
        m = this.set(id, { status: 'running', stage: 'execute', currentRunId: run.id });
        this.event(m, 'cycle_start', `사이클 ${m.cycle} 실행 시작(흐름 v${saved.version}, 작업 ${plan.tasks.length}개)`, { runId: run.id });
        }
        const fin = await this.waitRun(run.id, id);
        if (this.closed || this.get(id).status === 'stopped') return;
        // 실행이 끝나면 바로 '판단 전' 상태로 둔다(이후 스냅샷 중에 앱이 꺼져도 재시작 때 이 실행을 다시 계획하지 않고 판단부터 이어 감).
        // 사용량·종료 기록·스냅샷은 실행마다 한 번만(재시작 후 이어 갈 때 중복 집계하지 않음)
        const firstPass = !(this.get(id).countedRuns ?? []).includes(run.id);
        m = this.set(id, { status: 'evaluating', stage: 'judge', countedRuns: [...(this.get(id).countedRuns ?? []), run.id].slice(-20) });
        if (firstPass) {
          this.addRunUsage(id, run.id);
          this.event(m, 'cycle_end', `사이클 ${m.cycle} 실행 종료: ${fin.status}${fin.reason ? ` — ${fin.reason}` : ''}`);
          await this.snapshot(m, project.plan.folder, `cycle-${m.cycle}`, `사이클 ${m.cycle} 종료(${fin.status})`);
        }
        // 권한 거부: 실행이 실패했거나 직전 사이클과 같은 거부가 반복되면 같은 설정으로 다시 시도하지 않고 멈춘다(권한은 앱 설정으로만 바뀐다)
        if (!this.replan.has(id)) {
          const all = this.permissionBlocks(run.id);
          // 비밀값 환경 파일 읽기 거부는 보호 규칙이라 사용자가 허용할 일이 아니다: 보류·팝업 없이 오퍼레이터에게만 알린다
          const secret = all.filter((b) => b.kind === 'command' && touchesSecretEnv(b.target));
          if (secret.length) this.event(m, 'system', `비밀값 환경 파일(.env·.env.local 등) 읽기는 보호 규칙으로 막혀 있습니다(사용자 허용 대상 아님). 설정 값은 견본 파일(.env.example)과 코드에서 확인하세요.\n${secret.map((b) => `- ${b.agent}: ${b.target}`).join('\n')}`);
          const blocks = all.filter((b) => !secret.includes(b));
          const cur = this.get(id);
          const prev = cur.denialSigs ?? [];
          const parked = cur.parkedSigs ?? [];
          const repeated = blocks.some((b) => prev.includes(b.sig));
          if (blocks.length && (fin.status !== 'succeeded' || repeated)) {
            const list = blocks.map((b) => `- ${b.agent} · ${b.tool}: ${b.target}`).join('\n');
            const merged = [...(cur.denials ?? []).filter((d) => !blocks.some((x) => x.sig === d.sig)), ...blocks].slice(0, 30);
            if (blocks.some((b) => parked.includes(b.sig))) {
              // 보류했던 업무가 같은 거부로 다시 막힘: 묻고 멈추지 않고 보류를 유지한 채 다른 일을 계속한다(진전 없는 사이클이 이어지면 아래에서 멈춤)
              this.event(m, 'system', `보류했던 업무가 같은 권한 거부로 다시 막혀 보류를 유지합니다. 다른 작업을 계속합니다.\n${list}`, { denials: blocks });
              this.set(id, { denials: merged, denialSigs: blocks.map((b) => b.sig) });
            } else {
            // 처음 막힘: 그 업무만 보류(확인 필요)하고 나머지는 계속한다. 보류한 업무는 사용자가 해결하기 전까지 다시 계획하지 않는다.
            this.event(m, 'system', `권한 때문에 막힌 업무를 보류했습니다(확인 필요). 해결하기 전까지 다시 계획하지 않고 나머지 작업을 계속합니다.\n${list}`, { denials: blocks });
            this.set(id, { denials: merged, denialSigs: blocks.map((b) => b.sig), parkedSigs: [...new Set([...parked, ...blocks.map((b) => b.sig)])] });
            }
          } else this.set(id, { denialSigs: blocks.map((b) => b.sig) });
        }
        // 실패가 내 PC 환경 문제이거나 지난 사이클과 같은 원인으로 반복되면, 다시 계획해도 같은 실패가 나므로 멈추고 사용자 검토를 받는다
        if (!this.replan.has(id)) {
          const failed = fin.status === 'failed' ? this.d.store.runNodes(run.id).filter((n) => n.status === 'failed' && n.failureReason) : [];
          const labels = new Map(graphNodes.map((n) => [n.id, n.label]));
          const items = failed.map((n) => ({ step: labels.get(n.nodeId) ?? n.nodeId, reason: n.failureReason.slice(0, 600) }));
          if (fin.status === 'failed' && !items.length && fin.reason) items.push({ step: '실행', reason: fin.reason.slice(0, 600) });
          const prev = this.get(id).failSigs ?? [];
          const blockers: MissionBlocker[] = items.flatMap((x): MissionBlocker[] => ENV_FAILURE.test(x.reason) ? [{ ...x, kind: 'environment' as const }] : prev.includes(failureSig(x.reason, x.step)) ? [{ ...x, kind: 'repeated' as const }] : []);
          if (blockers.length) {
            const list = blockers.map((b) => `- [${b.kind === 'environment' ? '내 PC 환경' : '같은 실패 반복'}] ${b.step}: ${b.reason}`).join('\n');
            const parked = this.get(id).parkedSigs ?? [];
            const bsig = (b: MissionBlocker) => `fail|${failureSig(b.reason, b.step)}`;
            const all = [...(this.get(id).blockers ?? []).filter((x) => !blockers.some((b) => bsig(b) === bsig(x))), ...blockers].slice(0, 20);
            if (blockers.some((b) => parked.includes(bsig(b)))) {
              // 보류했던 업무가 같은 원인으로 다시 실패: 보류를 유지한 채 다른 일을 계속한다(진전 없는 사이클이 이어지면 아래에서 멈춤)
              this.event(m, 'system', `보류했던 업무가 같은 원인으로 다시 실패해 보류를 유지합니다. 다른 작업을 계속합니다.\n${list}`, { blockers });
              this.set(id, { blockers: all, failSigs: items.map((x) => failureSig(x.reason, x.step)) });
            } else {
            this.event(m, 'system', `스스로 풀 수 없는 실패가 난 업무를 보류했습니다(확인 필요). 해결하기 전까지 다시 계획하지 않고 나머지 작업을 계속합니다.\n${list}`, { blockers });
            this.set(id, { blockers: all, parkedSigs: [...new Set([...parked, ...blockers.map(bsig)])], failSigs: items.map((x) => failureSig(x.reason, x.step)) });
            }
          } else
          this.set(id, { failSigs: items.map((x) => failureSig(x.reason, x.step)) });
        }
        if (this.replan.has(id)) {
          // '지금 반영' 추가 지시: 이번 사이클 판단을 건너뛰고 지시를 반영해 다음 사이클을 바로 계획한다
          this.replan.delete(id);
          this.event(m, 'system', `추가 지시를 반영하려고 사이클 ${m.cycle} 작업을 멈췄습니다. 사이클 ${m.cycle + 1}을 다시 계획합니다.`);
          this.set(id, { cycle: m.cycle + 1, maxCycles: Math.max(m.maxCycles, m.cycle + 1), status: 'planning', stage: 'plan' });
          continue;
        }

        // 3) 오퍼레이터 판단(그 전에 앱이 시연 환경을 직접 켜고 확인해 판단 근거로 준다)
        m = this.set(id, { status: 'evaluating', stage: 'judge' });
        if (this.d.demoVerify) {
          try { const lines = await this.d.demoVerify(m.projectId); this.demoChecks.set(id, lines); if (lines.length) this.event(m, 'system', `앱이 시연 환경을 직접 확인했습니다(승인된 서비스만 켬):\n${lines.join('\n')}`); }
          catch (e) { this.demoChecks.set(id, [`- 시연 확인 실패: ${redact((e as Error).message).slice(0, 200)}`]); }
          if (this.closed || this.get(id).status === 'stopped') return;
        }
        const judge = await this.patient(id, () => this.callOperator<Judge>(this.get(id), project.plan, this.judgePrompt(this.get(id), project.plan, run.id), JUDGE_SCHEMA));
        if (this.get(id).status === 'stopped') return;
        this.event(m, 'operator_judge', `판단: ${judge.decision === 'continue' ? '계속' : judge.decision === 'done' ? '완료' : '사용자 확인'} — ${judge.summary}`, judge);
        this.collectStaff(id, judge.staffProposals, this.d.ensureAgents(m.projectId).filter((a) => a.active));
        { const results = resolveResults(project.plan.folder, judge.results);
          const hist = [{ cycle: m.cycle, results }, ...(this.get(id).resultsHistory ?? []).filter((h) => h.cycle !== m.cycle)].slice(0, 6);
          m = this.set(id, { results, resultsCycle: m.cycle, resultsHistory: hist }); }
        { const reqs = cleanCommitRequests(judge.commitRequests, this.get(id).commitRequests ?? [], m.cycle);
          if (reqs.length) { m = this.set(id, { commitRequests: [...(this.get(id).commitRequests ?? []), ...reqs].slice(-30) }); for (const r of reqs) this.event(m, 'system', `커밋 승인 요청: ${r.repo || '(연결 폴더)'} · 파일 ${r.files.length}개 · "${r.message}" — 사용자가 승인해야 커밋합니다.`, { commitRequest: r.id }); } }
        if (judge.decision === 'done') {
          const pk = this.get(id); const open = (pk.denials?.length ?? 0) + (pk.blockers?.length ?? 0);
          this.set(id, { status: 'done', stage: 'done', summary: judge.summary, question: `완료 보고: ${judge.summary}${open ? `\n(보류한 업무 ${open}건은 확인이 필요합니다)` : ''}` });
          this.event(m, 'question', '완료 보고 — 결과물을 검토하고 추가 지시하거나 종료하세요.');
          void this.learn(id);
          return;
        }
        // 검토 지점: 큰 결과가 준비됐거나(review), 결정 없이는 진행할 수 없거나(ask_user), 자동 진행 한도에 닿았을 때 한곳에 모아 보여 준다
        // 검토 지점: 큰 결과가 준비됐거나(review) 정기 보고(budget)면 검토 카드를 확인함에 올려 두고 개발은 계속한다.
        // 결정 없이는 아무것도 진행할 수 없을 때(ask_user)만 미션 전체를 사용자 결정 대기로 둔다.
        const openCheckpoint = (reason: 'ready' | 'budget', extra: { question: string; choices: MissionChoice[] }[], blocking: boolean) => {
          const cur = this.get(id);
          const carried = carryCheckpoint(cur.checkpoint, cur.gaps ?? []); // 답하지 않은 이전 검토 결정은 미결 항목으로 넘긴다(잃지 않음)
          const raw: RawCheckpoint = { ...(judge.checkpoint ?? {}), decisions: [...extra, ...(judge.checkpoint?.decisions ?? [])] };
          const cp: MissionCheckpoint = buildCheckpoint(raw, m.cycle, cur.results ?? [], carried, (cur.assumptions ?? []).filter((a) => a.cycle > (cur.checkpoint?.cycle ?? 0) || !cur.checkpoint).map((a) => a.text), reason, summaryTitle(judge.summary) || judge.nextFocus.slice(0, 120), this.demoChecks.get(id) ?? []);
          cp.usage = this.usageLine(cur);
          if (blocking) {
            cp.blocking = true;
            this.set(id, { status: 'waiting_user', stage: 'ask_user', summary: judge.summary, checkpoint: cp, gaps: carried.length ? carried : null, question: `결정 필요: ${cp.title}`, questionOptions: null, questionChoices: null, sinceReview: 0, idleCycles: 0 });
            this.event(m, 'question', `사용자 결정 대기(결정 없이는 진행할 수 있는 작업이 없음): ${cp.title} — 결정 ${cp.decisions.length}건`, { checkpoint: true, blocking: true });
          } else {
            m = this.set(id, { summary: judge.summary, checkpoint: cp, gaps: carried.length ? carried : null, sinceReview: 0 });
            this.event(m, 'system', `검토할 결과를 확인함에 올렸습니다(개발은 계속): ${cp.title} — 결정 ${cp.decisions.length}건, 가정 ${cp.assumptions.length}건`, { checkpoint: true });
          }
        };
        if (judge.decision === 'ask_user') {
          const jq = judge.question ? pickChoices(judge.questionChoices, judge.questionOptions) : { opts: [], choices: [] };
          openCheckpoint('ready', judge.question ? [{ question: judge.question, choices: jq.choices.length ? jq.choices : jq.opts.map((label) => ({ label, effect: '', recommended: false, why: '' })) }] : [], true);
          return;
        }
        if (judge.decision === 'review') openCheckpoint('ready', [], false);
        // 진전 없는 사이클(직원이 실제 프로젝트에 반영한 변경이 없음): 멈추지 않고 오퍼레이터에게 다른 방법을 찾게 한다.
        // 여러 번 이어지면(같은 자리를 돎) 진행 가능한 작업이 없는 것으로 보고 확인함에 한 번 묻는다(토큰만 쓰는 반복 방지).
        const progressed = this.d.store.runAttempts(run.id).some((a) => a.role === 'author' && a.changedFiles.length > 0);
        const idle = progressed ? 0 : (this.get(id).idleCycles ?? 0) + 1;
        if (idle >= IDLE_LIMIT) {
          const q = `최근 ${idle}개 사이클 동안 실제로 반영된 변경이 없어 진행 가능한 작업이 없는 것으로 보입니다. 오퍼레이터 판단: ${judge.summary}\n다음 초점: ${judge.nextFocus}\n방향을 정해 주시면 그 방향으로 이어서 진행합니다.`;
          this.set(id, { status: 'waiting_user', stage: 'ask_user', summary: judge.summary, question: q, idleCycles: 0 });
          this.event(m, 'question', q, { idle });
          return;
        }
        if (!progressed) this.event(m, 'system', `사이클 ${m.cycle}은 반영된 변경이 없었습니다(연속 ${idle}회). 다음 계획은 같은 방법을 반복하지 않고 다른 실행 방법을 찾습니다.`);
        const since = (this.get(id).sinceReview ?? 0) + (progressed ? 1 : 0);
        m = this.set(id, { idleCycles: idle, sinceReview: since, maxCycles: Math.max(m.maxCycles, m.cycle + 1) });
        if (judge.decision !== 'review' && since >= this.reviewBudget()) openCheckpoint('budget', [], false); // 정기 결과 보고(멈추지 않음)
        this.set(id, { cycle: m.cycle + 1, summary: judge.summary, status: 'planning', stage: 'plan' });
      }
    } catch (e) {
      if (this.closed) return; // 앱 종료 중: 재시작 때 사용자 확인 대기로 복원된다
      if (this.replan.has(id) && this.get(id).status !== 'stopped') {
        // 오퍼레이터 계획·판단 중에 '지금 반영' 추가 지시가 들어와 호출을 멈춘 경우: 같은 사이클을 다시 계획한다
        this.replan.delete(id);
        this.event(this.get(id), 'system', '추가 지시를 반영하려고 진행 중이던 오퍼레이터 호출을 멈췄습니다. 다시 계획합니다.');
        this.set(id, { status: 'planning', stage: 'plan' });
        restart = true;
        return;
      }
      const m = this.get(id);
      const kind = classifyError((e as Error).message ?? '');
      if (m.status !== 'stopped' && kind === 'network') {
        // 일시적인 연결·서비스 장애: 사용자에게 묻지 않고 앱이 10분 뒤 한 번 다시 시도한다(그동안 Claude를 부르지 않음)
        const until = new Date(Date.now() + NETWORK_RETRY_MS).toISOString(); const prev = m.limitWait;
        if (!prev) this.event(m, 'system', `연결·서비스 일시 장애로 오퍼레이터 호출이 실패했습니다. ${new Date(until).toLocaleString('ko-KR')}에 자동으로 다시 시도합니다. (${redact((e as Error).message).slice(0, 200)})`);
        this.set(id, { limitUntil: until, limitWait: { source: 'operator', reason: '연결·서비스 일시 장애', resetKnown: false, nextAt: until, tries: prev ? prev.tries + 1 : 0, lastAt: prev ? now() : null, lastResult: prev ? '다시 시도했지만 실패' : null, target: '오퍼레이터 계획·판단(멈춘 사이클부터)' } });
        restart = true;
        return;
      }
      if (m.status !== 'stopped') {
        this.event(m, 'system', `${kind === 'auth' ? 'Claude 로그인 필요로 멈춤(사용자 조치 필요)' : '오류로 멈춤'}: ${redact((e as Error).message)}`);
        this.set(id, { status: 'waiting_user', stage: 'ask_user', limitWait: null, question: kind === 'auth' ? 'Claude 로그인이 만료됐거나 인증에 실패했습니다. 터미널에서 Claude에 다시 로그인한 뒤 이어서 진행을 누르세요(멈춘 지점부터 이어 갑니다).' : `오류로 멈췄습니다: ${redact((e as Error).message).slice(0, 300)}. 원인을 해결한 뒤 계속하거나 종료하세요.` });
      }
    } finally { this.loops.delete(id); if (restart) void this.loop(id); }
  }

  private async waitRun(runId: string, missionId: string) {
    let noted = 0; let resumedAt = 0;
    for (;;) {
      const r = this.d.store.getRun(runId);
      if (this.closed || this.get(missionId).status === 'stopped') return r;
      const active = this.d.engine.isActive(runId);
      const lim = !active && r.status === 'needs_resume' ? this.d.engine.limitOf(runId) : null;
      if (lim && this.replan.has(missionId)) { await this.d.engine.cancel(runId); this.set(missionId, { limitUntil: null }); return this.d.store.getRun(runId); }
      if (lim) {
        // 사용 한도: 실행은 해제 시각에 엔진이 스스로 이어서 진행한다. 미션은 실패로 판단하지 않고 기다린다.
        if (noted !== lim.until) {
          noted = lim.until;
          const m = this.get(missionId);
          const prev = m.limitWait?.source === 'run' ? m.limitWait : null;
          // 처음 한도에 걸렸을 때만 알린다. 이후 매번 다시 확인한 결과는 상태로만 갱신한다.
          if (!prev) this.event(m, 'system', `사용 한도 도달 — ${lim.known === false ? '해제 시각을 알 수 없어 ' : ''}${new Date(lim.until).toLocaleString('ko-KR')}에 앱이 한 번 다시 확인하고 멈춘 작업부터 자동으로 이어서 진행합니다. 기다리지 않으려면 '지금 다시 시도'를 누르세요.`, { runId, until: lim.until });
          const node = this.d.engine.detail(runId).graph.nodes.find((n) => n.id === lim.nodeId);
          this.set(missionId, { limitUntil: new Date(lim.until).toISOString(), limitWait: { source: 'run', reason: lim.text, resetKnown: lim.known !== false, nextAt: new Date(lim.until).toISOString(), tries: prev ? prev.tries + 1 : 0, lastAt: prev ? now() : null, lastResult: prev ? '다시 확인했지만 아직 한도' : null, target: `사이클 ${m.cycle} · ${node?.label ?? '멈춘 작업'}(같은 세션을 이어서)` } });
        }
        await new Promise((res) => setTimeout(res, 300));
        continue;
      }
      if (noted && this.get(missionId).limitUntil) { noted = 0; resumedAt = Date.now(); this.set(missionId, { limitUntil: null }); }
      // 다시 시도한 작업이 1분 넘게 한도 없이 돌거나 실행이 끝나면 '한도 해제 후 재개'로 한 번만 알린다(매시간 재시도마다 알리지 않음)
      { const w = this.get(missionId).limitWait;
        if (w?.source === 'run' && !lim && resumedAt && (Date.now() - resumedAt > 60_000 || (!active && r.status !== 'needs_resume'))) {
          this.event(this.get(missionId), 'system', `Claude 한도가 풀려 멈춘 작업부터 자동으로 이어서 진행했습니다(다시 확인 ${w.tries + 1}회째).`);
          this.set(missionId, { limitWait: null }); resumedAt = 0;
        } }

      if (!active && ['succeeded', 'failed', 'cancelled', 'needs_resume', 'review_wait', 'on_hold'].includes(r.status)) return r;
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  // ───── 재개·한도 대기 ─────
  /** 이어서 진행할 사이클 실행: 실행 중·평가 중에 멈춘 미션의 현재 실행이 아직 끝나지 않았거나(재시작·한도 대기), 끝났지만 판단 전이면 */
  private resumableRun(m: Mission): string | null {
    if (!m.currentRunId || !['running', 'evaluating'].includes(m.status)) return null;
    let r; try { r = this.d.store.getRun(m.currentRunId); } catch { return null; }
    if (['needs_resume', 'running', 'queued', 'paused'].includes(r.status)) return r.id;
    if (m.status === 'evaluating' && ['succeeded', 'failed', 'cancelled', 'review_wait', 'on_hold'].includes(r.status)) return r.id; // 판단 직전에 멈춤: 실행은 끝났으니 판단부터
    return null;
  }
  /** 오퍼레이터 사용 한도 대기(앱이 관리): 해제 시각까지 Claude를 부르지 않는다. '지금 다시 시도'·중지·추가 지시로 깨어난다. */
  private async waitOperatorLimit(id: string) {
    const until = Date.parse(this.get(id).limitUntil ?? '');
    if (!Number.isFinite(until) || until <= Date.now() || this.get(id).currentRunId && this.d.engine.limitOf(this.get(id).currentRunId!)) return;
    this.wakeLimit.delete(id);
    while (Date.now() < until && !this.wakeLimit.has(id) && !this.closed && this.get(id).status !== 'stopped' && !this.replan.has(id)) await new Promise((res) => setTimeout(res, 1000));
    this.wakeLimit.delete(id);
    if (!this.closed && this.get(id).status !== 'stopped') this.set(id, { limitUntil: null });
  }

  // ───── 실행 제한·사용량·실행 준비 ─────
  /** 참여 직원 제한: 오퍼레이터(00)와 지정한 직원만 */
  /** 실행 제한 안내(참여 직원·사용량): 오퍼레이터가 지정 직원만으로 계획하게 */
  private limitSection(m: Mission): string[] {
    return ['## 실행 범위(앱이 집행함)',
      ...(m.limits?.staff ? ['- 참여 직원은 위 \'사용 가능한 직원\'(지정된 직원)뿐이다. 다른 직원 투입·직원 추가 제안은 하지 않는다.'] : []),
      `- 지금까지 사용량: ${this.usageLine(m)}`, ''];
  }
  private staffFor(m: Mission): Agent[] {
    const all = this.d.ensureAgents(m.projectId).filter((a) => a.active);
    const ids = m.limits?.staff;
    return ids?.length ? all.filter((a) => a.code === '00' || ids.includes(a.id)) : all;
  }
  private addUsage(id: string, items: { costUsd: number | null; usage: Record<string, number> | null }[]) {
    const m = this.get(id); const u = { ...(m.usage ?? emptyUsage()) };
    for (const it of items) {
      u.calls++;
      if (it.costUsd === null && !it.usage) continue;
      u.reported++; u.costUsd += it.costUsd ?? 0;
      const g = (k: string) => (typeof it.usage?.[k] === 'number' ? it.usage[k] : 0);
      u.inputTokens += g('input_tokens'); u.outputTokens += g('output_tokens'); u.cacheReadTokens += g('cache_read_input_tokens'); u.cacheWriteTokens += g('cache_creation_input_tokens');
    }
    this.set(id, { usage: u });
  }
  private addRunUsage(id: string, runId: string) {
    this.addUsage(id, this.d.store.runAttempts(runId).filter((a) => a.role === 'author' || a.role === 'reviewer').map((a) => ({ costUsd: a.costUsd, usage: a.usage })));
  }
  /**
   * 실행 준비 확인(직원에게 일을 주기 전에 앱이 직접): 작업 폴더 쓰기, 실행할 직원, 로컬 서버(직원 실행 환경의 로컬 포트), 시연 환경.
   * 막히면 직원에게 작업을 배정하지 않고 무엇이 막혔는지와 필요한 최소 결정을 보고한다.
   */
  private async readyCheck(m: Mission, plan: PlanFields, agents: Agent[]): Promise<{ lines: string[]; fail: string[] }> {
    const ok: string[] = []; const fail: string[] = [];
    const paths = plan.writablePaths.length ? plan.writablePaths : ['.'];
    // 아직 없는 경로(직원이 만들 폴더)는 가장 가까운 있는 상위 폴더에 쓸 수 있는지 본다(연결 폴더 밖으로는 올라가지 않음)
    const writable = (p: string) => { let cur = resolve(plan.folder, p); const root = resolve(plan.folder);
      for (;;) { if (existsSync(cur)) { try { accessSync(cur, fsc.W_OK); return true; } catch { return false; } } if (cur === root || !cur.startsWith(root)) return false; cur = resolve(cur, '..'); } };
    const bad = paths.filter((p) => !writable(p));
    if (bad.length) fail.push(`작업 폴더 쓰기: ${bad.join(', ')}에 쓸 수 없음(앱이 직접 확인) → 폴더가 있는지, 기획의 자동 수정 허용 경로가 맞는지 확인이 필요합니다.`);
    else ok.push(`작업 폴더 쓰기: 자동 수정 허용 경로 ${paths.length}곳 쓰기 가능(앱이 직접 확인)`);
    const doers = agents.filter((a) => a.code !== '00' && (a.tools.includes('Edit') || a.tools.includes('Write')));
    const runners = doers.filter((a) => a.tools.includes('Bash'));
    if (!doers.length) fail.push('구현 담당: 이 미션에 파일을 고칠 수 있는 직원이 없습니다 → 참여 직원에 구현 담당을 넣어야 합니다.');
    else ok.push(`구현 담당: ${doers.map((a) => `${a.code} ${a.name}`).join(', ')}${runners.length ? '' : ' (명령 실행 권한이 없어 서버·시험을 직접 돌리지 못함)'}`);
    const sockets = this.d.testLocalSockets?.() ?? false;
    if (runners.length && !sockets) ok.push('[주의] 로컬 서버: 설정 > 자동 처리의 \'로컬 포트 열기\'가 꺼져 있어 직원 실행 환경에서 서버·서버 시험을 띄울 수 없습니다(앱 설정 확인) → 서버를 띄워야 하는 작업이면 이 설정 하나를 켜야 합니다(이 컴퓨터의 127.0.0.1만, 외부 네트워크는 계속 막힘).');
    else if (runners.length) ok.push('로컬 서버: 직원 실행 환경(격리)에서 127.0.0.1 포트 열기 허용(설정), 외부 네트워크는 막힘');
    // 직원이 실제로 쓰는 실행 환경(격리 폴더 + 같은 권한·샌드박스 설정)에서 직접 확인한다: 폴더 이동 후 쓰기, 프로젝트 읽기, 로컬 포트, 실행 도구
    if (runners.length && !bad.length && (this.d.commandLevel?.() ?? 'medium') !== 'high') ok.push('[주의] 명령 허용 범위가 \'높음\'이 아니어서 직원 실행 환경 점검(묶은 명령)을 건너뜀 — 직원은 허용된 명령만 하나씩 실행합니다');
    else if (runners.length && !bad.length) {
      const pr = await this.staffProbe(m, plan, runners[0]).catch((e: Error) => ({ ok: [] as string[], fail: [] as string[], warn: [`직원 실행 환경 점검을 하지 못함: ${redact(e.message).slice(0, 200)}`] }));
      ok.push(...pr.ok, ...pr.warn.map((w) => `[주의] ${w}`)); fail.push(...pr.fail);
    }
    if (this.d.demoVerify) {
      try { const lines = await this.d.demoVerify(m.projectId); this.demoChecks.set(m.id, lines);
        ok.push(...(lines.length ? lines.map((l) => `시연 환경${l.startsWith('- ') ? ' ' + l.slice(2) : ' ' + l}`) : ['시연 환경: 시연 목록이 아직 없음(이번 미션에서 직원이 함께 만든다)']));
      } catch (e) { ok.push(`시연 환경: 확인 실패 — ${redact((e as Error).message).slice(0, 200)}`); }
    }
    this.event(m, 'system', `실행 준비 확인(직원에게 작업을 주기 전에 앱이 직접 확인)${fail.length ? ' — 막힘이 있어 작업을 배정하지 않습니다' : ''}:\n${[...fail.map((x) => `- [막힘] ${x}`), ...ok.map((x) => `- ${x}`)].join('\n')}`, { ready: { ok, fail } });
    return { lines: ok, fail };
  }
  /**
   * 직원 실행 환경 점검: 작성 직원과 같은 설정(격리 폴더, 샌드박스, 명령 허용 범위, 로컬 포트 설정, 프로젝트 읽기 전용)으로
   * 가장 작은 모델 호출 한 번에 정해진 명령 하나만 실행해 결과 표식을 읽는다. 실행 도중에야 권한 문제를 발견하지 않게 미리 확인한다.
   */
  private async staffProbe(_m: Mission, _plan: PlanFields, _agent: Agent): Promise<{ ok: string[]; fail: string[]; warn: string[] }> {
    // Windows 판은 직원 명령 실행(Bash)·샌드박스를 쓰지 않으므로 격리 실행 환경 점검이 없다(파일 쓰기 확인은 위에서 앱이 직접 한다)
    return { ok: [], fail: [], warn: [] };
  }
  /** 사용량 한 줄(CLI 보고값만, 미보고는 그대로 미보고) */
  usageLine(m: Mission): string {
    const u = m.usage; if (!u || !u.calls) return '사용량 기록 없음';
    const tok = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    return `CLI 호출 ${u.calls}회(사용량 보고 ${u.reported}회${u.calls > u.reported ? `, 미보고 ${u.calls - u.reported}회는 알 수 없음` : ''}) · 토큰 입력 ${u.inputTokens.toLocaleString()} / 출력 ${u.outputTokens.toLocaleString()} / 캐시 ${(u.cacheReadTokens + u.cacheWriteTokens).toLocaleString()} (합 ${tok.toLocaleString()}) · CLI 보고 금액 $${u.costUsd.toFixed(2)}(구독 로그인이면 API 환산 추정값이며 청구액 아님)`;
  }
  /** 실행 준비 확인에서 막힘: 작업 배정을 멈추고, 막힌 것·원인·필요한 최소 결정·지금 실제로 되는 결과를 한 카드로 보고한다 */
  private async pauseReport(id: string, reason: 'blocked', fail: string[] = [], runId?: string) {
    const m = this.get(id); if (this.closed || m.status === 'stopped') return;
    const blocked = [
      ...fail,
      ...(m.denials ?? []).map((d) => `권한 보류: ${d.agent} · ${d.tool}: ${d.target}`),
      ...(m.blockers ?? []).map((b) => `${b.kind === 'environment' ? '내 PC 환경' : '같은 실패 반복'}: ${b.step} — ${b.reason}`),
    ].slice(0, 12);
    const title = '실행 준비 확인에서 막혀 직원에게 작업을 배정하지 않았습니다';
    const cp = buildCheckpoint(undefined, m.cycle, m.results ?? [], m.gaps ?? [], (m.assumptions ?? []).map((a) => a.text), reason, title, this.demoChecks.get(id) ?? []);
    cp.blocked = blocked; cp.usage = this.usageLine(m);
    if (runId) {
      // 판단 전에 멈춘 사이클의 실제 변경(직원이 고친 파일)을 보여 준다. 결과 목록은 이전 판단 기준임을 밝힌다
      try {
        const d = this.d.engine.detail(runId); const label = new Map(d.graph.nodes.map((n) => [n.id, n.label]));
        const byNode = new Map<string, string[]>();
        for (const a of d.attempts) if (a.role === 'author' && a.changedFiles.length) byNode.set(a.nodeId, [...new Set([...(byNode.get(a.nodeId) ?? []), ...a.changedFiles])]);
        const feats = [...byNode].map(([n, files]) => ({ name: `${label.get(n) ?? n} (사이클 ${m.cycle}, 판단 전 중단)`, changed: `고친 파일 ${files.length}개: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ' 외' : ''}`, status: 'implemented' as const }));
        if (feats.length) cp.features = [...feats, ...cp.features].slice(0, 8);
        cp.unverified = [`사이클 ${m.cycle} 결과는 오퍼레이터 판단 전에 멈춰 검증·정리되지 않았습니다.${m.resultsCycle ? ` 아래 결과 목록은 사이클 ${m.resultsCycle} 판단 기준입니다.` : ''}`, cp.unverified].filter(Boolean).join('\n');
      } catch { /* 실행 기록을 읽지 못하면 이전 결과만 보여 준다 */ }
    }
    this.set(id, { status: 'waiting_user', stage: 'ask_user', checkpoint: cp, question: `검토 준비됨: ${title}`, questionOptions: null, questionChoices: null, currentRunId: null });
    this.event(m, 'question', `${title}${blocked.length ? `\n막힌 것:\n${blocked.map((b) => `- ${b}`).join('\n')}` : ''}\n사용량: ${cp.usage}`, { checkpoint: true, reason });
  }

  // ───── 흐름 구성 ─────
  private buildCycleGraph(m: Mission, plan: PlanFields, agents: Agent[], p: Plan): { graph: WorkGraph } | { error: string } {
    const by = (code: string) => agents.find((a) => a.code === code);
    const reviewerFor = (author: Agent) => {
      const readOnly = agents.filter((a) => !a.tools.includes('Edit') && !a.tools.includes('Write'));
      // 지정된 검토 담당 → 읽기 전용 검토자 → 총괄 → 다른 직원
      const pref = [author.reviewerAgentId ? agents.find((a) => a.id === author.reviewerAgentId) : undefined, ...readOnly, by('00'), ...agents];
      return pref.find((a) => a && a.id !== author.id) ?? null;
    };
    const mk = (kind: GraphNode['kind'], label: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode => ({
      id: randomUUID(), kind, label, position: { x, y }, agentId: null, reviewerAgentId: null, instructions: '', inputs: [], useUpstreamOutputs: true, outputs: [], doneCriteria: '',
      command: [], writeScope: [], maxRetries: 0, maxVisits: 3, timeoutSec: 1800, condition: null, entryCondition: 'all', ...extra });
    const nodes: GraphNode[] = []; const edges: GraphEdge[] = [];
    const e = (s: GraphNode, t: GraphNode, kind: GraphEdge['kind'] = 'next') => edges.push({ id: randomUUID(), source: s.id, target: t.id, kind });
    const inp = mk('input', `사이클 ${m.cycle} 지시`, 300, 0, { instructions: m.prompt, timeoutSec: 60 });
    nodes.push(inp);
    const merge = mk('merge', `사이클 ${m.cycle} 결과물 취합`, 300, 700, { timeoutSec: 120 });
    const roots = allowedRoots(plan);
    const chains: { first: GraphNode; last: GraphNode }[] = [];
    const refused: string[] = [];
    p.tasks.forEach((t, i) => {
      const author = by(t.agentCode) ?? by('00');
      if (!author) throw new Error(`담당 직원 ${t.agentCode}를 찾을 수 없습니다.`);
      const reviewer = reviewerFor(author);
      if (!reviewer) throw new Error('독립 재검토를 맡을 다른 직원이 없습니다.');
      const scope = (t.writeScope.length ? t.writeScope : [`${plan.outputDir}/mission`]).map(normRel).filter((x) => x && !escapes(x));
      const outs = t.outputs.map((o) => ({ path: normRel(o.path), format: o.format, required: true })).filter((o) => o.path && !escapes(o.path));
      const x = 120 + i * 360;
      const a = mk('agent', `${t.title} (${author.code} ${author.name})`, x, 130, { agentId: author.id, instructions: `${t.instructions}\n\n[문서 기준] 근거 문서·할 일 목록에 적힌 내용 그대로 작업한다. 문서에 없거나 애매한 기능·결정은 추측해 만들거나 바꾸지 말고, 결과 보고의 '확인 필요'에 적는다.`, writeScope: scope, outputs: outs, doneCriteria: t.doneCriteria, skipInlineReview: true });
      const cx = mk('codexReview', `Codex 리뷰: ${t.title}`, x, 260, { inputs: outs.map((o) => o.path), doneCriteria: t.doneCriteria, timeoutSec: 1800 });
      const rv = mk('review', `Claude 재검토: ${t.title} (${reviewer.code} ${reviewer.name})`, x, 390, { agentId: reviewer.id, doneCriteria: t.doneCriteria,
        instructions: 'Codex 리뷰 보고서의 지적을 원문 산출물과 직접 대조한다. 재작업(changes_requested)은 완료 조건을 충족하지 못했거나, 근거 문서와 다르게 만들었거나, P0·P1(정확성·보안·요구 위반) 지적이 타당할 때만 요청한다. P2 같은 경미한 지적·표현·완성도 지적은 재작업 사유가 아니다. 승인하되 summary에 "남은 경미 지적"으로 적는다. 근거 없는 지적은 이유를 들어 기각한다.' });
      nodes.push(a, cx, rv);
      e(a, cx); e(cx, rv); e(rv, a, 'fail');
      let last = rv;
      const ck0 = this.safeCheck(t.checkCommand, author, plan.folder);
      if (t.checkCommand.length && !ck0) refused.push(`${t.title}: ${t.checkCommand.join(' ')}`);
      if (ck0) {
        const ck = mk('check', `검사: ${t.title}`, x, 520, { command: ck0, timeoutSec: 600 });
        nodes.push(ck); e(rv, ck); e(ck, a, 'fail'); last = ck;
      }
      chains.push({ first: a, last });
    });
    nodes.push(merge);
    const wire = (sequential: boolean) => {
      const es = [...edges]; // 작업 내부 연결(작성 → Codex → Claude 재검토 → 검사, 실패 시 작성으로)
      chains.forEach((c, i) => {
        if (sequential && i > 0) es.push({ id: randomUUID(), source: chains[i - 1].last.id, target: c.first.id, kind: 'next' });
        else es.push({ id: randomUUID(), source: inp.id, target: c.first.id, kind: 'next' });
        if (!sequential || i === chains.length - 1) es.push({ id: randomUUID(), source: c.last.id, target: merge.id, kind: 'next' });
      });
      return autoLayout({ nodes, edges: es });
    };
    for (const sequential of [false, true]) {
      const g = wire(sequential);
      const issues = validateGraph(g, agents, plan).filter((i) => i.level === 'error');
      if (!issues.length) { if (refused.length) this.event(m, 'system', `허용되지 않은 검사 명령을 제외했습니다(셸·인터프리터 실행 금지, 담당 허용 명령만): ${refused.join(' / ')}`); return { graph: g }; }
      if (sequential || !issues.some((i) => i.code === 'write_conflict')) return { error: issues.slice(0, 3).map((i) => i.message).join(' / ') + ` (수정 허용: ${roots.join(', ') || '없음'})` };
    }
    return { error: '흐름 구성 실패' };
  }

  /**
   * 오퍼레이터가 계획한 검사 명령은 실행 전에 제한한다: 셸·인터프리터 코드 실행(sh/bash/zsh -c, node/python -e/-c)은 금지,
   * 담당 직원의 Bash 허용 명령 접두어 또는 grep/test만 허용한다. 허용되지 않으면 null.
   */
  private safeCheck(argv: string[], author: Agent, folder: string): string[] | null {
    return checkArgv(argv, author.allowedCommands, folder);
  }

  // ───── 오퍼레이터 프롬프트 ─────
  private history(m: Mission): string {
    return this.events(m.id).filter((e) => ['operator_judge', 'answer', 'question', 'directive'].includes(e.kind)).slice(-16)
      .map((e) => `- [사이클 ${e.cycle}] ${e.kind === 'answer' ? '사용자 답변' : e.kind === 'directive' ? '사용자 추가 지시(최우선 반영)' : e.kind === 'question' ? '질문' : '판단'}: ${e.text}`).join('\n') || '- (없음)';
  }

  private planPrompt(m: Mission, plan: PlanFields, agents: Agent[]): string {
    return [
      '# 오퍼레이터 계획', '',
      '당신은 CREWGENAI 개발팀의 00 총괄 오퍼레이터다. 사용자 지시를 이번 사이클의 작업으로 나누고, 기능에 맞는 담당 직원을 배정한다. 파일은 수정하지 않는다(읽기만).', '',
      '## 사용자 지시', m.prompt, '',
      ...this.learnedSection(m.projectId),
      `## 사이클: ${m.cycle} (지난 검토 이후 자동 진행 ${m.sinceReview ?? 0}회)`, '',
      ...this.limitSection(m),
      '## 프로젝트', `- 이름: ${plan.name}`, `- 목표: ${plan.goal}`, `- 원하는 결과물: ${plan.deliverable}`, `- 완료 조건: ${plan.doneCriteria}`, `- 작업 범위: ${plan.scope}`,
      `- 자동 수정 허용 경로: ${allowedRoots(plan).join(', ') || '(없음)'}`, '',
      '## 사용 가능한 직원', ...agents.map((a) => `- ${a.code} ${a.name}: ${a.role} · 도구 ${a.tools.join(',')}${a.tools.includes('Edit') || a.tools.includes('Write') ? ' · 쓰기 가능' : ' · 읽기 전용'}`), '',
      ...this.docsSection(plan, m.projectId),
      '## 지금까지의 판단·질문·사용자 답변', this.history(m), '',
      ...this.decisionsSection(m),
      '## 규칙',
      '- 작업마다 writeScope(수정 경로)는 자동 수정 허용 경로 안이어야 하고, 작업끼리 겹치지 않게 나눈다. outputs는 writeScope 안에 둔다.',
      '- agentCode는 위 목록의 쓰기 가능한 직원 코드만 쓴다. 각 작업 결과는 Codex 리뷰와 다른 직원의 Claude 재검토를 거친다.',
      '- outputs의 path는 만들 파일 경로다. 여러 파일을 담는 폴더를 산출물로 하려면 폴더 경로를 쓰고, 그 안 파일의 형식을 format에 쓴다(폴더 안에 그 형식 파일이 하나 이상 있어야 통과). 형식을 가리지 않으면 any.',
      '- checkCommand는 셸 없이 실행할 argv 배열이다(필요 없으면 빈 배열). 셸·인터프리터 코드 실행은 거부되며, 담당의 허용 명령이나 grep/test만 쓸 수 있다.',
      '- 먼저 근거 문서·기존 결과물을 읽고 업무를 분석한다. 근거가 빈약하거나 애매한 부분(내용 없음·서로 모순·결정 안 됨·범위 불명확)은 gaps에 문서별로 issue(무엇이 부족한지, 문서의 어느 부분인지)와 need(사용자가 채워야 할 내용)를 쓴다. 그래도 기존 문서·결과물로 할 수 있는 작업은 tasks로 계속 계획한다(gaps는 확인 필요로만 남고 진행을 막지 않는다). 이번 지시 전체가 근거 없이는 시작할 수 없을 때만 tasks를 비운다. 추측으로 빈 곳을 메우지 않는다. 근거가 충분하면 gaps는 빈 배열.',
      "- gaps 항목이 사용자가 고르기만 하면 되는 결정(어느 기준을 따를지, 유지·되돌림, 범위·우선순위 등)이면 choices에 2~4개의 선택지를 쓴다: label(예: 'HTML 기준 유지'), effect(고르면 무엇이 달라지는지 쉬운 한 문장, 예: '제품 화면을 HTML에 맞춰 고친다'), recommended(추천하는 안 하나만 true), why(추천 이유 한 문장). 사용자에게 명령 실행·결과 붙여넣기 같은 수작업을 선택지로 내지 않는다. '보류'는 앱이 따로 주므로 넣지 않는다. 내용을 사용자가 직접 채워야 하는 항목이면 options는 빈 배열.",
      FLOW_RULE, ASSUME_RULE, ASK_RULE, ENOUGH_RULE, NO_MANUAL_RULE, COMMIT_RULE, RESULT_RULE, demoRule(plan), ...this.demoSection(plan), ...this.commitSection(m), ...this.assumptionsSection(m),
      '- gaps 항목마다 explain에 이 문서들을 읽지 않은 사용자도 바로 이해하도록 쉬운 말로 3~5문장을 쓴다: 무엇이 문제인지(문서에 실제로 적힌 내용·서로 다른 두 내용을 짧게 옮겨 보여 줌), 왜 진행에 영향이 있는지, 각 선택지를 고르면 무엇이 달라지는지. 내부 약어·업무 ID(예: 문서 코드, W-00-15)는 그대로 쓰지 말고 무엇인지 풀어 쓴다. refs에는 근거 위치를 프로젝트 폴더 기준 경로(폴더 밖 참고 문서는 절대 경로)와 줄 번호로 적는다(사용자가 바로 열어 본다). 아직 없는 문서는 refs에 넣지 않는다.',
      '- 사용자 결정(위)에 있는 항목은 gaps에 다시 쓰지 않고, 그 결정을 그대로 따른다. 관련 작업 지시에는 해당 결정을 그대로 옮겨 적는다.',
      `- 할 일 목록: 자동 수정 허용 경로 아래에 할 일 목록 파일(예: ${plan.outputDir || 'docs'}/WORK_LIST.md)이 있으면 그 항목을 기준으로 작업을 만들고, 작업 지시에 항목 ID와 근거 문서 위치(파일·절)를 그대로 적는다. 목록이 없고 기존 문서·결과물이 있으면 첫 작업 하나로 기획 문서·기존 결과물에서 할 일 목록을 정리한다(항목·근거 위치·상태만 한 번에 정리, 전수 대조·완벽한 표를 목표로 하지 않는다). 문서에 없는 기능·결정은 목록에 만들지 않고 '확인 필요'로 표시한다.`,
      ...(this.d.autoAssist?.() ? [`- 자동 처리(앱이 함): 직원 변경은 dev·main에 커밋하지 않고 작업 브랜치 ${workBranchName(m.id)}에 커밋된다(push·PR·병합은 사용자). 따라서 저장소가 dev·main이라는 이유로 작업을 보류하거나 브랜치 생성을 확인 필요로 올리지 않는다. Bash를 가진 직원에게는 저장소에 있는 시험 명령(scripts/gradle.sh·scripts/check.sh·npm check)이 자동 허용된다(네트워크 없음).`] : []),
      '- needs: 작업에 Bash 명령이 필요하면 commands에 실제 실행할 명령을, 프로젝트 폴더 밖에서 읽어야 하는 파일·폴더가 있으면 readPaths에 절대 경로를 쓴다. 담당 직원에게 허용되지 않은 것이 있으면 그 작업은 실행하지 않고 사용자 확인으로 돌린다. 필요 없으면 빈 배열.',
      '- 이 PC(Windows판)에서는 직원이 Bash 명령을 쓸 수 없다. 명령이 꼭 필요한 일은 needs.commands에 적어 사용자에게 맡긴다.',
      '- question: 그 정보·결정 없이는 어떤 작업도 할 수 없을 때만 tasks를 비우고 한 가지 질문을 쓴다(작업이 있으면 질문은 다음 검토 지점에 모인다). 고르면 되는 질문이면 questionChoices에 2~4개의 선택지를 쓴다: label(선택지), effect(고르면 무엇이 달라지는지 쉬운 한 문장), recommended(추천하는 안 하나만 true), why(추천 이유 한 문장, 추천 안에만). 그렇지 않으면 question은 빈 문자열.',
      '- 이전 사이클의 결과·판단을 이어받아 남은 일만 계획한다. 작업은 1~4개로 작게 나눈다.',
      '- staffProposals: 이번 지시를 하는 데 지금 직원으로는 부족한 근거가 있을 때만(맞는 역할의 직원이 없음, 같은 직원이 역할·지시 때문에 반복해 엇나감, 직원 지시가 근거 문서·사용자 결정과 어긋남) 제안한다. 새 직원은 kind=add(name·role·instructions, 비슷한 일을 하는 기존 직원 코드를 agentCode에, 작업 폴더는 workPaths), 기존 직원의 역할·지시 변경은 kind=update(agentCode와 바뀐 role·instructions 전체). reason에는 이번 사이클에서 본 근거를 쓴다. 도구·명령 권한은 제안하지 않는다. 오퍼레이터(00)는 바꾸지 않는다. 제안은 사용자가 적용할 때까지 반영되지 않으니 지금 있는 직원으로 계획을 계속한다. 필요 없으면 빈 배열.',
      ...this.staffSection(m),
      ...this.parkedSection(m),
    ].join('\n');
  }

  /**
   * 오퍼레이터의 직원 제안을 모은다(진행은 막지 않는다). 오퍼레이터(00) 자신과 없는 직원은 바꾸지 않고,
   * 같은 내용으로 이미 기다리는·무시한 제안은 다시 올리지 않는다. 기다리는 제안은 최대 6건.
   */
  private collectStaff(id: string, raw: RawStaff[] | undefined, agents: Agent[]): void {
    if (!Array.isArray(raw) || !raw.length) return;
    const m = this.get(id);
    const list = [...(m.staffProposals ?? [])];
    const added: StaffProposal[] = [];
    const t = (v: unknown, n: number) => redact(String(v ?? '').trim()).slice(0, n);
    for (const r of raw.slice(0, 3)) {
      const kind = r?.kind === 'update' ? 'update' : r?.kind === 'add' ? 'add' : null;
      if (!kind) continue;
      const code = t(r.agentCode, 10);
      const name = t(r.name, 60); const role = t(r.role, 300); const instructions = t(r.instructions, 6000); const reason = t(r.reason, 800);
      if (!reason || (!instructions && !role)) continue;
      if (kind === 'update' && (!code || code === '00' || !agents.some((a) => a.code === code))) continue;
      if (kind === 'add' && !name) continue;
      const same = (p: StaffProposal) => p.kind === kind && (kind === 'update' ? p.agentCode === code : p.name === name) && p.status !== 'applied';
      if (list.some(same) || list.filter((p) => p.status === 'pending').length >= 6) continue;
      const workPaths = (Array.isArray(r.workPaths) ? r.workPaths : []).map((w) => String(w ?? '').trim().slice(0, 300)).filter(Boolean).slice(0, 6);
      const p: StaffProposal = { id: uid(), kind, agentId: agents.find((a) => a.code === code)?.id ?? null, agentCode: code, name, role, instructions, workPaths, reason, cycle: m.cycle, at: new Date().toISOString(), status: 'pending' };
      list.push(p); added.push(p);
    }
    if (!added.length) return;
    this.set(id, { staffProposals: list.slice(-40) });
    this.event(m, 'system', `오퍼레이터의 직원 제안 ${added.length}건 — 적용할지 골라 주세요(진행은 계속합니다).\n${added.map((p) => `- ${p.kind === 'add' ? `새 직원 '${p.name}'` : `${p.agentCode} ${p.name || ''} 역할·지시 변경`}: ${p.reason}`).join('\n')}`, { staffProposals: added });
  }

  /** 직원 제안을 적용·무시로 표시한다(실제 직원 저장은 서비스가 한다) */
  markStaffProposal(id: string, proposalId: string, status: 'applied' | 'dismissed', result: string): Mission {
    const m = this.get(id);
    const p = (m.staffProposals ?? []).find((x) => x.id === proposalId);
    if (!p) throw new Error('직원 제안을 찾을 수 없습니다.');
    if (p.status !== 'pending') throw new Error('이미 처리한 직원 제안입니다.');
    this.event(m, 'answer', status === 'applied' ? `직원 제안 적용: ${result}` : `직원 제안 무시: ${p.kind === 'add' ? `새 직원 '${p.name}'` : `${p.agentCode} 역할·지시 변경`} — 다시 제안하지 말 것`);
    return this.set(id, { staffProposals: (m.staffProposals ?? []).map((x) => (x.id === proposalId ? { ...x, status, result } : x)) });
  }

  /** 직원 제안 기록: 기다리는 것·무시한 것은 다시 제안하지 않게 알린다 */
  private staffSection(m: Mission): string[] {
    const ps = (m.staffProposals ?? []).filter((p) => p.status !== 'applied');
    if (!ps.length) return [];
    return ['## 직원 제안 기록(다시 제안하지 말 것)', ...ps.map((p) => `- [${p.status === 'pending' ? '사용자 확인 대기' : '사용자가 무시함'}] ${p.kind === 'add' ? `새 직원 '${p.name}'` : `${p.agentCode} 역할·지시 변경`}`), ''];
  }

  /** 가정하고 진행한 세부: 다시 묻지 않고, 사용자가 검토 때 바꾸면 그 결정을 따른다 */
  private assumptionsSection(m: Mission): string[] {
    const as = (m.assumptions ?? []).slice(-20);
    if (!as.length) return [];
    return ['## 가정하고 진행 중인 세부(다시 묻지 말 것 — 사용자 결정이 다르면 결정을 따른다)', ...as.map((a) => `- [사이클 ${a.cycle}] ${a.text}`), ''];
  }

  /** 사용자가 확인 필요 항목에 고른 결정: 오퍼레이터·직원이 추측하지 않고 그대로 따른다 */
  private decisionsSection(m: Mission): string[] {
    const ds = m.decisions ?? [];
    if (!ds.length) return [];
    return ['## 사용자 결정(확정 — 그대로 따르고 다시 묻지 않는다)', ...ds.map((d) => `- [${d.doc || '문서 미지정'}] ${d.issue} → ${d.choice}`), ''];
  }

  /** 보류한 업무(사용자 확인 대기): 같은 업무·같은 권한이 필요한 작업을 다시 계획하지 않게 알린다 */
  private parkedSection(m: Mission): string[] {
    const ds = m.denials ?? []; const bs = m.blockers ?? [];
    if (!ds.length && !bs.length) return [];
    return ['', '## 보류한 업무(사용자 확인 대기 — 다시 계획하지 말 것)',
      ...ds.map((d) => `- 권한: ${d.agent} · ${d.tool}: ${d.target}`), ...bs.map((b) => `- ${b.kind === 'environment' ? '내 PC 환경' : '같은 실패 반복'}: ${b.step} — ${b.reason.slice(0, 200)}`),
      '- 위 업무와 같은 작업, 같은 명령·경로가 필요한 작업은 계획하지 않는다. 그 결과가 없어도 할 수 있는 나머지 일을 계획한다.',
      '- 남은 일이 모두 보류한 업무에 달려 있으면 tasks를 비우고 question에 무엇을 해결해야 하는지 한 가지로 묻는다.'];
  }

  /** 계획 프롬프트의 '근거 문서' 절: 등록된 프로젝트 완성 문서와 상태(파일 경로는 프로젝트 폴더 기준) */
  private docsSection(plan: PlanFields, projectId: string): string[] {
    let docs: ProjectDoc[] = [];
    try { docs = this.d.projectDocs?.(projectId) ?? []; } catch { docs = []; }
    const used = docs.filter((d) => d.status !== 'excluded');
    if (!used.length) return ['## 근거 문서', '- (등록된 프로젝트 완성 문서 없음 — 기획의 목표·완료 조건과 참고 문서만 근거로 쓴다)', ''];
    const label: Record<ProjectDoc['status'], string> = { missing: '없음', draft: '있음·사용자 검토 전', changed: '있음·검토 후 바뀜', reviewed: '있음·사용자 검토 완료', excluded: '제외' };
    return ['## 근거 문서(프로젝트 완성 문서, 프로젝트 폴더 기준 경로 — Read로 읽을 수 있음)', ...used.map((d) => `- ${d.order}. ${d.title}: ${d.path} (${label[d.status]})`),
      ...(plan.referenceDocs.length ? ['- 참고 문서(읽기 전용):', ...plan.referenceDocs.map((r) => `  - ${r}`)] : []), ''];
  }

  private judgePrompt(m: Mission, plan: PlanFields, runId: string): string {
    const d = this.d.engine.detail(runId);
    const md = d.deliverable?.markdown ?? '(결과물 없음)';
    const failed = d.nodes.filter((n) => n.status === 'failed').map((n) => `${d.graph.nodes.find((g) => g.id === n.nodeId)?.label}: ${n.failureReason}`);
    const reviews = d.reviews.map((r) => `- ${r.kind === 'codex' ? 'Codex' : r.kind === 'agent' ? 'Claude 재검토' : '사용자'}: ${r.verdict} — ${r.comments.slice(0, 300).replace(/\n/g, ' ')}`);
    return [
      '# 오퍼레이터 판단', '',
      '당신은 00 총괄 오퍼레이터다. 이번 사이클 결과를 사용자 지시와 산출물 기준으로 판단한다. 파일은 수정하지 않는다.', '',
      ...this.limitSection(m),
      ...this.learnedSection(m.projectId),
      '## 사용자 지시', m.prompt, '', `## 사이클: ${m.cycle} (지난 검토 이후 자동 진행 ${m.sinceReview ?? 0}회, 검토 없이 ${this.reviewBudget()}회까지 진행)`, '',
      '## 프로젝트 완료 조건', plan.doneCriteria || '(미입력)', '',
      `## 실행 결과: ${d.run.status}${d.run.reason ? ` — ${d.run.reason}` : ''}`, ...(failed.length ? ['### 실패 단계', ...failed.map((f) => `- ${f}`)] : []), '',
      '## 리뷰 기록', ...(reviews.length ? reviews : ['- (없음)']), '',
      '## 앱이 직접 확인한 시연 결과(이번 판단 직전, 사실로 쓴다)', ...((this.demoChecks.get(m.id) ?? []).length ? this.demoChecks.get(m.id)! : ['- (시연 목록이 없거나 확인할 서비스가 없음)']), '',
      '## 직원(역할·지시 요약 — 직원 제안 판단용)', ...this.d.ensureAgents(m.projectId).filter((a) => a.active && a.code !== '00').map((a) => `- ${a.code} ${a.name}: ${a.role} — ${a.instructions.replace(/\s+/g, ' ').slice(0, 400)}`), '',
      '## 지금까지의 판단·사용자 답변', this.history(m), '',
      ...this.decisionsSection(m),
      '## 이번 사이클 결과물(요약 보고서)', md.slice(0, 15000), '',
      '## 판단 규칙',
      '- done: 사용자 지시와 완료 조건을 산출물로 충족했을 때만. 실행이 실패했거나 검증이 없으면 done이 아니다.',
      FLOW_RULE, CHECKPOINT_RULE, ...this.assumptionsSection(m),
      '- ask_user: 그 결정·정보 없이는 어떤 작업도 진행할 수 없을 때만. question에 한 가지 질문을 쓴다. 고르면 되는 질문이면 questionChoices에 2~4개의 선택지를 쓴다: label(선택지), effect(고르면 무엇이 달라지는지 쉬운 한 문장), recommended(추천하는 안 하나만 true), why(추천 이유 한 문장, 추천 안에만).',
      '- continue: 남은 일이 분명하고 사용자 확인 없이 진행할 수 있을 때(작은 판단·세부는 가정하고 진행). nextFocus에 다음 사이클의 초점을 쓴다.',
      '- 측정하지 않은 성과나 실행하지 않은 검사를 근거로 쓰지 않는다.',
      REPORT_RULE, ASK_RULE, ENOUGH_RULE, NO_MANUAL_RULE, COMMIT_RULE, ...this.commitSection(m), RESULTS_RULE, demoRule(plan), '- results의 demo: 실행 가능한 기능의 결과물이면 시연 목록의 service id와, 화면이면 path(예: /operator/companies), API면 api(apis 항목 id), steps(사용자가 눌러 볼 순서), expected(예상 결과), data(api+db·screen-only·mock)를 쓴다. 시연 목록에 없는 서비스는 쓰지 않는다. 문서만 만든 작업은 demo를 비운다.', ...this.demoSection(plan),
      '- staffProposals: 이번 지시를 하는 데 지금 직원으로는 부족한 근거가 있을 때만(맞는 역할의 직원이 없음, 같은 직원이 역할·지시 때문에 반복해 엇나감, 직원 지시가 근거 문서·사용자 결정과 어긋남) 제안한다. 새 직원은 kind=add(name·role·instructions, 비슷한 일을 하는 기존 직원 코드를 agentCode에, 작업 폴더는 workPaths), 기존 직원의 역할·지시 변경은 kind=update(agentCode와 바뀐 role·instructions 전체). reason에는 이번 사이클에서 본 근거를 쓴다. 도구·명령 권한은 제안하지 않는다. 오퍼레이터(00)는 바꾸지 않는다. 제안은 사용자가 적용할 때까지 반영되지 않으니 지금 있는 직원으로 계획을 계속한다. 필요 없으면 빈 배열.',
      ...this.staffSection(m),
      '- 보류한 업무(아래)는 사용자 확인을 기다리는 중이다. 그 실패만으로 ask_user를 고르지 말고 나머지 일로 판단한다. 남은 일이 보류한 업무뿐이면 ask_user.',
      ...this.parkedSection(m),
    ].join('\n');
  }

  /** 계획·판단에 알려 줄 커밋 요청과 결과(같은 요청을 되풀이하지 않게) */
  private commitSection(m: Mission): string[] {
    const rs = (m.commitRequests ?? []).slice(-10);
    if (!rs.length) return [];
    const st = { pending: '사용자 승인 대기', approved: '승인·커밋됨', declined: '사용자가 거절(커밋하지 않음)', failed: '커밋 실패' } as const;
    return ['## 커밋 요청(최근)', ...rs.map((r) => `- [${st[r.status]}] ${r.repo || '(연결 폴더)'} · "${r.message}" · 파일 ${r.files.slice(0, 8).join(', ')}${r.files.length > 8 ? ` 외 ${r.files.length - 8}개` : ''}${r.sha ? ` → ${r.branch ?? ''} ${r.sha.slice(0, 8)}` : ''}${r.error ? ` (이유: ${r.error.slice(0, 200)})` : ''}`), ''];
  }

  /** 사용자 승인 커밋 요청의 상태를 바꾸고 기록을 남긴다 */
  markCommitRequest(id: string, reqId: string, patch: Partial<MissionCommitRequest>, text: string): MissionCommitRequest {
    const m = this.get(id);
    const list = m.commitRequests ?? [];
    const cur = list.find((r) => r.id === reqId);
    if (!cur) throw new Error('커밋 요청을 찾을 수 없습니다.');
    const next = { ...cur, ...patch, decidedAt: now() };
    const nm = this.set(id, { commitRequests: list.map((r) => (r.id === reqId ? next : r)) });
    this.event(nm, 'answer', text, { commitRequest: reqId, status: next.status });
    return next;
  }

  /** 계획·판단에 알려 줄 지금 시연 목록(서비스·API·목록 오류) */
  private demoSection(plan: PlanFields): string[] {
    const man = readManifest(plan);
    const setting = `- 지금 앱 설정(사용자가 정한 것, 다시 묻지 않는다): 명령 허용 범위 ${this.d.commandLevel?.() ?? 'low'}, 로컬 포트 열기(시험·시연 서버 기동) ${this.d.testLocalSockets?.() ? '허용됨' : '꺼짐'}.`;
    if (!man.exists) return [setting, '- 지금 시연 목록 파일은 아직 없다. 실행 가능한 기능을 만드는 작업에서 직원이 만든다.'];
    return [
      setting,
      `- 지금 시연 목록: 서비스 ${man.services.map((x) => `${x.id}(${x.kind}${x.port ? `, 포트 ${x.port}` : ''}, ${x.data})`).join(', ') || '없음'} / API ${man.apis.length}개${man.apis.length ? ` (${man.apis.slice(0, 12).map((a) => `${a.service}:${a.id}`).join(', ')})` : ''}`,
      ...(man.errors.length ? [`- 시연 목록 오류(고칠 것): ${man.errors.slice(0, 5).join(' / ')}`] : []),
    ];
  }

  /** 오퍼레이터 호출: Claude CLI(읽기 전용 도구, 구조화 출력). 모의 실행이면 모의 CLI를 쓴다. */
  /** key: 프로세스 관리 칸(기본은 미션 ID). 배운 것 정리는 계획 호출과 칸을 나눠 서로의 정리 과정이 겹치지 않게 한다. */
  private async callOperator<T>(m: Mission, plan: PlanFields, prompt: string, schema: object, key: string = m.id): Promise<T> {
    const ex = this.d.executor();
    const op = this.d.store.listAgents(m.projectId).find((a) => a.code === '00');
    const args = buildClaudeArgs({
      prompt, appendSystemPrompt: `당신은 CREWGENAI 개발팀의 00 총괄 오퍼레이터다. ${op?.instructions ?? ''}`.slice(0, 4000), cwd: plan.folder,
      tools: ['Read', 'Grep', 'Glob'], editScopes: [], allowedCommands: [], readDirs: [], sessionId: randomUUID(), resumeSessionId: null,
      jsonSchema: schema, model: op?.model ?? '', effort: op?.effort, maxBudgetUsd: op?.maxBudgetUsd ?? null,
    });
    const file = ex.executor === 'mock' ? process.execPath : ex.cliPath;
    if (!file) throw new Error('Claude CLI가 준비되지 않았습니다.');
    const argv = ex.executor === 'mock' ? [this.d.mockScript, ...args] : args;
    const sink: StreamSink = { sessionId: null, result: null, limit: null };
    const h = startProcess(file, argv, { cwd: plan.folder, env: cleanEnv(ex.executor === 'mock' ? { ELECTRON_RUN_AS_NODE: '1' } : {}), stdin: prompt, timeoutSec: 900,
      onStdoutLine: (l) => { interpretLine(l, sink); }, onStderrLine: () => {} });
    this.procs.set(key, h);
    const sid = args[args.indexOf('--session-id') + 1] ?? '';
    const ps = await processStart(h.pid);
    if (!this.closed) this.d.store.db.prepare('INSERT OR REPLACE INTO mission_procs VALUES(?,?,?,?)').run(key, h.pid, ps, sid);
    const done = await h.done;
    this.procs.delete(key);
    if (!this.closed) this.d.store.db.prepare('DELETE FROM mission_procs WHERE mission_id=?').run(key);
    if (this.closed) throw new Error('앱 종료');
    const r = sink.result;
    if (done.cancelled) throw new Error('오퍼레이터 호출이 취소됐습니다.');
    const lim = claudeLimit(sink, done.code);
    if (lim) throw new OperatorLimit(lim);
    if (!this.closed) this.addUsage(m.id, r ? [{ costUsd: r.costUsd, usage: r.usage }] : [{ costUsd: null, usage: null }]);
    if (done.code !== 0 || !r || r.isError) throw new Error(`오퍼레이터 호출 실패(종료 코드 ${done.code ?? '없음'}${r?.subtype ? `, ${r.subtype}` : ''})${r?.text ? `: ${redact(r.text).slice(0, 240)}` : ''}`);
    let v = r.structured as T | null;
    if (!v) { const mm = r.text.match(/\{[\s\S]*\}/); try { v = mm ? JSON.parse(mm[0]) as T : null; } catch { v = null; } }
    if (!v) throw new Error('오퍼레이터가 구조화된 결과를 돌려주지 않았습니다.');
    return v;
  }
}

/** 결과물의 시연 연결: 서비스 id와 화면 경로(/로 시작) 또는 API 항목 id. 서비스가 없으면 시연 없음. */
function cleanDemo(d: RawResult['demo']): ResultDemo | null {
  if (!d || typeof d !== 'object') return null;
  const service = String(d.service ?? '').trim().slice(0, 40);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(service)) return null;
  const path = String(d.path ?? '').trim().slice(0, 400);
  const api = String(d.api ?? '').trim().slice(0, 60);
  if (path && (!path.startsWith('/') || path.startsWith('//'))) return null;
  const data = (['api+db', 'screen-only', 'mock'] as const).find((x) => x === d.data) ?? 'screen-only';
  return { service, path: path || (api ? '' : '/'), api, steps: redact(String(d.steps ?? '')).slice(0, 800), expected: redact(String(d.expected ?? '')).slice(0, 400), data };
}

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/i;

/** 판단이 적은 결과물을 확인한다: 화면 주소는 이 컴퓨터(localhost)만, 파일은 프로젝트 폴더 안(링크를 푼 실제 경로 기준)만. */
/** 두 질문이 같은 대상을 묻는가: 따옴표·백틱으로 인용한 문구(6자 이상)가 겹치면 같은 대상으로 본다 */
export function sameSubject(a: string, b: string): boolean {
  const quoted = (t: string) => new Set([...t.matchAll(/['‘“"`]([^'’”"`]{6,120})['’”"`]/g)].map((x) => x[1].replace(/\s+/g, ' ').trim()));
  const qa = quoted(a); for (const q of quoted(b)) if (qa.has(q)) return true;
  return false;
}

/** 결과 상태 정리: 실제로 확인하지 않은 결과를 '검증됨·검토 가능'으로 올리지 않는다 */
export function resultStatus(r: { status?: string; verified?: string; demo?: unknown }): ResultStatus {
  const st = (RESULT_STATUSES as readonly string[]).includes(String(r.status)) ? (r.status as ResultStatus) : 'implemented';
  const v = String(r.verified ?? '').trim();
  const unverified = !v || /^미검증|미실행|실행하지 못|확인하지 못/.test(v);
  if (unverified && ['verified', 'reviewable', 'feedback_applied'].includes(st)) return 'implemented';
  return st;
}

/** 검토 지점 정리: 결정은 최대 3개(미결 '결정' 항목을 합쳐서), 가정은 이번 것과 누적한 것을 함께 */
export function emptyUsage(): MissionUsage { return { calls: 0, reported: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }; }
/** 실행 범위 정리: 참여 직원은 이 프로젝트의 활성 직원 id만(오퍼레이터는 늘 포함되므로 빼고 저장). 시간 상한은 두지 않는다. */
export function cleanLimits(raw: Partial<MissionLimits> | null | undefined, active: Agent[]): MissionLimits | null {
  if (!raw) return null;
  const ids = Array.isArray(raw.staff) ? [...new Set(raw.staff.map(String))].filter((x) => active.some((a) => a.id === x && a.code !== '00')) : [];
  if (Array.isArray(raw.staff) && raw.staff.length && !ids.length) throw new Error('고른 참여 직원을 이 프로젝트의 활성 직원에서 찾지 못했습니다. 직원 목록을 새로 고친 뒤 다시 고르세요.');
  return ids.length ? { staff: ids } : null;
}

/** 이전 검토 카드에서 답하지 않은 결정을 미결 '결정' 항목으로 넘긴다(새 카드가 나와도 잃지 않음, 이미 있는 항목은 다시 넣지 않음) */
export function carryCheckpoint(cp: MissionCheckpoint | null | undefined, gaps: MissionGap[]): MissionGap[] {
  const out = [...gaps];
  for (const d of cp?.decisions ?? []) {
    const g: MissionGap = { doc: d.doc, issue: d.question, need: '', kind: 'decide', ...(d.choices.length ? { choices: d.choices, options: d.choices.map((c) => c.label) } : {}) };
    if (!out.some((x) => gapKey(x) === gapKey(g) || sameSubject(x.issue, g.issue))) out.push(g);
  }
  return out.slice(0, GAP_CAP);
}

/** 판단 요약 첫 줄을 검토 지점 제목으로(굵은 '한 줄 요약:' 머리말은 뺀다). 다음 계획이 아니라 이번에 한 일을 제목으로 쓴다. */
export function summaryTitle(summary: string): string {
  const line = String(summary ?? '').split('\n').map((l) => l.replace(/\*\*/g, '').replace(/^\s*한\s*줄\s*요약\s*[:：]\s*/, '').trim()).find(Boolean) ?? '';
  return redact(line).slice(0, 160);
}

export function buildCheckpoint(raw: RawCheckpoint | undefined, cycle: number, results: MissionResult[], openGaps: MissionGap[], assumptions: string[], reason: MissionCheckpoint['reason'], fallbackTitle: string, demo: string[] = []): MissionCheckpoint {
  const t = (v: unknown, n: number) => redact(String(v ?? '').trim()).slice(0, n);
  // 기능 상태도 실제 확인 기록(검토 지점의 verified)이 없으면 올리지 않는다
  const features = (Array.isArray(raw?.features) ? raw!.features! : []).filter((f) => t(f?.name, 200)).slice(0, 8)
    .map((f) => ({ name: t(f.name, 200), changed: t(f.changed, 400), status: resultStatus({ status: f.status, verified: raw?.verified }) }));
  const feats = features.length ? features : results.slice(0, 8).map((r) => ({ name: r.title, changed: r.changed, status: r.status ?? 'implemented' }));
  const fromJudge = (Array.isArray(raw?.decisions) ? raw!.decisions! : []).filter((d) => t(d?.question, 400))
    .map((d) => ({ doc: '검토 지점', question: t(d.question, 400), choices: cleanChoices(d.choices) }));
  const fromGaps = openGaps.filter((g) => g.kind !== 'assume').map((g) => ({ doc: g.doc, question: g.issue, choices: g.choices?.length ? g.choices : (g.options ?? []).map((label) => ({ label, effect: '', recommended: false, why: '' })) }));
  const seen = new Set<string>(); const decisions: MissionCheckpoint['decisions'] = [];
  for (const d of [...fromJudge, ...fromGaps]) { const k = `${d.doc}|${d.question}`; if (seen.has(k) || decisions.some((x) => sameSubject(x.question, d.question))) continue; seen.add(k); decisions.push(d); if (decisions.length >= 3) break; }
  // 오퍼레이터가 확인 범위를 적지 않았으면(자동 진행 한도 등) 앱이 판단 직전에 직접 확인한 시연 결과로 채운다
  const demoLines = demo.map((l) => String(l).trim()).filter((l) => l.startsWith('- '));
  const okLine = (l: string) => {
    const api = /^- API .*?: (\d{3})(?: \(기대: (.*)\))?$/.exec(l);
    if (api) return api[2] ? api[2].includes(api[1]) : api[1].startsWith('2'); // 기대 응답이 있으면 그 코드와 같아야 확인된 것
    return /응답 정상$/.test(l);
  };
  const demoOk = demoLines.filter(okLine).map((l) => `${l} (앱이 직접 확인)`);
  const demoNot = demoLines.filter((l) => !okLine(l));
  const as = [...new Set([...(Array.isArray(raw?.assumptions) ? raw!.assumptions!.map((a) => t(a, 300)) : []), ...assumptions])].filter(Boolean).slice(0, 12);
  return { cycle, at: now(), title: t(raw?.title, 200) || fallbackTitle, features: feats, steps: t(raw?.steps, 1500), verified: t(raw?.verified, 800) || t(demoOk.join('\n'), 800), unverified: t(raw?.unverified, 800) || t(demoNot.join('\n'), 800), decisions, assumptions: as, reason };
}

export function resolveResults(folder: string, raw: unknown): MissionResult[] {
  const out: MissionResult[] = [];
  let root = folder; try { root = realpathSync(folder); } catch { /* 폴더 없음 */ }
  for (const r of (Array.isArray(raw) ? raw : []).slice(0, 20) as RawResult[]) {
    const p = String(r?.path ?? '').trim();
    if (!p) continue;
    const base = { task: String(r.task ?? '').slice(0, 200), title: String(r.title ?? '').slice(0, 200) || p.slice(0, 200), changed: redact(String(r.changed ?? '')).slice(0, 600), check: redact(String(r.check ?? '')).slice(0, 600), verified: redact(String(r.verified ?? '')).slice(0, 400), remaining: redact(String(r.remaining ?? '')).slice(0, 400), demo: cleanDemo(r.demo), status: resultStatus(r) };
    if (/^[a-z]+:\/\//i.test(p)) {
      if (LOCAL_URL.test(p)) out.push({ ...base, kind: 'url', path: p, relPath: p, exists: true });
      continue; // 외부 주소는 넣지 않는다
    }
    const abs = isAbsolute(p) ? resolve(p) : resolve(folder, p);
    let real = abs; let exists = false;
    try { real = realpathSync(abs); exists = statSync(real).isFile() || statSync(real).isDirectory(); } catch { exists = false; }
    const rel = relative(root, real);
    const relLex = relative(resolve(folder), abs);
    if ((exists ? rel : relLex).startsWith('..') || isAbsolute(exists ? rel : relLex)) continue; // 프로젝트 밖
    out.push({ ...base, kind: 'file', path: exists ? real : abs, relPath: (exists ? rel : relLex).split(sep).join('/'), exists });
  }
  return out;
}
