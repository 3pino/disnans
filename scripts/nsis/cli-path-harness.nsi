; cli-path.nsh の文字列操作（DISNANS_FIND / DISNANS_REMOVE）の単体テスト。
; レジストリには触れない。結果を exe と同じフォルダの cli-path-results.txt に書き、
; scripts/nsis/check-cli-path-results.mjs がその内容を期待値と比べる。
Unicode true
Name "cli-path harness"
OutFile "cli-path-harness.exe"
RequestExecutionLevel user
SilentInstall silent
!include "${__FILEDIR__}\..\..\app\src-tauri\windows\cli-path.nsh"

Section
  FileOpen $0 "$EXEDIR\cli-path-results.txt" w

  !insertmacro DISNANS_FIND "A;B;C" "B" $2 f01
  FileWrite $0 "find|A;B;C|B|$2$\r$\n"
  !insertmacro DISNANS_FIND "A;B;C" "BC" $2 f02
  FileWrite $0 "find|A;B;C|BC|$2$\r$\n"
  !insertmacro DISNANS_FIND "A;BC" "B" $2 f03
  FileWrite $0 "find|A;BC|B|$2$\r$\n"
  !insertmacro DISNANS_FIND "B" "B" $2 f04
  FileWrite $0 "find|B|B|$2$\r$\n"
  !insertmacro DISNANS_FIND "A;B" "A" $2 f05
  FileWrite $0 "find|A;B|A|$2$\r$\n"
  !insertmacro DISNANS_FIND "A;B" "C" $2 f06
  FileWrite $0 "find|A;B|C|$2$\r$\n"
  !insertmacro DISNANS_FIND "" "X" $2 f07
  FileWrite $0 "find||X|$2$\r$\n"

  !insertmacro DISNANS_REMOVE "A;B;C" "B" $3 r01
  FileWrite $0 "remove|A;B;C|B|[$3]$\r$\n"
  !insertmacro DISNANS_REMOVE "B" "B" $3 r02
  FileWrite $0 "remove|B|B|[$3]$\r$\n"
  !insertmacro DISNANS_REMOVE "A;B" "A" $3 r03
  FileWrite $0 "remove|A;B|A|[$3]$\r$\n"
  !insertmacro DISNANS_REMOVE "A;B" "B" $3 r04
  FileWrite $0 "remove|A;B|B|[$3]$\r$\n"
  !insertmacro DISNANS_REMOVE "A;E;B;E" "E" $3 r05
  FileWrite $0 "remove|A;E;B;E|E|[$3]$\r$\n"
  !insertmacro DISNANS_REMOVE "E;E" "E" $3 r06
  FileWrite $0 "remove|E;E|E|[$3]$\r$\n"
  !insertmacro DISNANS_REMOVE "ABC" "B" $3 r07
  FileWrite $0 "remove|ABC|B|[$3]$\r$\n"
  !insertmacro DISNANS_REMOVE "A;BC;D" "B" $3 r08
  FileWrite $0 "remove|A;BC;D|B|[$3]$\r$\n"
  !insertmacro DISNANS_REMOVE "A;B" "C" $3 r09
  FileWrite $0 "remove|A;B|C|[$3]$\r$\n"
  !insertmacro DISNANS_REMOVE "E;A;E" "E" $3 r10
  FileWrite $0 "remove|E;A;E|E|[$3]$\r$\n"

  ; 文字列の上限の確認: 2560 文字がそのまま入るか（切り詰めの有無）
  StrCpy $1 "0123456789012345678901234567890123456789"
  StrCpy $1 "$1$1"
  StrCpy $1 "$1$1"
  StrCpy $1 "$1$1"
  StrCpy $1 "$1$1"
  StrCpy $1 "$1$1"
  StrCpy $1 "$1$1"
  StrLen $4 $1
  FileWrite $0 "maxlen|$4$\r$\n"

  FileClose $0

  ; フック本体はコンパイルの確認だけ行う（この Goto で飛ばすので、レジストリには触れない）
  Goto disnans_harness_skip_hooks
  !insertmacro NSIS_HOOK_POSTINSTALL
  !insertmacro NSIS_HOOK_PREUNINSTALL
  disnans_harness_skip_hooks:
SectionEnd
