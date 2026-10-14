; CLI（disnans.exe）をユーザーの PATH に足す／外す。Tauri の NSIS インストーラのフック。
; 設計: .pi/step5-packaging-design.md の §3 と §8・§10。
;
;  - 足すのは、PATH に $INSTDIR が完全一致で無いときだけ。足したときだけ印（HKCU\Software\disnans-cli-path）を残す。
;  - 外すのは、印に書いてある文字列（足したときの $INSTDIR そのまま）の 1 つだけ。印が無ければ何もしない。
;  - 長すぎるときは何も変えない（PATH も印も）。インストールは続ける。PATH を壊さないことを優先する。
;  - 印の "Created" は、PATH の値そのものが無かったときに 1。外したあと空になり、Created が 1 なら値ごと消す。
;    値があって空だった場合は、外したあと空の値に戻す（インストール前と同じ）。
;
; 長さの扱い（重要）:
;  NSIS の文字列は NSIS_MAX_STRLEN 文字まで（ビルドにより 1024 や 8192）。ReadRegStr・StrCpy・連結は、
;  上限を超えると黙って切り詰める。切り詰めた PATH に追記して書き戻すと PATH が壊れる。
;  そこで、NSIS_MAX_STRLEN から 200 文字を引いた DISNANS_PATH_MAX より長い文字列は、読んでも書いても
;  連結しても使わない（DISNANS_LEN_OK で確かめる）。切り詰められた値は必ず上限近くなので、必ず弾かれる。
;
; 文字列の操作（DISNANS_FIND / DISNANS_REMOVE）は、レジストリに触れないので
; scripts/nsis/cli-path-harness.nsi で単体テストする。
; 作業用レジスタ: DISNANS_LEN_OK は $R3、DISNANS_FIND / DISNANS_REMOVE は $R3-$R9 を使う。

!define DISNANS_CLI_MARK "Software\disnans-cli-path"

; NSIS の上限（ビルドの定義。取れなければ保守的に 1024）
!ifndef NSIS_MAX_STRLEN
  !define NSIS_MAX_STRLEN 1024
!endif
; 扱ってよい長さの上限（余裕 200 文字）
!define /math DISNANS_PATH_MAX ${NSIS_MAX_STRLEN} - 200
!if ${DISNANS_PATH_MAX} >= ${NSIS_MAX_STRLEN}
  !error "DISNANS_PATH_MAX は NSIS_MAX_STRLEN より小さくしてください"
!endif

; Str の長さが DISNANS_PATH_MAX 以下なら Result に 1、長すぎれば 0 を入れる。作業: $R3。
; Str は呼ぶ前に、読み取り（切り詰め）の有無を含めてこの判定を通すこと。
!macro DISNANS_LEN_OK Str Result Id
  StrLen $R3 ${Str}
  IntCmp $R3 ${DISNANS_PATH_MAX} ${Id}_ok ${Id}_ok ${Id}_ng
  ${Id}_ng:
  StrCpy ${Result} 0
  Goto ${Id}_end
  ${Id}_ok:
  StrCpy ${Result} 1
  ${Id}_end:
!macroend

; List（";" 区切り）に Entry（要素の完全一致）があるかを Result（1 か 0）に入れる。
; List と Entry は、呼ぶ前に DISNANS_LEN_OK で確かめてあること（連結が切れないように）。
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
; List と Entry は、呼ぶ前に DISNANS_LEN_OK で確かめてあること。
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

; インストール後: PATH に $INSTDIR を足す（足したときだけ印を残す）。長すぎれば何もしない。
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
  !insertmacro DISNANS_LEN_OK $R0 $R2 disnans_pi_l1
  StrCmp $R2 1 disnans_pi_l1_pass disnans_pi_too_long
  disnans_pi_l1_pass:
  !insertmacro DISNANS_LEN_OK $INSTDIR $R2 disnans_pi_l2
  StrCmp $R2 1 disnans_pi_l2_pass disnans_pi_too_long
  disnans_pi_l2_pass:
  !insertmacro DISNANS_FIND $R0 $INSTDIR $R2 disnans_pi_f
  StrCmp $R2 1 disnans_pi_end disnans_pi_add
  disnans_pi_add:
  ; 追加後の長さを、連結より前に確かめる（連結は上限で黙って切れるため）
  StrLen $R2 $R0
  StrLen $R3 $INSTDIR
  IntOp $R2 $R2 + $R3
  IntOp $R2 $R2 + 1
  IntCmp $R2 ${DISNANS_PATH_MAX} disnans_pi_sum_ok disnans_pi_sum_ok disnans_pi_too_long
  disnans_pi_sum_ok:
  StrCmp $R0 "" disnans_pi_first disnans_pi_append
  disnans_pi_first:
  StrCpy $R4 "$INSTDIR"
  Goto disnans_pi_set
  disnans_pi_append:
  StrCpy $R4 "$R0;$INSTDIR"
  disnans_pi_set:
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
  DetailPrint "CLI の PATH は変更しませんでした（PATH が長すぎます。上限 ${DISNANS_PATH_MAX} 文字）。CLI は $INSTDIR にあります。必要なら PATH に手で追加してください"
  Goto disnans_pi_end
  disnans_pi_fail:
  DetailPrint "CLI の PATH を書き込めませんでした（変更していません）"
  disnans_pi_end:
!macroend

; アンインストール前: 印に書いた文字列だけを PATH から外す。長すぎれば何もしない（印も残す）。
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
  !insertmacro DISNANS_LEN_OK $R2 $R1 disnans_pu_l1
  StrCmp $R1 1 disnans_pu_l1_pass disnans_pu_too_long
  disnans_pu_l1_pass:
  !insertmacro DISNANS_LEN_OK $R0 $R1 disnans_pu_l2
  StrCmp $R1 1 disnans_pu_l2_pass disnans_pu_too_long
  disnans_pu_l2_pass:
  !insertmacro DISNANS_FIND $R2 $R0 $R1 disnans_pu_f
  StrCmp $R1 1 disnans_pu_remove disnans_pu_drop
  disnans_pu_remove:
  !insertmacro DISNANS_REMOVE $R2 $R0 $R2 disnans_pu_r
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
  Goto disnans_pu_end
  disnans_pu_too_long:
  DetailPrint "CLI の PATH は外しませんでした（PATH が長すぎます）。印は残しています"
  disnans_pu_end:
!macroend
