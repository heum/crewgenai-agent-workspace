# CREWGENAI 개발팀 관리 — Windows판 설치·사용 설명서

CREWGENAI 개발팀 관리(앱 이름 `CREWGENAI Agent Workspace`)는 사용자가 팀장이 되어 AI 직원(Agent) 팀을 구성하고, 지시를 내려 작업을 맡기는 데스크톱 앱이다. 이 폴더는 **Windows판(x64)** 이다. 기능과 화면은 macOS판([`../mac/`](../mac/))과 같고, Windows 실행 방식만 다르다(저장소 [README](../README.md)의 "Windows판에서 다른 부분" 표 참고).

앱에는 AI 모델이 들어 있지 않다. 이 PC에 설치되어 로그인된 **Claude CLI**(작업)와 **Codex CLI**(교차 검토)를 실행한다.

- 버전: 검토본 `0.0.0-review.20261110`
- 지원 환경: Windows 10/11 x64
- 화면별 자세한 사용법: [resources/docs/GUIDE.md](resources/docs/GUIDE.md). 앱 안의 **사용법(?)** 에서도 볼 수 있다. 사용법의 Finder·⌘ 표기는 Windows에서 탐색기·Ctrl로 읽는다.

## 1. 설치

### 준비물

| 항목 | 용도 | 확인 방법(PowerShell) |
|---|---|---|
| Git for Windows | 소스 받기, 직원별 커밋 | `git --version` |
| Node.js(npm 포함, v24 이상 권장) | 앱 빌드 | `node -v` |
| Claude CLI | AI 직원 실행(필수) | `claude --version` |
| Codex CLI | 교차 검토(선택) | `codex --version` |

### 순서

1. 저장소를 받는다. 이미 받아 두었으면 `git pull`만 한다.

   ```powershell
   git clone https://github.com/heum/crewgenai-agent-workspace.git
   ```

2. `windows` 폴더에서 의존성을 설치하고 설치 프로그램을 만든다. 몇 분 걸린다.

   ```powershell
   cd crewgenai-agent-workspace\windows
   npm ci
   npm run dist
   ```

