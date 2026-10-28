//! OS からドロップされたファイル・フォルダの列挙と読取（Tauri に依存しない）。
//!
//! 許可の範囲は「ドロップされた根（root）の中だけ」。根は、ドロップのイベントで受けたパスから作る（JS が任意のパスを渡すことはない）。
//! シンボリックリンクは辿らない（列挙から外し、読取は拒む）。読むのは通常のファイルだけ。
//! 列挙のたびに、根と各フォルダが今も根の中にあり、リンクに置き換わっていないかを確かめる（ドロップの後に変わりうるため）。
//! 読取は、開いた実物（ハンドル）の場所を /proc で確かめてから、同じハンドルを読む（開き直さない）。Linux のみ。

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// 列挙する項目の上限（読んだ項目の数。フォルダの中身を全部集める前に止める）。
pub const MAX_ENTRIES: usize = 50_000;
/// フォルダの深さの上限。
pub const MAX_DEPTH: usize = 32;
/// 1 回のドロップで受ける根の数の上限（列挙の上限より小さいこと。下で確かめる）。
pub const MAX_ROOTS: usize = 512;
const _: () = assert!(MAX_ROOTS <= MAX_ENTRIES);
/// 1 つのファイルを読む上限（バイト）。超えるものは読まない（メモリに全部載せないため）。
pub const MAX_READ_BYTES: u64 = 512 * 1024 * 1024;

/// ドロップされた根。`name` は表示と送信先に使う名前（同名は「 (2)」などで区別する）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    pub name: String,
    /// 正規化したパス（シンボリックリンクを解決したもの）
    pub path: PathBuf,
    pub dir: bool,
}

/// 列挙された 1 つの項目。`rel` は根の名前から始まる（`docs/a.txt`。区切りは `/`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub rel: String,
    pub dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub entries: Vec<Entry>,
    /// 外したもの（シンボリックリンク・読めなかったもの・通常でない種類・名前の決まりに合わないもの）の名前
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalkError {
    TooManyRoots,
    TooManyEntries,
    TooDeep,
    /// ドロップの後に、根やフォルダがリンクに置き換わった・根の外へ出た（列挙をやめる）
    Changed,
    Io(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// 名前の決まりに合わない・根の名前にない・根の外へ出る・この環境では読めない
    Denied(String),
    NotFound,
    NotAFile,
    TooLarge,
    Io(String),
}

/// 1 つの名前（区切りの間の部分）が決まりに合うか。
/// 空・`.`・`..`・`/` `\` `:` NUL を含むものは拒む（Windows の区切りやドライブの指定として働かないように）。
/// Normal な 1 要素だけであることも確かめる。
pub fn valid_segment(s: &str) -> bool {
    if s.is_empty() || s == "." || s == ".." {
        return false;
    }
    if s.chars().any(|c| matches!(c, '/' | '\\' | ':' | '\0')) {
        return false;
    }
    let mut parts = Path::new(s).components();
    matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(_)), None)
    )
}

/// 根の表示名: 決まりに合わない文字は `_` に置き換える（根の名前は rel の先頭になるため）
fn sanitize_name(base: &str) -> String {
    let s: String = base
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '\0') {
                '_'
            } else {
                c
            }
        })
        .collect();
    if s.is_empty() || s == "." || s == ".." {
        "file".into()
    } else {
        s
    }
}

fn raw_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into())
}

/// ドロップされたパスを根にする。見られないもの・シンボリックリンク・通常でないものは skipped に入れる。
/// 同名は「 (2)」「 (3)」…で区別する（送信先の名前がぶつからないように）。
pub fn prepare_roots(paths: &[PathBuf]) -> Result<(Vec<Root>, Vec<String>), WalkError> {
    if paths.len() > MAX_ROOTS {
        return Err(WalkError::TooManyRoots);
    }
    let mut roots: Vec<Root> = Vec::new();
    // 使われた名前（同名の探索を O(1) にする）
    let mut used: HashSet<String> = HashSet::new();
    let mut skipped = Vec::new();
    for p in paths {
        let base = raw_name(p);
        let meta = match fs::symlink_metadata(p) {
            Ok(m) if !m.file_type().is_symlink() => m,
            _ => {
                skipped.push(base);
                continue;
            }
        };
        let path = match fs::canonicalize(p) {
            Ok(c) => c,
            Err(_) => {
                skipped.push(base);
                continue;
            }
        };
        let dir = meta.is_dir();
        if !dir && !meta.is_file() {
            skipped.push(base);
            continue;
        }
        let name = unique_name(&used, &sanitize_name(&base), dir);
        used.insert(name.clone());
        roots.push(Root { name, path, dir });
    }
    Ok((roots, skipped))
}

