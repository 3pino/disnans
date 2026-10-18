//! 日付（ローカルの年月日）。タイムゾーンは呼び出し側（UI）が決める。core は時計を持たない。

use serde::{Deserialize, Serialize};

/// 暦の日。`weekday` は 0 = 日曜 … 6 = 土曜。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub weekday: u8,
}

impl Day {
    /// 区切りの識別子（`YYYY-MM-DD`）。同じ日なら同じ文字列になる
    pub fn key(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

/// 時刻（Unix ミリ秒）を、利用者の暦の日に変える。タイムゾーンは実装が持つ（UTC・端末の設定など）
pub trait Calendar {
    fn day_of(&self, timestamp_ms: i64) -> Day;
}

/// UTC の暦。テストと、タイムゾーンを持たない環境の既定に使う
#[derive(Debug, Clone, Copy, Default)]
pub struct UtcCalendar;

impl Calendar for UtcCalendar {
    fn day_of(&self, timestamp_ms: i64) -> Day {
        day_from_epoch_days(timestamp_ms.div_euclid(86_400_000))
    }
}

/// 1970-01-01（木曜）からの日数を暦の日にする（Howard Hinnant の civil_from_days）
fn day_from_epoch_days(days: i64) -> Day {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = yoe + era * 400 + i64::from(m <= 2);
    Day {
        year: y as i32,
        month: m as u8,
        day: d as u8,
        weekday: (days + 4).rem_euclid(7) as u8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_is_a_thursday() {
        let d = UtcCalendar.day_of(0);
        assert_eq!((d.year, d.month, d.day, d.weekday), (1970, 1, 1, 4));
        assert_eq!(d.key(), "1970-01-01");
    }

    #[test]
    fn leap_day_and_the_day_after() {
        // 2000-02-29 は火曜、2000-03-01 は水曜（閏年）
        let feb29 = UtcCalendar.day_of(951_782_400_000);
        assert_eq!(
            (feb29.year, feb29.month, feb29.day, feb29.weekday),
            (2000, 2, 29, 2)
        );
        let mar1 = UtcCalendar.day_of(951_868_800_000);
        assert_eq!(
            (mar1.year, mar1.month, mar1.day, mar1.weekday),
            (2000, 3, 1, 3)
        );
    }

    #[test]
    fn times_before_the_epoch_use_the_previous_day() {
        let d = UtcCalendar.day_of(-1);
        assert_eq!((d.year, d.month, d.day), (1969, 12, 31));
    }

    #[test]
    fn same_day_has_the_same_key_and_the_day_boundary_is_utc_midnight() {
        let a = UtcCalendar.day_of(86_400_000 * 20_000 + 1);
        let b = UtcCalendar.day_of(86_400_000 * 20_000 + 86_399_999);
        let c = UtcCalendar.day_of(86_400_000 * 20_001);
        assert_eq!(a.key(), b.key());
        assert_ne!(a.key(), c.key());
    }
}