3. `windows\release\`에 생긴 `CREWGENAI-Agent-Workspace-…-win-x64-setup.exe`를 실행해 설치한다. 바탕 화면과 시작 메뉴에 **CREWGENAI 개발팀 관리** 바로 가기가 생긴다.

빌드하지 않고 받으려면 저장소의 **Actions** 탭에서 최근 성공한 실행을 열고 `windows-installer` 산출물을 내려받는다.

### 처음 실행할 때 SmartScreen 경고가 나오는 경우

이 앱은 Windows 코드 서명이 없다. "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**을 누른다.

### 빌드 없이 바로 띄워 보기(개발용)

```powershell
npm ci
npm start
```

## 2. 처음 설정

1. **CLI 로그인** — 명령 프롬프트나 PowerShell에서 한 번씩 로그인한다. 앱은 계정 정보와 토큰을 저장하지 않는다.

   ```powershell
   claude auth login
   ```

   ```powershell
   codex login
   ```

   앱 왼쪽 아래 **Claude CLI** 표시를 눌러 **명령 프롬프트에서 로그인**을 눌러도 된다.

2. **준비 상태 확인** — 앱 왼쪽 아래의 **Claude CLI**·**Codex 리뷰** 표시가 초록이면 실행할 수 있다.
   - 앱은 `where`로 찾고, 없으면 `%USERPROFILE%\.local\bin\claude.exe`, `%APPDATA%\npm\claude.cmd`를 확인한다.
   - 찾지 못하면 **CLI 직접 선택**으로 `claude.exe`(또는 `claude.cmd`)를 지정한다.
3. **실행 엔진 확인** — **설정(⚙)** 에서 실행 엔진이 **실제 Claude CLI**인지 확인한다. 모의 실행은 시험용이다.

## 3. 기본 사용 흐름

macOS판과 같다. [mac/README.md의 "기본 사용 흐름"](../mac/README.md#3-기본-사용-흐름)과 [GUIDE.md](resources/docs/GUIDE.md)를 따른다. Windows에서 다른 점은 다음과 같다.

- **Bash 도구**: Windows에는 Claude의 Bash 격리(샌드박스)가 없어, 직원에게 Bash 도구를 켜 두어도 실행할 때는 꺼진다. 시험·빌드 같은 명령은 업무 흐름의 **검사** 단계로 앱이 직접 실행한다. 오퍼레이터가 계획한 검사 명령은 담당 직원의 허용 명령 또는 `test`·`grep`만 실행한다.
- **`test`·`grep` 검사**: Windows에 없는 명령이라 앱에 포함된 내장 검사로 실행한다(`test -s|-f|-e|-d 경로`, `grep [-q] [-i] [-F] [-c] 패턴 파일…`).
- **경로**: 자동 수정 허용 경로·문서 경로는 프로젝트 폴더 기준 상대 경로로 적는다. `C:\…` 같은 드라이브 경로와 `\\서버\…` 경로는 프로젝트 밖으로 보고 거부한다.

## 4. 최신 버전으로 업데이트

```powershell
git pull
cd windows
npm ci
npm run dist
```

새로 생긴 설치 프로그램을 실행해 덮어 설치한다. 기존 기록은 유지된다.

## 5. 데이터

| 대상 | 위치 | 다른 PC로 |
|---|---|---|
| 앱 기록(프로젝트·직원·미션·문서 목록) | `%APPDATA%\CREWGENAI 개발팀 관리\workspace.db`(메뉴 **파일 → 데이터 폴더 탐색기에서 보기**) | 따라가지 않는다. 새 PC는 빈 상태로 시작한다. |
| 완성 문서·결과물 | 각 프로젝트 폴더 | 프로젝트 저장소에 커밋하면 따라간다. |
| Claude·Codex 로그인 | 각 CLI가 관리 | PC마다 따로 로그인한다. |

## 6. 문제 해결

| 증상 | 확인할 것 |
|---|---|
| `npm ci` 실패 | `node -v`로 Node.js 설치를 확인한다. `node_modules`를 지우고 다시 실행한다. |
| SmartScreen 경고 | 위 "처음 실행할 때" 항목을 따른다. |
| Claude CLI 빨간색 | PowerShell에서 `claude --version`, `claude auth login`. 앱을 다시 연다. 그래도 안 되면 **CLI 직접 선택**. |
| Codex 리뷰 빨간색 | `codex login`. Codex가 없어도 Claude 작업은 할 수 있으나 교차 검토는 실행되지 않는다. |
| "실행 파일을 해석하지 못했습니다" | `.cmd` 안의 Node 스크립트를 찾지 못한 경우다. 설정에서 `.exe` 실행 파일을 직접 지정한다. |
| 검사 단계가 "명령을 찾을 수 없음"으로 실패 | Windows에 없는 명령(`sh`, `/bin/...`)을 검사 명령으로 쓴 경우다. `npm test` 같은 Windows에서 실행되는 명령이나 `test`·`grep`을 쓴다. |

## 7. 알려진 제한

- Windows 코드 서명이 없다.
- Claude의 Bash 도구를 쓰지 않는다(위 3 참고).
- 실제 Claude·Codex로 미션을 끝까지 돌린 확인은 아직 없다. CI(Windows)에서 자동 시험과 설치 프로그램 빌드까지 확인한다.
- 시험 스크립트(`scripts/smoke`, `scripts/verify-install.sh`)는 macOS용이라 Windows에서는 쓰지 않는다.

## 공개 범위

이 저장소는 앱 소스·검사·사용법을 분리한 검토본입니다. 내부 프로젝트 기록과 실행 DB·인증 자료·설치 파일은 포함하지 않습니다. 라이선스는 아직 지정하지 않았습니다.
