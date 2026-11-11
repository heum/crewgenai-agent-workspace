# 변경 기록

형식: 날짜순, 최신이 위. 배포(main 반영) 때 `vX.Y.Z` 태그를 붙인다. `dev`에 올린 변경은 "미배포"에 적고, `main`에 반영할 때 버전 제목으로 옮긴다.

## 미배포

- 저장소 구조: 앱 소스를 `mac/`(macOS판)과 `windows/`(Windows판)로 나눔. 브랜치는 `main`·`dev`만 사용.
- mac: 최신 앱으로 갱신 — 직원 해고(삭제)·휴가, 사무실 탭(도트 그림 지도·직군 소품), 13인치 MacBook Air 화면 맞춤.
- windows: Windows판 추가 — CLI 찾기·`.cmd` 실행·프로세스 트리 종료·시작 시각 확인을 Windows 방식으로, Bash 도구 끔(OS 격리 없음), 내장 `test`·`grep` 검사, Windows 경로 검사, NSIS 설치 프로그램.
- CI: `mac/`은 macOS, `windows/`는 Windows에서 형식 검사·시험·설치 파일 빌드.
- README: 화면 사진, 폴더 구성, 설치, 버전 관리 규칙.

## 0de64f7 — 2026-11-11

- 앱 소스·검사·사용법을 독립 저장소로 공개(macOS판 단일 구성).
