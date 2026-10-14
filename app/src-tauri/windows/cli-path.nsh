; CLI（disnans.exe）をユーザーの PATH に足す／外す。Tauri の NSIS インストーラのフック。
; 設計: .pi/step5-packaging-design.md の §3 と §8・§10。
;
;  - 足すのは、PATH に $INSTDIR が完全一致で無いときだけ。足したときだけ印（HKCU\Software\disnans-cli-path）を残す。
;  - 外すのは、印に書いてある文字列（足したときの $INSTDIR そのまま）の 1 つだけ。印が無ければ何もしない。
;  - 長すぎるときは何も変えない（PATH も印も）。インストールは続ける。PATH を壊さないことを優先する。
;  - 印の "Created" は、PATH の値そのものが無かったときに 1。外したあと空になり、Created が 1 なら値ごと消す。
;    値があって空だった場合は、外したあと空の値に戻す（インストール前と同じ）。
;
;  Path の状態は、ReadRegStr の戻り値ではなく RegQueryValueExW（データを読まない問い合わせ）で決める。
;  理由: ReadRegStr は、値が上限より長いと失敗して空を返す。失敗を「値が無い」と見ると、
;  既存の PATH を捨てて $INSTDIR だけを書いてしまう（実機 CI で再現）。
;  そこで、次の 4 つを区別する: 値が無い（ERROR_FILE_NOT_FOUND）／読めない（その他のエラー）／
;  長すぎる（DISNANS_PATH_MAX より長い）／読める（0 以上 DISNANS_PATH_MAX 以下）。
;  読めるのは「読める」ときだけで、読んだ長さが問い合わせた長さと一致しなければ触らない。
;
; 長さの上限: NSIS の文字列は NSIS_MAX_STRLEN 文字まで。連結や StrCpy も、上限を超えると切り詰める。
;  DISNANS_PATH_MAX = NSIS_MAX_STRLEN - 200 より長い文字列は、読んでも連結しても書いてもいけない。
;  追加後の長さは、連結の前に計算する。

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

; HKCU\Environment\Path の状態を Out に入れる（データは読まない）。作業: $0-$4。
;   -1: 値が無い（ERROR_FILE_NOT_FOUND）
;   -2: 読めない（キーを開けない、問い合わせに失敗した）
;   0 以上: 文字数（終端の NUL を除く）。読み取り時の ReadRegStr と同じ数え方。
!macro DISNANS_PATH_LEN Out Id
  System::Call 'advapi32::RegOpenKeyExW(i 0x80000001, t "Environment", i 0, i 0x20019, *i .r0) i .r1'
  IntCmp $1 0 ${Id}_open_ok ${Id}_error ${Id}_error
  ${Id}_open_ok:
  System::Call 'advapi32::RegQueryValueExW(i $0, t "Path", i 0, *i .r2, i 0, *i .r3) i .r4'
  System::Call 'advapi32::RegCloseKey(i $0)'
  IntCmp $4 0 ${Id}_have ${Id}_not_ok ${Id}_error
  ${Id}_not_ok:
  IntCmp $4 2 ${Id}_missing ${Id}_error ${Id}_error
  ${Id}_have:
  ; $3 はバイト数（終端の NUL を含む）。文字数 = バイト数 / 2 - 1。空（1 以下）は 0
  IntCmp $3 1 ${Id}_zero ${Id}_zero ${Id}_chars
  ${Id}_chars:
  IntOp $3 $3 / 2
  IntOp ${Out} $3 - 1
  Goto ${Id}_end
  ${Id}_zero:
  StrCpy ${Out} 0
  Goto ${Id}_end
  ${Id}_missing:
  StrCpy ${Out} -1
  Goto ${Id}_end
  ${Id}_error:
  StrCpy ${Out} -2
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

; インストール後: PATH に $INSTDIR を足す（足したときだけ印を残す）。読めない・長すぎるときは何もしない。
!macro NSIS_HOOK_POSTINSTALL
  StrCpy $R1 0
  !insertmacro DISNANS_PATH_LEN $R2 disnans_pi_len
  IntCmp $R2 -1 disnans_pi_missing disnans_pi_not_missing disnans_pi_not_missing
  disnans_pi_not_missing:
  IntCmp $R2 -2 disnans_pi_too_long disnans_pi_size_ok disnans_pi_size_ok
  disnans_pi_size_ok:
  IntCmp $R2 ${DISNANS_PATH_MAX} disnans_pi_read disnans_pi_read disnans_pi_too_long
  disnans_pi_read:
  ClearErrors
  ReadRegStr $R0 HKCU "Environment" "Path"
  IfErrors disnans_pi_too_long disnans_pi_read_ok
  disnans_pi_read_ok:
  StrLen $R3 $R0
  IntCmp $R3 $R2 disnans_pi_have disnans_pi_too_long disnans_pi_too_long
  disnans_pi_missing:
  ; 値が無かった。空の値（長さ 0）は値があるので、ここには来ない
  StrCpy $R0 ""
  StrCpy $R1 1
  disnans_pi_have:
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
  DetailPrint "CLI の PATH は変更しませんでした（PATH を読めない、または長すぎます。上限 ${DISNANS_PATH_MAX} 文字）。CLI は $INSTDIR にあります。必要なら PATH に手で追加してください"
  Goto disnans_pi_end
  disnans_pi_fail:
  DetailPrint "CLI の PATH を書き込めませんでした（変更していません）"
  disnans_pi_end:
!macroend

; アンインストール前: 印に書いた文字列だけを PATH から外す。読めない・長すぎるときは何もせず印を残す。
!macro NSIS_HOOK_PREUNINSTALL
  ClearErrors
  ReadRegStr $R0 HKCU "${DISNANS_CLI_MARK}" "Entry"
  IfErrors disnans_pu_end disnans_pu_have_mark
  disnans_pu_have_mark:
  !insertmacro DISNANS_LEN_OK $R0 $R1 disnans_pu_l2
  StrCmp $R1 1 disnans_pu_entry_pass disnans_pu_too_long
  disnans_pu_entry_pass:
  !insertmacro DISNANS_PATH_LEN $R2 disnans_pu_len
  IntCmp $R2 -1 disnans_pu_drop disnans_pu_not_missing disnans_pu_not_missing
  disnans_pu_not_missing:
  IntCmp $R2 -2 disnans_pu_too_long disnans_pu_size_ok disnans_pu_size_ok
  disnans_pu_size_ok:
  IntCmp $R2 ${DISNANS_PATH_MAX} disnans_pu_read disnans_pu_read disnans_pu_too_long
  disnans_pu_read:
  ClearErrors
  ReadRegStr $R5 HKCU "Environment" "Path"
  IfErrors disnans_pu_too_long disnans_pu_read_ok
  disnans_pu_read_ok:
  StrLen $R3 $R5
  IntCmp $R3 $R2 disnans_pu_have_path disnans_pu_too_long disnans_pu_too_long
  disnans_pu_have_path:
  StrCpy $R2 $R5
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
  disnans_pu_drop:
  ; 外すものが無い（PATH に無い、または値が無い）。印だけ消す
  DeleteRegKey HKCU "${DISNANS_CLI_MARK}"
  Goto disnans_pu_end
  disnans_pu_too_long:
  DetailPrint "CLI の PATH は外しませんでした（PATH を読めない、または長すぎます）。印は残しています"
  disnans_pu_end:
!macroend
