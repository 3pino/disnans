use clap::{Args, Parser, Subcommand};

/// disnans のコマンドラインクライアント。
#[derive(Debug, Parser)]
#[command(name = "disnans", version, about, arg_required_else_help = true)]
pub struct Cli {
    /// 接続先を一時的に上書きする（保存はしない）。
    #[arg(long, global = true, value_name = "URL")]
    pub server: Option<String>,

    /// DISNANS_DEV=1 のサーバーで使う開発用ユーザー（保存はしない）。
    #[arg(long, global = true, value_name = "LOGIN_NAME", value_parser = dev_user)]
    pub dev_user: Option<String>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// 共通接続先ファイルの設定（GUI は後続ステップで移行）。
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// 自分のアカウント情報を表示する。
    Me(JsonOption),
    /// メインチャットの履歴を表示する（古い順）。
    Messages(MessagesArgs),
    /// 本文を検索する（新しい順。空白で区切った語をすべて含むもの）。
    Search(SearchArgs),
    /// メインチャットへ投稿する。自動再送はしない。
    Send(SendArgs),
    /// メッセージにリアクションを付ける。成否が不明でも自動再送しない。
    React(ReactArgs),
    /// 自分が付けたリアクションを外す。成否が不明でも自動再送しない。
    Unreact(ReactArgs),
    /// メインチャットの新着・編集・削除を1行ずつ表示し続ける。
    Watch(JsonOption),
    /// メインチャットを読み書きするターミナル画面（TUI）を開く。
    Tui,
    /// プラグイン・テーマを配布・一覧・削除する。
    #[command(subcommand)]
    Plugin(PluginAction),
    /// 共有フォルダのファイルを一覧・取得・送信・削除・移動・コピーする。
    #[command(subcommand)]
    Files(FilesAction),
    /// 新しいバージョンを確認し、あれば更新する（GitHub Releases）。
    Update(UpdateArgs),
}

#[derive(Debug, Subcommand)]
pub enum FilesAction {
    /// フォルダの中身（ファイルならその項目）を表示する。
    Ls(FilesLsArgs),
    /// ファイルを取得する（`-` なら標準出力）。
    Get(FilesGetArgs),
    /// ローカルのファイルを送る（既存は `--force` で上書き）。
    Put(FilesPutArgs),
    /// 削除する（フォルダは `-r` が必要）。
    Rm(FilesRmArgs),
    /// 移動・名前の変更（TO は新しいパスそのもの）。
    Mv(FilesMoveArgs),
    /// コピー（TO は新しいパスそのもの。添付からのコピーも可）。
    Cp(FilesMoveArgs),
    /// フォルダを作る（親は必要）。
    Mkdir(FilesMkdirArgs),
}

