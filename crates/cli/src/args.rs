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
        for unavailable in ["send", "watch", "tui", "threads"] {
            let error = Cli::try_parse_from(["disnans", unavailable]).unwrap_err();
            assert_eq!(error.kind(), ErrorKind::InvalidSubcommand);
        }
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