/// 同名のときの名前。ファイルは拡張子の前に「 (n)」（photo.jpg → photo (2).jpg）、フォルダは後ろに（docs → docs (2)）。
/// 先頭だけの点（.rc）や末尾の点（trailing.）は拡張子とみなさない。
fn with_suffix(base: &str, n: usize, dir: bool) -> String {
    if !dir {
        if let Some(dot) = base.rfind('.') {
            if dot > 0 && dot + 1 < base.len() {
                return format!("{} ({n}).{}", &base[..dot], &base[dot + 1..]);
            }
        }
    }
    format!("{base} ({n})")
}

fn unique_name(used: &HashSet<String>, base: &str, dir: bool) -> String {
    if !used.contains(base) {
        return base.to_owned();
    }
    let mut n = 2;
    loop {
        let candidate = with_suffix(base, n, dir);
        if !used.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// 根が今も同じもの（通常の場所・同じ種類・リンクでない）か。ドロップの後に差し替えられていれば Changed
fn verify_root(root: &Root) -> Result<(), WalkError> {
    let meta = fs::symlink_metadata(&root.path).map_err(|_| WalkError::Changed)?;
    if meta.file_type().is_symlink() || meta.is_dir() != root.dir {
        return Err(WalkError::Changed);
    }
    let canon = fs::canonicalize(&root.path).map_err(|_| WalkError::Changed)?;
    if canon != root.path {
        return Err(WalkError::Changed);
    }
    Ok(())
}

/// 根の中の全項目を列挙する（上限つき）。各フォルダの中は名前順。
pub fn list(roots: &[Root]) -> Result<Listing, WalkError> {
    list_with_limits(roots, MAX_ENTRIES, MAX_DEPTH)
}

/// 列挙の途中の状態。上限は「読んだ項目の数」で数える（集める前に止める）。
struct Walk {
    out: Listing,
    visited: usize,
    max_entries: usize,
    max_depth: usize,
}

impl Walk {
    fn visit(&mut self) -> Result<(), WalkError> {
        self.visited += 1;
        if self.visited > self.max_entries {
            Err(WalkError::TooManyEntries)
        } else {
            Ok(())
        }
    }
}

pub fn list_with_limits(
    roots: &[Root],
    max_entries: usize,
    max_depth: usize,
) -> Result<Listing, WalkError> {
    let mut w = Walk {
        out: Listing {
            entries: Vec::new(),
            skipped: Vec::new(),
        },
        visited: 0,
        max_entries,
        max_depth,
    };
    for root in roots {
        verify_root(root)?;
        w.visit()?;
        if !valid_segment(&root.name) {
            w.out.skipped.push(root.name.clone());
            continue;
        }
        if root.dir {
            w.out.entries.push(Entry {
                rel: root.name.clone(),
                dir: true,
                size: 0,
            });
            walk_dir(&root.path, &root.path, &root.name, 1, &mut w)?;
        } else {
            let size = fs::metadata(&root.path)
                .map_err(|e| WalkError::Io(e.to_string()))?
                .len();
            w.out.entries.push(Entry {
                rel: root.name.clone(),
                dir: false,
                size,
            });
        }
    }
    Ok(w.out)
}

fn walk_dir(
    dir: &Path,
    root: &Path,
    rel: &str,
    depth: usize,
    w: &mut Walk,
) -> Result<(), WalkError> {
    if depth > w.max_depth {
        return Err(WalkError::TooDeep);
    }
    // このフォルダが今も根の中の普通のフォルダか（列挙の直前に確かめる）
    let meta = fs::symlink_metadata(dir).map_err(|_| WalkError::Changed)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(WalkError::Changed);
    }
    let canon = fs::canonicalize(dir).map_err(|_| WalkError::Changed)?;
    if !canon.starts_with(root) {
        return Err(WalkError::Changed);
    }

    // 項目は 1 つずつ数えてから集める（上限を超えたら、それ以上は集めない）
    let mut children: Vec<(String, fs::FileType, PathBuf)> = Vec::new();
    for item in fs::read_dir(dir).map_err(|e| WalkError::Io(e.to_string()))? {
        let item = item.map_err(|e| WalkError::Io(e.to_string()))?;
        w.visit()?;
        match item.file_name().into_string() {
            Ok(name) => {
                // DirEntry::file_type はリンクを辿らない（シンボリックリンクはここで分かる）
                let ft = item.file_type().map_err(|e| WalkError::Io(e.to_string()))?;
                children.push((name, ft, item.path()));
            }
            Err(os) => w
                .out
                .skipped
                .push(format!("{rel}/{}", os.to_string_lossy())),
        }
    }
    children.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, ft, path) in children {
        let child_rel = format!("{rel}/{name}");
        if !valid_segment(&name) || ft.is_symlink() {
            w.out.skipped.push(child_rel);
        } else if ft.is_dir() {
            w.out.entries.push(Entry {
                rel: child_rel.clone(),
                dir: true,
                size: 0,
            });
            walk_dir(&path, root, &child_rel, depth + 1, w)?;
        } else if ft.is_file() {
            // 読んだ後に差し替わったものは、通常のファイルの時だけ数える
            let m = fs::symlink_metadata(&path).map_err(|e| WalkError::Io(e.to_string()))?;
            if m.is_file() {
                w.out.entries.push(Entry {
                    rel: child_rel,
                    dir: false,
                    size: m.len(),
                });
            } else {
                w.out.skipped.push(child_rel);
            }
        } else {
            w.out.skipped.push(child_rel);
        }
    }
    Ok(())
}

