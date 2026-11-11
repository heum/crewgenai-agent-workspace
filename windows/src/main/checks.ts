// Windows판 내장 검사: Windows에 없는 test·grep을 앱에 포함된 Node 스크립트(resources/check-builtin.cjs)로 실행한다.
/** 내장 검사로 실행하는 명령 이름(정확히 이 값일 때만. 프로젝트의 test.cmd·grep.bat 등은 해당하지 않음) */
export const BUILTIN_CHECK = new Set(['test', 'grep', '/bin/test', '/usr/bin/test', '/bin/grep', '/usr/bin/grep']);