#[derive(Debug, Args)]
pub struct FilesLsArgs {
    /// 共有フォルダからの相対パス。省略すると直下。
    pub path: Option<String>,
    /// 結果を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct FilesGetArgs {
    /// 取得するファイルのパス。
    pub path: String,
    /// 保存先（省略するとカレントに同じ名前で。フォルダならその中に。`-` は標準出力）。
    pub dest: Option<String>,
    /// 既存のローカルファイルを上書きする。
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct FilesPutArgs {
    /// 送るローカルのファイル。
    pub local: std::path::PathBuf,
    /// 共有フォルダ内のパス（省略すると直下に同じ名前で。フォルダならその中に）。
    pub path: Option<String>,
    /// 既存のファイルを上書きする。
    #[arg(long)]
    pub force: bool,
    /// 結果を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct FilesRmArgs {
    pub path: String,
    /// フォルダを中身ごと消す。
    #[arg(short = 'r', long)]
    pub recursive: bool,
    /// 結果を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct FilesMoveArgs {
    pub from: String,
    pub to: String,
    /// 同名のファイルがあれば上書きする（フォルダへの上書きはサーバーが拒否）。
    #[arg(long)]
    pub force: bool,
    /// 結果を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct FilesMkdirArgs {
    pub path: String,
    /// 結果を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Subcommand)]
pub enum PluginAction {
    /// ディレクトリのプラグイン・テーマを配布（同じ id なら更新）する。
    Publish(PluginPublishArgs),
    /// 開発中（開発用フォルダ）と配布済みのプラグイン・テーマの一覧。
    List(PluginListArgs),
    /// プラグイン・テーマを削除する。
    Remove(PluginRemoveArgs),
    /// 開発用フォルダ（GUI の設定と同じ、このデバイスの `pluginsDevDir`）を表示・設定する。
    Devdir(PluginDevdirArgs),
}

#[derive(Debug, Args)]
pub struct PluginListArgs {
    /// 結果を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct PluginPublishArgs {
    /// 配布するプラグインの id（開発用フォルダ内の manifest.json の id で探す）。
    #[arg(required_unless_present = "dir", conflicts_with = "dir")]
    pub id: Option<String>,

    /// id の代わりに、manifest.json などがあるディレクトリを直接指定する。
    #[arg(long, value_name = "PATH")]
    pub dir: Option<std::path::PathBuf>,

    /// 自分だけのものとして配布する。
    #[arg(long, conflicts_with = "public")]
    pub private: bool,

    /// みんなに配布する。`--private` も指定しなければ、既存の公開状態を保つ（新規は public）。
    #[arg(long)]
    pub public: bool,

    /// manifest の id / version を表示するだけで、配布しない。
    #[arg(long)]
    pub dry_run: bool,

    /// 結果を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct PluginDevdirArgs {
    /// 設定するフォルダ（絶対パスに直して保存する。存在しなければ終了 2）。省略すると今の値を表示する。
    #[arg(value_name = "PATH", conflicts_with = "clear")]
    pub path: Option<std::path::PathBuf>,

    /// 未設定に戻す。
    #[arg(long)]
    pub clear: bool,

    /// 結果を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct PluginRemoveArgs {
    /// 削除するプラグイン・テーマの id。
    pub id: String,

    /// 結果を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct UpdateArgs {
    /// 確認だけして、インストールしない。
    #[arg(long)]
    pub check: bool,
}

#[derive(Debug, Args)]
pub struct ReactArgs {
    /// 対象のメッセージ ID。
    #[arg(value_name = "MESSAGE_ID")]
    pub message_id: String,

    /// 絵文字（例: 👍）。
    #[arg(value_name = "EMOJI", value_parser = emoji_arg)]
    pub emoji: String,

    /// 結果を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

/// 空・制御文字・長すぎるものは接続前に断る（細かい判定はサーバーが行う）。
fn emoji_arg(value: &str) -> Result<String, String> {
    if value.trim().is_empty() || value.len() > 64 || value.chars().any(char::is_control) {
        return Err("絵文字は 64 バイト以内で、空や制御文字を含めないでください".into());
    }
    Ok(value.to_owned())
}

#[derive(Debug, Args)]
pub struct SendArgs {
    /// 投稿する本文。引数はプロセス一覧やシェル履歴に残るため、機密や長文・複数行は `--stdin` を使う。
    #[arg(
        value_name = "TEXT",
        conflicts_with = "stdin",
        required_unless_present_any = ["stdin", "attach"]
    )]
    pub text: Option<String>,

    /// 添付するファイル（繰り返せる）。先にアップロードし、投稿に添付する（本文が空でもよい）。
    #[arg(long, value_name = "FILE")]
    pub attach: Vec<std::path::PathBuf>,

    /// 標準入力を EOF まで読んで本文にする。
    #[arg(long)]
    pub stdin: bool,

    /// 通知を送らずに投稿する。
    #[arg(long)]
    pub silent: bool,

    /// 返信先のメッセージ ID（メインチャットのメッセージ）。
    #[arg(long, value_name = "MESSAGE_ID")]
    pub reply_to: Option<String>,

    /// 確認済みの message_id と client_id を JSON で標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Subcommand)]
pub enum ConfigAction {
    /// 接続先を共通ファイルに保存する。
    SetServer { url: String },
    /// 保存済みの接続先を表示する。
    Show(JsonOption),
}

#[derive(Debug, Args)]
pub struct JsonOption {
    /// 機械処理向けに JSON を1値だけ標準出力へ書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct MessagesArgs {
    /// 読む件数（1〜200、既定50）。
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=200))]
    pub limit: u32,

    /// 指定した ID より古いメッセージを読む。
    #[arg(long, value_name = "MESSAGE_ID", value_parser = nonempty)]
    pub before: Option<String>,

    /// 機械処理向けに Message の配列を JSON で書く。
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub struct SearchArgs {
    /// 探す語（空白で区切った語をすべて含むもの。大文字小文字は区別しない。200 文字まで）。
    #[arg(value_name = "QUERY", required = true, num_args = 1.., value_parser = nonempty_query)]
    pub query: Vec<String>,

    /// 読む件数（1〜200、既定50）。
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=200))]
    pub limit: u32,

    /// 指定した ID より古い結果を探す（前回の最後の ID を渡して続きを読む）。
    #[arg(long, value_name = "MESSAGE_ID", value_parser = nonempty)]
    pub before: Option<String>,

    /// 機械処理向けに Message の配列を JSON で書く。
    #[arg(long)]
    pub json: bool,
}

impl SearchArgs {
    /// 語を空白 1 つでつないだ検索語。
    pub fn query_text(&self) -> String {
        self.query.join(" ")
    }
}

