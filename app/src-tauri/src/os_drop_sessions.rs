//! ドロップの覚え書き（std のみ。Tauri に依存しない）。上限つき。
//!
//! 覚えたばかりのドロップは「未取得（unclaimed）」。JS が列挙か読取を始めると「取得済み（claimed）」になり、
//! 解放（`remove`）されるまで消えない。上限に達したときは、未取得のものだけを古い順に 1 つ外す。
//! 未取得のものも無く、全部が取得済みなら `Full`（新しい分は拒む。既存のものは置き換えない）。
//! 時間では消さない（大きなファイルの読取の途中で権限が消えないように）。

use std::collections::BTreeMap;

#[derive(Debug, PartialEq, Eq)]
pub struct Full;

struct Slot<T> {
    value: T,
    claimed: bool,
}

pub struct Sessions<T> {
    max: usize,
    map: BTreeMap<u64, Slot<T>>,
}

impl<T: Clone> Sessions<T> {
    pub fn new(max: usize) -> Self {
        Sessions {
            max,
            map: BTreeMap::new(),
        }
    }

    /// 覚える（未取得として）。上限なら、未取得の最も古い（ID の小さい）ものを 1 つ外す。取得済みしか無ければ Full
    pub fn insert(&mut self, id: u64, value: T) -> Result<(), Full> {
        if self.map.len() >= self.max {
            let victim = self
                .map
                .iter()
                .filter(|(_, s)| !s.claimed)
                .map(|(id, _)| *id)
                .min();
            match victim {
                Some(v) => {
                    self.map.remove(&v);
                }
                None => return Err(Full),
            }
        }
        self.map.insert(
            id,
            Slot {
                value,
                claimed: false,
            },
        );
        Ok(())
    }

    /// 取得する（列挙・読取の最初に呼ぶ）。以後は解放まで消えない。値を返す（無ければ None）
    pub fn claim(&mut self, id: u64) -> Option<T> {
        let slot = self.map.get_mut(&id)?;
        slot.claimed = true;
        Some(slot.value.clone())
    }

    /// 解放（無い ID でも何もしない。二度でも害は無い）
    pub fn remove(&mut self, id: u64) {
        self.map.remove(&id);
    }

    /// 試験用（本体は件数を見ない）
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_session_is_stored_and_claimed_on_first_use() {
        let mut s = Sessions::new(2);
        s.insert(1, "a").unwrap();
        assert_eq!(s.claim(1), Some("a"));
        assert_eq!(s.claim(2), None);
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn a_full_table_of_claimed_sessions_refuses_and_replaces_nothing() {
        let mut s = Sessions::new(2);
        s.insert(1, "a").unwrap();
        s.insert(2, "b").unwrap();
        s.claim(1);
        s.claim(2);
        assert_eq!(s.insert(3, "c"), Err(Full));
        assert_eq!(s.claim(1), Some("a"));
        assert_eq!(s.claim(2), Some("b"));
        assert_eq!(s.claim(3), None);
    }

    #[test]
    fn repeated_unclaimed_drops_never_fill_the_table() {
        // チャットのドロップは取得されない（旧経路）。何度続けても上限で詰まらない
        let mut s = Sessions::new(4);
        for id in 1..=200 {
            s.insert(id, "chat").unwrap();
            assert!(s.len() <= 4);
        }
        assert_eq!(s.len(), 4);
        // 残っているのは新しい方（古い未取得から譲った）
        assert_eq!(s.claim(197), Some("chat"));
        assert_eq!(s.claim(196), None);
    }

    #[test]
    fn a_claimed_session_survives_any_number_of_unclaimed_drops() {
        // 取得済みは時間では消えない（時間の仕組みを持たない）。取得の後に何度ドロップしても残る
        let mut s = Sessions::new(4);
        s.insert(1, "explorer").unwrap();
        s.claim(1);
        for id in 2..=500 {
            s.insert(id, "chat").unwrap();
        }
        assert_eq!(s.claim(1), Some("explorer"));
        assert_eq!(s.len(), 4);
    }

    #[test]
    fn the_oldest_unclaimed_is_the_one_that_gives_way() {
        let mut s = Sessions::new(3);
        s.insert(1, "a").unwrap();
        s.insert(2, "b").unwrap();
        s.insert(3, "c").unwrap();
        s.claim(1);
        s.insert(4, "d").unwrap();
        // 1 は取得済みなので残る。未取得の 2 が譲る
        assert_eq!(s.claim(1), Some("a"));
        assert_eq!(s.claim(2), None);
        assert_eq!(s.claim(3), Some("c"));
        assert_eq!(s.claim(4), Some("d"));
    }

    #[test]
    fn release_frees_a_claimed_slot_and_twice_is_harmless() {
        let mut s = Sessions::new(1);
        s.insert(1, "a").unwrap();
        s.claim(1);
        assert_eq!(s.insert(2, "b"), Err(Full));
        s.remove(1);
        s.remove(1);
        assert!(s.is_empty());
        s.insert(2, "b").unwrap();
        assert_eq!(s.claim(2), Some("b"));
    }
}