/// rel の先頭（根の名前）から根を探す。rel の形は確かめてから
fn root_for<'a>(roots: &'a [Root], rel: &str) -> Result<&'a Root, ReadError> {
    let first = rel.split('/').next().unwrap_or("");
    roots
        .iter()
        .find(|r| r.name == first)
        .ok_or_else(|| ReadError::Denied("ドロップされたものではありません".into()))
}

/// rel（根の名前から始まる、`/` の区切り）を、根の中の実在する通常のファイルのパスにする。
/// 区切りごとに決まりを確かめる（`..`・空・Windows の区切りやドライブ・途中のシンボリックリンク・根の外は拒む）。
/// これは前もっての確認。最後の確認は、開いたハンドルで行う（`read_file_limited`）。
pub fn resolve(roots: &[Root], rel: &str) -> Result<PathBuf, ReadError> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| !valid_segment(p)) {
        return Err(ReadError::Denied("パスの形が不正です".into()));
    }
    let root = root_for(roots, rel)?;
    verify_root(root).map_err(|_| ReadError::Denied("ドロップの後に変わりました".into()))?;
    let mut cur = root.path.clone();
    for part in &parts[1..] {
        cur = cur.join(part);
        let meta = fs::symlink_metadata(&cur).map_err(|_| ReadError::NotFound)?;
        if meta.file_type().is_symlink() {
            return Err(ReadError::Denied("シンボリックリンクは読みません".into()));
        }
    }
    let meta = fs::symlink_metadata(&cur).map_err(|_| ReadError::NotFound)?;
    if meta.file_type().is_symlink() {
        return Err(ReadError::Denied("シンボリックリンクは読みません".into()));
    }
    if !meta.is_file() {
        return Err(ReadError::NotAFile);
    }
    let canon = fs::canonicalize(&cur).map_err(|e| ReadError::Io(e.to_string()))?;
    if !inside(&canon, root) {
        return Err(ReadError::Denied("ドロップされた範囲の外です".into()));
    }
    Ok(canon)
}

