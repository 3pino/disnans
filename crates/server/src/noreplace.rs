//! 上書きしない名前の変更（同じ名前があれば失敗する rename）。
//!
//! 「先に存在を確かめてから rename」では、確かめたあとに現れた同名を上書きしてしまう（WebDAV など
//! 別の経路の書き込みと競合する）。そのため、OS の機能で確かめと変更を一度に行う:
//! - Linux: `renameat2(RENAME_NOREPLACE)`（rustix）
//! - Windows: `MoveFileW`（置き換えのフラグを付けない。同じ名前があれば失敗する）
//!
//! それ以外の OS、または対応していないファイルシステムでは `ErrorKind::Unsupported` を返す（上書きには落とさない）。
//!
//! 同名のときは `ErrorKind::AlreadyExists`。

use std::io;
use std::path::Path;

/// `from` を `to` へ名前変更する。`to` が既にあれば何もせず `AlreadyExists`。
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    imp::rename_no_replace(from, to)
}

#[cfg(target_os = "linux")]
mod imp {
    use std::io;
    use std::path::Path;

    use rustix::fs::{CWD, RenameFlags, renameat_with};
    use rustix::io::Errno;

    pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
        renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE).map_err(|e| match e {
            // このファイルシステムは RENAME_NOREPLACE に対応していない
            Errno::INVAL | Errno::NOSYS | Errno::OPNOTSUPP => {
                io::Error::from(io::ErrorKind::Unsupported)
            }
            other => io::Error::from_raw_os_error(other.raw_os_error()),
        })
    }
}

#[cfg(windows)]
mod imp {
    use std::io;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Storage::FileSystem::MoveFileW;

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(once(0)).collect()
    }

    pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
        let (a, b) = (wide(from), wide(to));
        // 置き換えのフラグ（MOVEFILE_REPLACE_EXISTING）を付けないので、同名があれば失敗する
        // SAFETY: どちらも NUL で終わる UTF-16 の文字列で、呼び出しの間は生きている
        let ok = unsafe { MoveFileW(a.as_ptr(), b.as_ptr()) };
        if ok != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod imp {
    use std::io;
    use std::path::Path;

    pub fn rename_no_replace(_from: &Path, _to: &Path) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_to_replace_and_keeps_both() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        std::fs::write(&a, b"from").unwrap();
        std::fs::write(&b, b"to").unwrap();
        let err = rename_no_replace(&a, &b).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&a).unwrap(), b"from");
        assert_eq!(std::fs::read(&b).unwrap(), b"to");
    }

    #[test]
    fn moves_a_folder_when_the_name_is_free() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        std::fs::create_dir(&a).unwrap();
        std::fs::write(a.join("x"), b"x").unwrap();
        let b = dir.path().join("b");
        rename_no_replace(&a, &b).unwrap();
        assert_eq!(std::fs::read(b.join("x")).unwrap(), b"x");
        assert!(!a.exists());
    }

    #[test]
    fn refuses_an_existing_folder_even_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let err = rename_no_replace(&a, &b).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert!(a.exists() && b.exists());
    }
}
