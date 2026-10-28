//! 内蔵のバックアップ（DB・共有フォルダ・添付の実体）。
//!
//! 置き場所は `<データ>/backup/`。1 回のバックアップは同じ時刻（`YYYYMMDD-HHMMSS-mmm`、UTC）の組:
//! - `disnans-<時刻>.db`（DB を VACUUM INTO で複製）
//! - `shared-<時刻>/`（共有フォルダ）、`files-<時刻>/`（添付の実体）、`avatars-<時刻>/`、`plugins-<時刻>/`、`trash-<時刻>/`（ゴミ箱の項目。DB の行と組で戻せる）。どれも**ハードリンク**で作る
//!
//! ハードリンクなので、中身はコピーされず、同じ実体を指す。ファイルの中身は書き換えない
//! （書き込みは必ず一時ファイルを rename する）ので、上書きや削除をしてもバックアップの中身は古いまま残る。
//! 組は [`KEEP`] 世代まで残し、古いものは消す。
//!
//! 実行: 自動更新で入れ替える直前、と、前回から [`INTERVAL`] たったとき（起動の数分後から、10 分ごとに確認）。
//! `DISNANS_BACKUP=0` で両方とも止める。

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::state::SharedState;
use crate::webdav::names::is_internal;

/// 残す世代の数。
pub const KEEP: usize = 20;
/// 組に入るフォルダの種類（データ `data/` の下の場所と同じ名前）。
const FOLDER_KINDS: [&str; 5] = ["shared", "files", "avatars", "plugins", "trash"];
/// 定期のバックアップの間隔。
pub const INTERVAL: Duration = Duration::from_secs(24 * 3600);
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(120);
const CHECK_EVERY: Duration = Duration::from_secs(600);

/// `DISNANS_BACKUP=0` のとき以外は有効。
pub fn enabled() -> bool {
    std::env::var("DISNANS_BACKUP")
        .map(|v| v != "0")
        .unwrap_or(true)
}

/// 1 組のバックアップを作る。戻り値は時刻（組の名前）。
pub async fn run(state: &SharedState) -> Result<String, String> {
    let dir = state.config.backup_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("バックアップの場所を作れません: {e}"))?;
    // 同じ時刻の組があれば、一つ先の時刻にする（組の名前は一意にする）
    let mut ts = stamp(now_ms());
    while dir.join(format!("disnans-{ts}.db")).exists() {
        tokio::time::sleep(Duration::from_millis(1)).await;
        ts = stamp(now_ms());
    }

    // DB は一貫した複製（VACUUM INTO）。引数の ' は二つに直す
    let db = dir.join(format!("disnans-{ts}.db"));
    let literal = db.to_string_lossy().replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{literal}'"))
        .execute(&state.pool)
        .await
        .map_err(|e| format!("DB を複製できません: {e}"))?;

    // フォルダは、ハードリンクで組にする（中身は書き換えない作り方なので、リンクで十分）
    let sources = [
        state.config.shared_dir(),
        state.config.files_dir(),
        state.config.avatars_dir(),
        state.config.plugins_dir(),
        state.config.trash_dir(),
    ];
    let set_dir = dir.clone();
    let set_ts = ts.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        for (kind, src) in FOLDER_KINDS.iter().zip(sources.iter()) {
            snapshot_tree(src, &set_dir.join(format!("{kind}-{set_ts}")))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("バックアップが止まりました: {e}"))??;

    prune(&dir, KEEP).map_err(|e| format!("古いバックアップを消せません: {e}"))?;
    tracing::info!(backup = %ts, "バックアップを作りました（DB・共有フォルダ・添付・アバター・プラグイン）");
    Ok(ts)
}

/// 定期のバックアップ。前回から [`INTERVAL`] たっていれば作る。
pub fn spawn_daily_task(state: SharedState) {
    tokio::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let due = match newest_db_time(&state.config.backup_dir()) {
                None => true,
                Some(t) => SystemTime::now()
                    .duration_since(t)
                    .map(|age| age >= INTERVAL)
                    .unwrap_or(false),
            };
            if due && let Err(e) = run(&state).await {
                tracing::warn!("定期のバックアップに失敗しました: {e}");
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// 最新の組（`disnans-*.db`）の作られた時刻。
fn newest_db_time(dir: &Path) -> Option<SystemTime> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| set_stamp(&e.file_name().to_string_lossy()).is_some())
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max()
}

/// `disnans-<時刻>.db` の時刻の部分。
fn set_stamp(file_name: &str) -> Option<&str> {
    let stamp = file_name.strip_prefix("disnans-")?.strip_suffix(".db")?;
    // YYYYMMDD-HHMMSS-mmm（19 文字。- は 8 と 15 の位置）
    let valid = stamp.len() == 19
        && stamp.bytes().enumerate().all(|(i, b)| {
            if i == 8 || i == 15 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    valid.then_some(stamp)
}

/// `dir` の組のうち、新しい `keep` 組を残して、残りの DB とフォルダを消す。
pub fn prune(dir: &Path, keep: usize) -> std::io::Result<()> {
    let mut stamps: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|e| set_stamp(&e.file_name().to_string_lossy()).map(str::to_owned))
        .collect();
    stamps.sort();
    stamps.dedup();
    // 時刻は桁のそろった文字列なので、文字列の順が時間の順
    let old = stamps.len().saturating_sub(keep);
    for ts in &stamps[..old] {
        std::fs::remove_file(dir.join(format!("disnans-{ts}.db")))?;
        for kind in FOLDER_KINDS {
            let folder = dir.join(format!("{kind}-{ts}"));
            if folder.exists() {
                std::fs::remove_dir_all(folder)?;
            }
        }
    }
    Ok(())
}

/// `src` の木を `dst` に、ファイルはハードリンクで写す（できなければコピー）。
/// 一時ファイル・シンボリックリンクは写さない。`src` がなければ空の `dst` だけ作る。
pub fn snapshot_tree(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("{} を作れません: {e}", dst.display()))?;
    let Ok(entries) = std::fs::read_dir(src) else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if is_internal(&name_text) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        } else if kind.is_dir() {
            snapshot_tree(&from, &to)?;
        } else if kind.is_file() {
            link_or_copy(&from, &to)?;
        }
    }
    Ok(())
}

