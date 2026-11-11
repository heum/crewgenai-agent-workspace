#!/bin/zsh
# DMG를 마운트해 .app을 지정 폴더에 설치(복사)하고, 설치된 앱으로 스모크 흐름을 실행한다.
# 사용: scripts/verify-install.sh <dmg> <작업 폴더>
set -e
DMG="$1"; W="$2"; HERE="${0:A:h}"
mkdir -p "$W/mnt" "$W/Applications"
hdiutil attach -nobrowse -readonly -mountpoint "$W/mnt" "$DMG" >/dev/null
rm -rf "$W/Applications/CREWGENAI Agent Workspace.app"
ditto "$W/mnt/CREWGENAI Agent Workspace.app" "$W/Applications/CREWGENAI Agent Workspace.app"
ls "$W/mnt" > "$W/dmg-contents.txt"
hdiutil detach -force "$W/mnt" >/dev/null
APP="$W/Applications/CREWGENAI Agent Workspace.app"
/usr/bin/defaults read "$APP/Contents/Info.plist" CFBundleDisplayName > "$W/display-name.txt"
file "$APP/Contents/MacOS/CREWGENAI Agent Workspace" > "$W/arch.txt"
rm -rf "$W/smoke"
"$HERE/smoke/run-smoke.sh" "$APP/Contents/MacOS/CREWGENAI Agent Workspace" "$W/smoke"