/// 実際の場所 `real` が根の中か（フォルダの根は中、ファイルの根は同じファイル）
fn inside(real: &Path, root: &Root) -> bool {
    if root.dir {
        real.starts_with(&root.path)
    } else {
        real == root.path
    }
}

/// 最後の確認つきで開く（Linux）。最後の要素はリンクを辿らず（O_NOFOLLOW）、
/// 開いたハンドルの実際の場所を /proc/self/fd で確かめる（祖先のリンクをたどった先も含む）。根の外なら、読まずに拒む。
/// 確かめるのと読むのは同じハンドル（開き直さない）。非ブロッキングなので、FIFO などで止まらない。
#[cfg(target_os = "linux")]
fn open_confined(path: &Path, root: &Root) -> Result<fs::File, ReadError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| match e.raw_os_error() {
            Some(libc::ELOOP) => ReadError::Denied("シンボリックリンクは読みません".into()),
            _ if e.kind() == std::io::ErrorKind::NotFound => ReadError::NotFound,
            _ => ReadError::Io(e.to_string()),
        })?;
    let real = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|e| ReadError::Io(e.to_string()))?;
    if !inside(&real, root) {
        return Err(ReadError::Denied("ドロップされた範囲の外です".into()));
    }
    let meta = file.metadata().map_err(|e| ReadError::Io(e.to_string()))?;
    if !meta.is_file() {
        return Err(ReadError::NotAFile);
    }
    Ok(file)
}

/// Linux 以外では、ネイティブのドロップの読取を行わない（ハンドルの確認の手段が無いため。安易に安全とは言わない）。
#[cfg(not(target_os = "linux"))]
fn open_confined(_path: &Path, _root: &Root) -> Result<fs::File, ReadError> {
    Err(ReadError::Denied(
        "この環境では、ネイティブのドロップの読取に対応していません".into(),
    ))
}

/// 根の中のファイルを読む（上限 MAX_READ_BYTES）。
pub fn read_file(roots: &[Root], rel: &str) -> Result<Vec<u8>, ReadError> {
    read_file_limited(roots, rel, MAX_READ_BYTES)
}

