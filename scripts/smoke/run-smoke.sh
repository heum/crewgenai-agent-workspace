#!/bin/zsh
# 사용: scripts/smoke/run-smoke.sh <앱 실행 파일> <출력 폴더>
# 별도 데이터 폴더·시험 프로젝트에서 실제 창을 띄워 단계별 화면을 캡처한다(모의 실행 사용).
set -e
APP="$1"; OUT="$2"; HERE="${0:A:h}"
mkdir -p "$OUT/data" "$OUT/project 시험 폴더"
sed "s|__FOLDER__|$OUT/project 시험 폴더|" "$HERE/steps.template.json" > "$OUT/steps.json"
CREWGENAI_DATA_DIR="$OUT/data" CREWGENAI_SMOKE_SCRIPT="$OUT/steps.json" CREWGENAI_SMOKE_OUT="$OUT/shots-1" "$APP" --crewgenai-smoke
CREWGENAI_DATA_DIR="$OUT/data" CREWGENAI_SMOKE_SCRIPT="$HERE/ui.json" CREWGENAI_SMOKE_OUT="$OUT/shots-2-ui" "$APP" --crewgenai-smoke
CREWGENAI_DATA_DIR="$OUT/data" CREWGENAI_SMOKE_SCRIPT="$HERE/reopen.json" CREWGENAI_SMOKE_OUT="$OUT/shots-3-reopen" "$APP" --crewgenai-smoke
echo "결과: $OUT/shots-1/result.json, $OUT/shots-3-reopen/result.json"