/// 検索語の上限（サーバーは 200 文字を超えると `query_too_long`）。
pub const SEARCH_QUERY_MAX: usize = 200;

fn nonempty_query(value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        Err("検索語は空にできません".to_owned())
    } else {
        Ok(value.to_owned())
    }
}

fn dev_user(value: &str) -> Result<String, String> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        Err("開発用ユーザーには空文字や制御文字を使えません".to_owned())
    } else {
        Ok(value.to_owned())
    }
}

fn nonempty(value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        Err("メッセージ ID は空にできません".to_owned())
    } else {
        Ok(value.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;

    #[test]
    fn reads_global_options_before_and_after_command() {
        let before =
            Cli::try_parse_from(["disnans", "--server", "100.1.2.3:8080", "me", "--json"]).unwrap();
        assert_eq!(before.server.as_deref(), Some("100.1.2.3:8080"));
        assert!(matches!(
            before.command,
            Command::Me(JsonOption { json: true })
        ));

        let after = Cli::try_parse_from([
            "disnans",
            "messages",
            "--limit",
            "200",
            "--dev-user",
            "alice",
        ])
        .unwrap();
        assert_eq!(after.dev_user.as_deref(), Some("alice"));
        assert!(matches!(
            after.command,
            Command::Messages(MessagesArgs { limit: 200, .. })
        ));
    }

    #[test]
    fn rejects_out_of_range_and_empty_before() {
        for args in [
            vec!["disnans", "messages", "--limit", "0"],
            vec!["disnans", "messages", "--limit", "201"],
            vec!["disnans", "messages", "--before", ""],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
    }

    #[test]
    fn rejects_empty_and_control_character_dev_users() {
        for user in ["", "  ", "alice\r\nbob", "a\u{1b}[2J"] {
            assert!(Cli::try_parse_from(["disnans", "--dev-user", user, "me"]).is_err());
        }
    }

    #[test]
    fn advertises_only_implemented_commands() {
        assert!(matches!(
            Cli::try_parse_from(["disnans", "tui"]).unwrap().command,
            Command::Tui
        ));
        let error = Cli::try_parse_from(["disnans", "threads"]).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidSubcommand);
    }

    #[test]
    fn send_requires_exactly_one_body_source() {
        assert!(Cli::try_parse_from(["disnans", "send"]).is_err());
        assert!(Cli::try_parse_from(["disnans", "send", "本文", "--stdin"]).is_err());
        let inline =
            Cli::try_parse_from(["disnans", "send", "本文", "--silent", "--json"]).unwrap();
        assert!(matches!(
            inline.command,
            Command::Send(SendArgs { text: Some(ref t), stdin: false, silent: true, json: true, .. }) if t == "本文"
        ));
        let stdin = Cli::try_parse_from(["disnans", "send", "--stdin"]).unwrap();
        assert!(matches!(
            stdin.command,
            Command::Send(SendArgs {
                text: None,
                stdin: true,
                ..
            })
        ));
    }

    #[test]
    fn react_unreact_and_reply_to_parse_and_reject_bad_emoji() {
        let react = Cli::try_parse_from(["disnans", "react", "m1", "👍", "--json"]).unwrap();
        assert!(matches!(
            react.command,
            Command::React(ReactArgs { ref message_id, ref emoji, json: true }) if message_id == "m1" && emoji == "👍"
        ));
        assert!(matches!(
            Cli::try_parse_from(["disnans", "unreact", "m1", "🔥"])
                .unwrap()
                .command,
            Command::Unreact(_)
        ));
        assert!(Cli::try_parse_from(["disnans", "react", "m1", ""]).is_err());
        assert!(Cli::try_parse_from(["disnans", "react", "m1"]).is_err());
        let send = Cli::try_parse_from(["disnans", "send", "--reply-to", "m9", "返信"]).unwrap();
        assert!(matches!(
            send.command,
            Command::Send(SendArgs { reply_to: Some(ref r), .. }) if r == "m9"
        ));
    }

    #[test]
    fn watch_accepts_json_flag_and_no_thread_options() {
        let watch = Cli::try_parse_from(["disnans", "watch", "--json"]).unwrap();
        assert!(matches!(
            watch.command,
            Command::Watch(JsonOption { json: true })
        ));
        assert!(Cli::try_parse_from(["disnans", "watch", "--thread", "x"]).is_err());
        assert!(Cli::try_parse_from(["disnans", "send", "--thread", "x", "a"]).is_err());
    }

    #[test]
    fn help_and_version_are_successful() {
        for flag in ["--help", "--version"] {
            let error = Cli::try_parse_from(["disnans", flag]).unwrap_err();
            assert_eq!(
                error.kind(),
                if flag == "--help" {
                    ErrorKind::DisplayHelp
                } else {
                    ErrorKind::DisplayVersion
                }
            );
        }
    }
}