fn link_or_copy(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::hard_link(from, to).is_ok() {
        return Ok(());
    }
    // 別の場所（ファイルシステムが違う等）ならコピーする
    std::fs::copy(from, to)
        .map(|_| ())
        .map_err(|e| format!("{} を写せません: {e}", from.display()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// UNIX 時間（ミリ秒）を `YYYYMMDD-HHMMSS-mmm`（UTC）にする。文字列の順が時間の順になる。
pub fn stamp(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let secs = rem / 1000;
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}-{:03}",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60,
        rem % 1000
    )
}

/// 1970-01-01 からの日数を（年、月、日）にする（Howard Hinnant の civil_from_days）。
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_are_utc_and_sort_by_time() {
        // 2024-01-01T00:00:00.000Z
        assert_eq!(stamp(1_704_067_200_000), "20240101-000000-000");
        assert_eq!(stamp(1_704_067_200_123), "20240101-000000-123");
        // 2024 はうるう年
        assert_eq!(stamp(1_709_164_800_000), "20240229-000000-000");
        assert!(stamp(1_704_067_200_000) < stamp(1_704_067_200_001));
        assert!(stamp(1_704_067_199_999) < stamp(1_704_067_200_000));
    }

    #[test]
    fn set_stamps_are_recognised_by_name() {
        assert_eq!(
            set_stamp("disnans-20240101-000000-000.db"),
            Some("20240101-000000-000")
        );
        assert_eq!(set_stamp("pre-migrate-1700000000000.db"), None);
        assert_eq!(set_stamp("disnans-xxxx.db"), None);
        assert_eq!(set_stamp("disnans-20240101-000000-000.db.tmp"), None);
    }

    fn touch(p: &Path) {
        std::fs::write(p, b"x").unwrap();
    }

    #[test]
    fn prune_keeps_the_newest_sets_and_their_folders() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        // 22 組（新しい順の判定は名前の時刻）
        for i in 0..22 {
            let ts = stamp(1_704_067_200_000 + i * 1000);
            touch(&base.join(format!("disnans-{ts}.db")));
            std::fs::create_dir_all(base.join(format!("shared-{ts}"))).unwrap();
            std::fs::create_dir_all(base.join(format!("files-{ts}"))).unwrap();
        }
        // 組でない物は消さない
        touch(&base.join("pre-migrate-1.db"));
        prune(base, KEEP).unwrap();

        let oldest = stamp(1_704_067_200_000 + 1000);
        let newest_kept = stamp(1_704_067_200_000 + 2000);
        assert!(!base.join(format!("disnans-{oldest}.db")).exists());
        assert!(!base.join(format!("shared-{oldest}")).exists());
        assert!(base.join(format!("disnans-{newest_kept}.db")).exists());
        assert!(base.join(format!("shared-{newest_kept}")).exists());
        let kept = std::fs::read_dir(base)
            .unwrap()
            .filter(|e| set_stamp(&e.as_ref().unwrap().file_name().to_string_lossy()).is_some())
            .count();
        assert_eq!(kept, KEEP);
        assert!(base.join("pre-migrate-1.db").exists());
    }

    #[test]
    fn snapshot_links_files_and_skips_temporary_ones() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("shared");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), b"old").unwrap();
        std::fs::write(src.join("sub/b.txt"), b"b").unwrap();
        std::fs::write(src.join(".disnans-tmp-1"), b"partial").unwrap();
        let dst = dir.path().join("snap");
        snapshot_tree(&src, &dst).unwrap();

        assert!(!dst.join(".disnans-tmp-1").exists());
        assert_eq!(std::fs::read(dst.join("sub/b.txt")).unwrap(), b"b");
        // 同じ実体（ハードリンク）
        use std::os::unix::fs::MetadataExt;
        let live = std::fs::metadata(src.join("a.txt")).unwrap();
        let snap = std::fs::metadata(dst.join("a.txt")).unwrap();
        assert_eq!(live.ino(), snap.ino());

        // 上書きは一時ファイルを rename するので、バックアップの中身は古いまま
        let tmp = src.join(".disnans-tmp-2");
        std::fs::write(&tmp, b"new").unwrap();
        std::fs::rename(&tmp, src.join("a.txt")).unwrap();
        assert_eq!(std::fs::read(src.join("a.txt")).unwrap(), b"new");
        assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"old");
    }

    #[test]
    fn snapshot_of_a_missing_source_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let dst = dir.path().join("snap");
        snapshot_tree(&dir.path().join("nope"), &dst).unwrap();
        assert!(dst.is_dir());
    }
}
