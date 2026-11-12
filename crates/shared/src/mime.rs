//! 拡張子から MIME（Content-Type の種類）を決める。サーバー・CLI・Tauri で同じ表を使う。
//!
//! 入れるもの: WebView で描ける画像（jpg・png・gif・webp・avif・bmp）と、各所が以前から扱っていた非画像。
//! 入れないもの: SVG・HTML・XHTML・XML・JS・CSS（スクリプトを含められる）。HEIC・TIFF・ICO など WebView で描けない画像は
//! 表に入れない（recent_images だけが、以前どおり自分で持つ）。知らない拡張子は None（既定の型は呼び出し側が決める）。

/// 拡張子（点なし。大文字・小文字は問わない）から MIME を決める。知らない拡張子は None。
pub fn for_extension(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_extensions_map_case_insensitively() {
        assert_eq!(for_extension("PNG"), Some("image/png"));
        assert_eq!(for_extension("Jpeg"), Some("image/jpeg"));
        assert_eq!(for_extension("csv"), Some("text/csv"));
        assert_eq!(for_extension("avif"), Some("image/avif"));
        assert_eq!(for_extension("webm"), Some("video/webm"));
        assert_eq!(for_extension("ogg"), Some("audio/ogg"));
    }

    /// 表に無い画像（WebView で描けない・以前は recent_images だけが持っていた）は、推測では決めない
    #[test]
    fn images_webview_cannot_draw_are_not_in_the_table() {
        for ext in [
            "heic", "heif", "jxl", "tif", "tiff", "ico", "qoi", "tga", "apng", "pjpeg", "jfif",
        ] {
            assert_eq!(for_extension(ext), None, "{ext}");
        }
    }

    #[test]
    fn unknown_and_active_types_are_not_guessed() {
        assert_eq!(for_extension(""), None);
        assert_eq!(for_extension("tar.gz"), None);
        assert_eq!(for_extension("exe"), None);
        // スクリプトを含められる型は、推測の段階では作らない（既定の octet-stream に任せる）
        for ext in ["svg", "html", "htm", "xhtml", "xml", "js", "css", "mjs"] {
            assert_eq!(for_extension(ext), None, "{ext}");
        }
    }
}