/// 根の中のファイルを読む（上限 limit バイト）。開いたハンドルで確かめ、同じハンドルを上限つきで読む
/// （読んでいる間に大きくなったファイルを無制限に読まない）。
pub fn read_file_limited(roots: &[Root], rel: &str, limit: u64) -> Result<Vec<u8>, ReadError> {
    let path = resolve(roots, rel)?;
    let root = root_for(roots, rel)?;
    let file = open_confined(&path, root)?;
    let meta = file.metadata().map_err(|e| ReadError::Io(e.to_string()))?;
    if meta.len() > limit {
        return Err(ReadError::TooLarge);
    }
    let mut buf = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut buf)
        .map_err(|e| ReadError::Io(e.to_string()))?;
    if buf.len() as u64 > limit {
        return Err(ReadError::TooLarge);
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 試験用の一時フォルダ（テストごとに別の名前。終わったら消す）
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let p = std::env::temp_dir()
                .join(format!("os-drop-walk-{tag}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(p: &Path, body: &str) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, body).unwrap();
    }

    /// フォルダ（空の子フォルダを含む）
    fn tree(s: &Scratch) -> PathBuf {
        let root = s.path().join("photos");
        write(&root.join("a.txt"), "abc");
        write(&root.join("sub/deeper/b.bin"), "0123456789");
        fs::create_dir_all(root.join("empty")).unwrap();
        root
    }

    fn roots_of_paths(paths: &[PathBuf]) -> Vec<Root> {
        prepare_roots(paths).unwrap().0
    }

    #[test]
    fn list_includes_all_levels_and_empty_dirs_sorted_with_sizes() {
        let s = Scratch::new("list");
        let root = tree(&s);
        let (roots, skipped) = prepare_roots(&[root]).unwrap();
        assert!(skipped.is_empty());
        let l = list(&roots).unwrap();
        let rels: Vec<(&str, bool, u64)> = l
            .entries
            .iter()
            .map(|e| (e.rel.as_str(), e.dir, e.size))
            .collect();
        assert_eq!(
            rels,
            vec![
                ("photos", true, 0),
                ("photos/a.txt", false, 3),
                ("photos/empty", true, 0),
                ("photos/sub", true, 0),
                ("photos/sub/deeper", true, 0),
                ("photos/sub/deeper/b.bin", false, 10),
            ]
        );
    }

    #[test]
    fn file_root_lists_one_entry() {
        let s = Scratch::new("file");
        let f = s.path().join("note.txt");
        write(&f, "hi");
        let roots = roots_of_paths(&[f]);
        let l = list(&roots).unwrap();
        assert_eq!(
            l.entries,
            vec![Entry {
                rel: "note.txt".into(),
                dir: false,
                size: 2
            }]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn duplicate_roots_get_distinct_names() {
        let s = Scratch::new("dup");
        let a = s.path().join("x/item");
        let b = s.path().join("y/item");
        write(&a, "1");
        write(&b, "22");
        let roots = roots_of_paths(&[a, b]);
        let names: Vec<&str> = roots.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["item", "item (2)"]);
        assert_eq!(read_file(&roots, "item (2)").unwrap(), b"22");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_only_regular_files_inside_roots() {
        let s = Scratch::new("read");
        let root = tree(&s);
        write(&s.path().join("secret.txt"), "no");
        let roots = roots_of_paths(&[root]);
        assert_eq!(
            read_file(&roots, "photos/sub/deeper/b.bin").unwrap(),
            b"0123456789"
        );
        assert_eq!(read_file(&roots, "photos/a.txt").unwrap(), b"abc");
        assert!(matches!(
            read_file(&roots, "other.txt"),
            Err(ReadError::Denied(_))
        ));
        assert_eq!(read_file(&roots, "photos/sub"), Err(ReadError::NotAFile));
        assert_eq!(
            read_file(&roots, "photos/none.txt"),
            Err(ReadError::NotFound)
        );
    }

    #[test]
    fn malformed_rel_is_denied() {
        let s = Scratch::new("bad");
        let root = tree(&s);
        let roots = roots_of_paths(&[root]);
        for bad in [
            "",
            "photos/../a",
            "photos//a.txt",
            "photos/./a.txt",
            "photos/a.txt/",
            "/photos/a.txt",
        ] {
            assert!(
                matches!(read_file(&roots, bad), Err(ReadError::Denied(_))),
                "拒むべき: {bad:?}"
            );
        }
    }

    #[test]
    fn windows_separators_and_drive_prefixes_are_denied() {
        let s = Scratch::new("winrel");
        let root = tree(&s);
        let roots = roots_of_paths(&[root]);
        for bad in [
            "photos\\a.txt",
            "photos/sub\\deeper",
            "C:/photos/a.txt",
            "photos/C:a.txt",
            "photos/..\\a.txt",
            "photos/a.txt:stream",
        ] {
            assert!(
                matches!(read_file(&roots, bad), Err(ReadError::Denied(_))),
                "拒むべき: {bad:?}"
            );
        }
        assert!(valid_segment("a b.txt"));
        assert!(!valid_segment("a:b"));
        assert!(!valid_segment("a\\b"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn root_names_with_colon_are_sanitized_and_children_with_colon_are_skipped() {
        let s = Scratch::new("colon");
        let f = s.path().join("Shot 10:00.png");
        write(&f, "png");
        let roots = roots_of_paths(std::slice::from_ref(&f));
        assert_eq!(roots[0].name, "Shot 10_00.png");
        assert_eq!(read_file(&roots, "Shot 10_00.png").unwrap(), b"png");

        let dir = s.path().join("pics");
        write(&dir.join("x:y.txt"), "1");
        write(&dir.join("ok.txt"), "2");
        let roots = roots_of_paths(&[dir]);
        let l = list(&roots).unwrap();
        assert!(l.entries.iter().any(|e| e.rel == "pics/ok.txt"));
        assert!(l.skipped.contains(&"pics/x:y.txt".to_string()));
    }

    #[test]
    fn suffixes_keep_the_extension_of_files_and_go_last_for_folders() {
        assert_eq!(with_suffix("photo.jpg", 2, false), "photo (2).jpg");
        assert_eq!(with_suffix("a.tar.gz", 3, false), "a.tar (3).gz");
        assert_eq!(with_suffix("docs", 2, true), "docs (2)");
        assert_eq!(with_suffix("my.folder", 2, true), "my.folder (2)");
        assert_eq!(with_suffix(".rc", 2, false), ".rc (2)");
        assert_eq!(with_suffix("trailing.", 2, false), "trailing. (2)");
    }

    #[test]
    fn a_suffixed_name_that_is_already_taken_is_skipped_over() {
        let s = Scratch::new("taken");
        let mut paths = Vec::new();
        for (i, name) in ["photo.jpg", "photo (2).jpg"].iter().enumerate() {
            let p = s.path().join(format!("d{i}")).join(name);
            write(&p, "x");
            paths.push(p);
        }
        let dup = s.path().join("d2").join("photo.jpg");
        write(&dup, "x");
        paths.push(dup);
        let (roots, _) = prepare_roots(&paths).unwrap();
        let names: Vec<&str> = roots.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["photo.jpg", "photo (2).jpg", "photo (3).jpg"]);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn native_reads_are_refused_outside_linux() {
        // 列挙は動く。読みは、開いたものの場所を /proc で確かめられない環境では行わない（安全と称さない）
        let s = Scratch::new("nonlinux");
        let f = s.path().join("note.txt");
        write(&f, "hi");
        let roots = roots_of_paths(&[f]);
        assert_eq!(list(&roots).unwrap().entries.len(), 1);
        assert!(matches!(
            read_file(&roots, "note.txt"),
            Err(ReadError::Denied(_))
        ));
    }

    #[test]
    fn many_roots_with_the_same_name_get_distinct_names() {
        let s = Scratch::new("manysame");
        let paths: Vec<PathBuf> = (0..200)
            .map(|i| {
                let p = s.path().join(format!("d{i}")).join("item");
                write(&p, "x");
                p
            })
            .collect();
        let (roots, _) = prepare_roots(&paths).unwrap();
        let names: HashSet<&str> = roots.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names.len(), 200);
        assert_eq!(roots[0].name, "item");
        assert_eq!(roots[199].name, "item (200)");
    }

    #[test]
    fn too_many_roots_is_refused() {
        let paths = vec![PathBuf::from("/nonexistent"); MAX_ROOTS + 1];
        assert_eq!(prepare_roots(&paths), Err(WalkError::TooManyRoots));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_are_bounded_by_the_limit() {
        let s = Scratch::new("bounded");
        let f = s.path().join("ten.bin");
        write(&f, "0123456789");
        let roots = roots_of_paths(&[f]);
        assert!(matches!(
            read_file_limited(&roots, "ten.bin", 5),
            Err(ReadError::TooLarge)
        ));
        assert_eq!(
            read_file_limited(&roots, "ten.bin", 10).unwrap(),
            b"0123456789"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped_and_not_read() {
        let s = Scratch::new("link");
        let root = tree(&s);
        let outside = s.path().join("outside.txt");
        write(&outside, "secret");
        std::os::unix::fs::symlink(&outside, root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(s.path(), root.join("linkdir")).unwrap();
        let roots = roots_of_paths(&[root]);
        let l = list(&roots).unwrap();
        assert!(l.entries.iter().all(|e| !e.rel.contains("link")));
        assert_eq!(
            l.skipped,
            vec!["photos/link.txt".to_string(), "photos/linkdir".to_string()]
        );
        assert!(matches!(
            read_file(&roots, "photos/link.txt"),
            Err(ReadError::Denied(_))
        ));
        assert!(matches!(
            read_file(&roots, "photos/linkdir/outside.txt"),
            Err(ReadError::Denied(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_root_is_rejected() {
        let s = Scratch::new("linkroot");
        let target = s.path().join("t.txt");
        write(&target, "x");
        let link = s.path().join("l.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let (roots, skipped) = prepare_roots(&[link]).unwrap();
        assert!(roots.is_empty());
        assert_eq!(skipped, vec!["l.txt".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn root_replaced_by_a_symlink_after_the_drop_is_not_listed_or_read() {
        let s = Scratch::new("swap");
        let root = tree(&s);
        let outside = s.path().join("outside");
        write(&outside.join("secret.txt"), "secret");
        let roots = roots_of_paths(std::slice::from_ref(&root));
        let moved = s.path().join("moved");
        fs::rename(&root, &moved).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        assert_eq!(list(&roots), Err(WalkError::Changed));
        assert!(matches!(
            read_file(&roots, "photos/secret.txt"),
            Err(ReadError::Denied(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_swapped_for_a_symlink_is_not_walked_into() {
        let s = Scratch::new("subswap");
        let root = tree(&s);
        let roots = roots_of_paths(std::slice::from_ref(&root));
        let outside = s.path().join("outside");
        write(&outside.join("secret.txt"), "secret");
        fs::remove_dir_all(root.join("sub")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("sub")).unwrap();
        let l = list(&roots).unwrap();
        assert!(l.entries.iter().all(|e| !e.rel.contains("secret")));
        assert!(l.skipped.contains(&"photos/sub".to_string()));
    }

    #[test]
    fn limits_count_every_item_read_before_anything_is_collected() {
        let s = Scratch::new("limit");
        let root = tree(&s);
        let roots = roots_of_paths(&[root]);
        // 項目は全部で 6（根を含む）。3 では、フォルダの途中で止まる
        assert_eq!(
            list_with_limits(&roots, 3, MAX_DEPTH),
            Err(WalkError::TooManyEntries)
        );
        assert!(list_with_limits(&roots, 7, MAX_DEPTH).is_ok());
        assert_eq!(list_with_limits(&roots, 100, 1), Err(WalkError::TooDeep));
    }

    #[test]
    fn a_wide_folder_stops_at_the_limit_without_collecting_all_of_it() {
        let s = Scratch::new("wide");
        let dir = s.path().join("wide");
        fs::create_dir_all(&dir).unwrap();
        for i in 0..200 {
            fs::write(dir.join(format!("f{i:03}")), "").unwrap();
        }
        let roots = roots_of_paths(&[dir]);
        assert_eq!(
            list_with_limits(&roots, 50, MAX_DEPTH),
            Err(WalkError::TooManyEntries)
        );
        assert!(list_with_limits(&roots, 201, MAX_DEPTH).is_ok());
    }

    #[test]
    fn missing_path_becomes_skipped() {
        let s = Scratch::new("missing");
        let (roots, skipped) = prepare_roots(&[s.path().join("none")]).unwrap();
        assert!(roots.is_empty());
        assert_eq!(skipped, vec!["none".to_string()]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_ancestor_swapped_for_a_symlink_outside_is_refused_at_open() {
        // 確認と開く間に、祖先のフォルダを外へのリンクに差し替えた場合（ハンドルの場所で拒む）
        let s = Scratch::new("ancestor");
        let root = tree(&s);
        let roots = roots_of_paths(std::slice::from_ref(&root));
        let outside = s.path().join("outside");
        write(&outside.join("a.txt"), "secret");
        let path = roots[0].path.join("a.txt");
        // 根の中のフォルダ（sub）を外へのリンクに差し替える（根そのものを替えると、根の確認で止まる）
        fs::remove_dir_all(root.join("sub")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("sub")).unwrap();
        let through_link = root.join("sub").join("a.txt");
        assert!(matches!(
            open_confined(&through_link, &roots[0]),
            Err(ReadError::Denied(_))
        ));
        assert!(open_confined(&path, &roots[0]).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_final_component_is_never_followed() {
        let s = Scratch::new("final");
        let root = tree(&s);
        let outside = s.path().join("outside.txt");
        write(&outside, "secret");
        std::os::unix::fs::symlink(&outside, root.join("link.txt")).unwrap();
        let roots = roots_of_paths(&[root.clone()]);
        assert!(matches!(
            open_confined(&root.join("link.txt"), &roots[0]),
            Err(ReadError::Denied(_))
        ));
    }
}
