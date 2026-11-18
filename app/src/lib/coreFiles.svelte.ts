// 「ファイル」の画面の切り替え: コアプラグイン fixplor が読み込めて、view を登録していれば、本体の内蔵の画面（FileExplorer）の代わりに使う。
// 読み込めなければ（失敗・無効・未同梱）内蔵のまま動く（自動の戻し。設定はない）。
// 内蔵の画面のコードは、このリリースではまだ残す（次の版で外す）。
class CoreFiles {
  active = $state(false);
}
export const coreFiles = new CoreFiles();
