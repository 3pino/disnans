#[cfg(not(target_os = "android"))]
use super::desktop::save_into_dir;

use super::*;

#[test]
fn only_api_file_and_shared_paths_are_fetched() {
    assert!(is_download_path("/api/files/01HX"));
    assert!(is_download_path("/api/shared/a/b%20c.txt"));
    assert!(!is_download_path("/api/me"));
    assert!(!is_download_path("https://evil.example/api/files/x"));
    assert!(!is_download_path("/api/shared/../secret"));
    assert!(!is_download_path("/api/shared/a/./b"));
    assert!(!is_download_path("/api/files/x?dev_user=a"));
    assert!(!is_download_path("/api/shared/a\\b"));
    assert!(!is_download_path("/api/shared/a\nb"));
    assert!(!is_download_path("/api/files/x#frag"));
}

#[test]
fn names_drop_separators_and_forbidden_characters() {
    assert_eq!(sanitize_name("photo.png"), "photo.png");
    assert_eq!(sanitize_name("a/b\\c.txt"), "a_b_c.txt");
    assert_eq!(sanitize_name("x:y*z?.txt"), "x_y_z_.txt");
    assert_eq!(sanitize_name("a\u{0}b\u{7f}.txt"), "a_b_.txt");
    assert_eq!(sanitize_name("  spaced.pdf  "), "spaced.pdf");
    assert_eq!(sanitize_name("name. "), "name");
}

#[test]
fn empty_and_dot_names_fall_back() {
    assert_eq!(sanitize_name(""), "download");
    assert_eq!(sanitize_name("   "), "download");
    assert_eq!(sanitize_name("."), "download");
    assert_eq!(sanitize_name(".."), "download");
    assert_eq!(sanitize_name("..."), "download");
}

#[test]
fn windows_reserved_names_are_prefixed() {
    assert_eq!(sanitize_name("CON"), "_CON");
    assert_eq!(sanitize_name("nul.txt"), "_nul.txt");
    assert_eq!(sanitize_name("com3.log"), "_com3.log");
    assert_eq!(sanitize_name("LPT9"), "_LPT9");
    // 予約名ではないもの
    assert_eq!(sanitize_name("COM0"), "COM0");
    assert_eq!(sanitize_name("console.txt"), "console.txt");
}

#[test]
fn long_names_keep_the_extension() {
    let long = format!("{}.pdf", "a".repeat(300));
    let out = sanitize_name(&long);
    assert_eq!(out.chars().count(), MAX_NAME_CHARS);
    assert!(out.ends_with(".pdf"));
    let no_ext = "b".repeat(300);
    assert_eq!(sanitize_name(&no_ext).chars().count(), MAX_NAME_CHARS);
}

#[test]
fn numbering_splits_at_the_last_dot_and_keeps_dotfiles_whole() {
    assert_eq!(candidate_name("photo.png", 1), "photo.png");
    assert_eq!(candidate_name("photo.png", 2), "photo (2).png");
    assert_eq!(candidate_name("archive.tar.gz", 2), "archive.tar (2).gz");
    assert_eq!(candidate_name(".bashrc", 2), ".bashrc (2)");
    assert_eq!(candidate_name("docs", 2), "docs (2)");
}

#[test]
fn mime_comes_from_the_extension() {
    assert_eq!(mime_for("a.PNG"), "image/png");
    assert_eq!(mime_for("a.pdf"), "application/pdf");
    assert_eq!(mime_for("a.tar.gz"), "application/octet-stream");
    assert_eq!(mime_for("noext"), "application/octet-stream");
    assert_eq!(mime_for(".png"), "application/octet-stream");
}

#[test]
fn reserve_never_overwrites_and_numbers_the_name() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), b"old").unwrap();
    let (first, _f1) = reserve(dir.path(), "a.txt").unwrap();
    assert_eq!(first.file_name().unwrap(), "a (2).txt");
    let (second, _f2) = reserve(dir.path(), "a.txt").unwrap();
    assert_eq!(second.file_name().unwrap(), "a (3).txt");
    assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"old");
}

/// 一度だけ応答する HTTP の偽サーバー（`body` を返す。`declared` は Content-Length。`declared` が多いと途中で切れる）
fn serve_once(status: &'static str, body: &'static [u8], declared: usize) -> String {
    use std::io::{Read, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
        }
    });
    format!("http://{addr}")
}

fn run<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

#[test]
fn saves_the_body_and_numbers_a_taken_name() {
    let server = serve_once("200 OK", b"hello", 5);
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("note.txt"), b"keep").unwrap();
    let client = RestClient::new(ServerUrl::parse(&server).unwrap(), None).unwrap();
    let (path, name) = run(async {
        let mut download = client.download("/api/files/abc").await.unwrap();
        save_into_dir(dir.path(), &mut download, "note.txt")
            .await
            .unwrap()
    });
    assert_eq!(name, "note (2).txt");
    assert_eq!(fs::read(&path).unwrap(), b"hello");
    assert_eq!(fs::read(dir.path().join("note.txt")).unwrap(), b"keep");
}

#[test]
fn a_failed_status_saves_nothing() {
    let body: &'static [u8] = b"{\"code\":\"not_found\",\"message\":\"x\"}";
    let server = serve_once("404 Not Found", body, body.len());
    let client = RestClient::new(ServerUrl::parse(&server).unwrap(), None).unwrap();
    let err = run(client.download("/api/files/missing"))
        .err()
        .expect("404 は失敗");
    assert_eq!(err.status, Some(404));
    assert_eq!(err.code, "not_found");
}

#[test]
fn a_cut_off_body_leaves_no_partial_file() {
    // 10 バイト宣言して 3 バイトで切る
    let server = serve_once("200 OK", b"abc", 10);
    let dir = tempfile::tempdir().unwrap();
    let client = RestClient::new(ServerUrl::parse(&server).unwrap(), None).unwrap();
    let result = run(async {
        let mut download = client.download("/api/files/cut").await.unwrap();
        save_into_dir(dir.path(), &mut download, "cut.bin").await
    });
    assert!(result.is_err());
    assert_eq!(
        fs::read_dir(dir.path()).unwrap().count(),
        0,
        "書きかけのファイルを残さない"
    );
}

#[test]
fn io_errors_map_to_fixed_codes() {
    let denied = std::io::Error::from(ErrorKind::PermissionDenied);
    assert_eq!(io_failure(&denied).code, "permission");
    let other = std::io::Error::from(ErrorKind::Other);
    assert_eq!(io_failure(&other).code, "io");
    #[cfg(unix)]
    assert_eq!(
        io_failure(&std::io::Error::from_raw_os_error(28)).code,
        "no_space"
    );
    #[cfg(windows)]
    assert_eq!(
        io_failure(&std::io::Error::from_raw_os_error(112)).code,
        "no_space"
    );
}
