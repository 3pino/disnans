; CLI（disnans.exe）をユーザーの PATH に足す／外す。Tauri の NSIS インストーラのフック。
; 設計: .pi/step5-packaging-design.md の §3。
;
;  - 足すのは、PATH に $INSTDIR が完全一致で無いときだけ。足したときだけ印（HKCU\Software\disnans-cli-path）を残す。
;  - 外すのは、印に書いてある文字列（足したときの $INSTDIR そのまま）だけ。印が無ければ何もしない。
;  - 読めない・書けない・長すぎるときは何も変えない（PATH を壊さない）。
;  - 印の "Created" は、PATH の値そのものが無かったときに 1。外したあと空になり、Created が 1 なら値ごと消す。
;    値があって空だった場合は、外したあと空の値に戻す（インストール前と同じ）。
;
; 文字列の操作（DISNANS_FIND / DISNANS_REMOVE）は、レジストリに触れないので
; scripts/nsis/cli-path-harness.nsi で単体テストする。
; 作業用レジスタ: DISNANS_FIND は $R3-$R9、DISNANS_REMOVE は $R3-$R9 を使う（呼び出し側はそれ以外を使う）。

!define DISNANS_CLI_MARK "Software\disnans-cli-path"
; NSIS の文字列の上限より十分小さくする（上限の確認は harness の maxlen で行う）
!define DISNANS_PATH_MAX 1800

; List（";" 区切り）に Entry（要素の完全一致）があるかを Result（1 か 0）に入れる。
!macro DISNANS_FIND List Entry Result Id
  StrCpy $R8 ";${List};"
  StrCpy $R9 ";${Entry};"
  StrLen $R7 $R9
  StrCpy ${Result} 0
  StrCpy $R5 0
  ${Id}_scan:
  StrLen $R6 $R8
  IntOp $R4 $R5 + $R7
  IntCmp $R4 $R6 ${Id}_try ${Id}_try ${Id}_end
  ${Id}_try:
  StrCpy $R3 $R8 $R7 $R5
  StrCmp $R3 $R9 ${Id}_hit ${Id}_next
  ${Id}_next:
  IntOp $R5 $R5 + 1
  Goto ${Id}_scan
  ${Id}_hit:
  StrCpy ${Result} 1
  ${Id}_end:
!macroend

; List から Entry の要素（完全一致）を 1 つだけ取り除き、結果を Out に入れる。
; 1 つだけにするのは、足したものは 1 つだけで、同じ文字列をユーザーが後から足したものを消さないため。
; 作業: $R8 は ";List;" を、$R9 は ";Entry;" を持つ。左右をつないで ";...;" を作り、最後に両端の ";" を外す。
!macro DISNANS_REMOVE List Entry Out Id
  StrCpy $R8 ";${List};"
  StrCpy $R9 ";${Entry};"
  StrLen $R7 $R9
  StrCpy $R5 0
  ${Id}_scan:
  StrLen $R6 $R8
  IntOp $R4 $R5 + $R7
  IntCmp $R4 $R6 ${Id}_try ${Id}_try ${Id}_out
  ${Id}_try:
  StrCpy $R3 $R8 $R7 $R5
  StrCmp $R3 $R9 ${Id}_cut ${Id}_skip
  ${Id}_cut:
  ; 左: 一致の手前まで（先頭が ";" のとき 0 文字）
  IntCmp $R5 0 ${Id}_left_empty ${Id}_left_empty ${Id}_left_copy
  ${Id}_left_empty:
  StrCpy $R3 ""
  Goto ${Id}_right
  ${Id}_left_copy:
  StrCpy $R3 $R8 $R5
  ${Id}_right:
  ; 右: 一致の末尾の ";" から最後まで（その ";" は残す）
  IntOp $R4 $R4 - 1
  IntOp $R6 $R6 - $R4
  StrCpy $R4 $R8 $R6 $R4
  StrCpy $R8 "$R3$R4"
  Goto ${Id}_out
  ${Id}_skip:
  IntOp $R5 $R5 + 1
  Goto ${Id}_scan
  ${Id}_out:
  ; 両端の ";" を外す
  StrLen $R6 $R8
  IntOp $R4 $R6 - 2
  IntCmp $R4 0 ${Id}_empty ${Id}_empty ${Id}_inner
  ${Id}_inner:
  StrCpy ${Out} $R8 $R4 1
  Goto ${Id}_end
  ${Id}_empty:
  StrCpy ${Out} ""
  ${Id}_end:
!macroend

; インストール後: PATH に $INSTDIR を足す（足したときだけ印を残す）
!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrCpy $R1 0
  IfErrors disnans_pi_missing disnans_pi_check
  disnans_pi_missing:
  ; 値が無かった（空の値は無かったことにしない）。外すときに値ごと消す印にする
  StrCpy $R0 ""
  StrCpy $R1 1
  disnans_pi_check:
  StrLen $R2 $R0
  IntCmp $R2 ${DISNANS_PATH_MAX} disnans_pi_len_ok disnans_pi_len_ok disnans_pi_too_long
  disnans_pi_len_ok:
  !insertmacro DISNANS_FIND "$R0" "$INSTDIR" $R2 disnans_pi_f
  StrCmp $R2 1 disnans_pi_end disnans_pi_add
  disnans_pi_add:
  StrCmp $R0 "" disnans_pi_first disnans_pi_append
  disnans_pi_first:
  StrCpy $R4 "$INSTDIR"
  Goto disnans_pi_set
  disnans_pi_append:
  StrCpy $R4 "$R0;$INSTDIR"
  disnans_pi_set:
  StrLen $R2 $R4
  IntCmp $R2 ${DISNANS_PATH_MAX} disnans_pi_write disnans_pi_write disnans_pi_too_long
  disnans_pi_write:
  ClearErrors
  WriteRegExpandStr HKCU "Environment" "Path" "$R4"
  IfErrors disnans_pi_fail disnans_pi_wrote
  disnans_pi_wrote:
  WriteRegStr HKCU "${DISNANS_CLI_MARK}" "Entry" "$INSTDIR"
  WriteRegStr HKCU "${DISNANS_CLI_MARK}" "Created" "$R1"
  System::Call 'user32::SendMessageTimeout(i 0xFFFF, i 0x001A, i 0, t "Environment", i 0x0002, i 5000, *i .r9)'
  DetailPrint "CLI の PATH に追加しました: $INSTDIR"
  Goto disnans_pi_end
  disnans_pi_too_long:
  DetailPrint "CLI の PATH は変更しませんでした（PATH が長すぎるか、読めませんでした）"
  Goto disnans_pi_end
  disnans_pi_fail:
  DetailPrint "CLI の PATH を書き込めませんでした（変更していません）"
  disnans_pi_end:
!macroend

; アンインストール前: 印に書いた文字列だけを PATH から外す
!macro NSIS_HOOK_PREUNINSTALL
  ClearErrors
  ReadRegStr $R0 HKCU "${DISNANS_CLI_MARK}" "Entry"
  IfErrors disnans_pu_end disnans_pu_have_mark
  disnans_pu_have_mark:
  ClearErrors
  ReadRegStr $R2 HKCU "Environment" "Path"
  IfErrors disnans_pu_drop disnans_pu_have_path
  disnans_pu_drop:
  DeleteRegKey HKCU "${DISNANS_CLI_MARK}"
  Goto disnans_pu_end
  disnans_pu_have_path:
  !insertmacro DISNANS_FIND "$R2" "$R0" $R1 disnans_pu_f
  StrCmp $R1 1 disnans_pu_remove disnans_pu_drop
  disnans_pu_remove:
  !insertmacro DISNANS_REMOVE "$R2" "$R0" $R2 disnans_pu_r
  StrCmp $R2 "" disnans_pu_empty disnans_pu_write
  disnans_pu_empty:
  ReadRegStr $R1 HKCU "${DISNANS_CLI_MARK}" "Created"
  StrCmp $R1 "1" disnans_pu_del disnans_pu_write
  disnans_pu_del:
  DeleteRegValue HKCU "Environment" "Path"
  Goto disnans_pu_finish
  disnans_pu_write:
  ClearErrors
  WriteRegExpandStr HKCU "Environment" "Path" "$R2"
  ; 書けなかったら印を残す（印が残っていれば、次の操作で外せる）
  IfErrors disnans_pu_end disnans_pu_finish
  disnans_pu_finish:
  DeleteRegKey HKCU "${DISNANS_CLI_MARK}"
  System::Call 'user32::SendMessageTimeout(i 0xFFFF, i 0x001A, i 0, t "Environment", i 0x0002, i 5000, *i .r9)'
  DetailPrint "CLI の PATH から外しました: $R0"
  disnans_pu_end:
!macroend
