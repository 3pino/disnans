//! 人向け表示の時刻。ローカルのタイムゾーンで出し、取得できなければ UTC にする。

use std::sync::OnceLock;

use jiff::Timestamp;
use jiff::tz::TimeZone;

/// 利用者のタイムゾーン。取得できないときは `None`（UTC で表示し、そう分かるようにする）。
pub fn system_zone() -> Option<TimeZone> {
    static ZONE: OnceLock<Option<TimeZone>> = OnceLock::new();
    ZONE.get_or_init(|| TimeZone::try_system().ok()).clone()
}

/// ミリ秒の UNIX 時刻を `strftime` 形式で整形する。範囲外は元の数値を返す。
pub fn format_in(timestamp_ms: i64, zone: &TimeZone, pattern: &str) -> String {
    match Timestamp::from_millisecond(timestamp_ms) {
        Ok(ts) => ts.to_zoned(zone.clone()).strftime(pattern).to_string(),
        Err(_) => timestamp_ms.to_string(),
    }
}

/// CLI の人向け表示: `2026-10-13 12:34:56`。ゾーン不明のときは UTC で `Z` を付ける。
pub fn format_full(timestamp_ms: i64) -> String {
    match system_zone() {
        Some(zone) => format_in(timestamp_ms, &zone, "%Y-%m-%d %H:%M:%S"),
        None => format_in(timestamp_ms, &TimeZone::UTC, "%Y-%m-%d %H:%M:%SZ"),
    }
}

/// 日付の区切り用。同じ日なら同じ `key`、`label` は `10月12日 (月)`。ゾーン不明は UTC。
pub fn day_label(timestamp_ms: i64, zone: Option<&TimeZone>) -> (i64, String) {
    let utc = TimeZone::UTC;
    let zone = zone.unwrap_or(&utc);
    let Ok(ts) = Timestamp::from_millisecond(timestamp_ms) else {
        return (i64::MIN, timestamp_ms.to_string());
    };
    let z = ts.to_zoned(zone.clone());
    let weekday = ["月", "火", "水", "木", "金", "土", "日"]
        [usize::from(z.weekday().to_monday_zero_offset() as u8)];
    let key = i64::from(z.year()) * 10_000 + i64::from(z.month()) * 100 + i64::from(z.day());
    (key, format!("{}月{}日 ({weekday})", z.month(), z.day()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_in_the_given_zone() {
        let tokyo = TimeZone::get("Asia/Tokyo").unwrap();
        assert_eq!(
            format_in(1_800_000_000_000, &tokyo, "%Y-%m-%d %H:%M:%S"),
            "2027-01-15 17:00:00"
        );
        assert_eq!(
            format_in(1_800_000_000_000, &TimeZone::UTC, "%m-%d %H:%M"),
            "01-15 08:00"
        );
        assert_eq!(
            format_in(i64::MAX, &TimeZone::UTC, "%Y"),
            i64::MAX.to_string()
        );
    }
}
