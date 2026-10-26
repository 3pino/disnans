//! 画面の静止画を 1 枚だけ撮る（プラグイン API v11 の `disnans.screenCapture.snapshot`。デスクトップ）。
//! getDisplayMedia と違って、どの画面を共有するかの選択や許可のダイアログを出さない。
//! - Windows: 主モニター全体（GDI の StretchBlt で縮小しながら写す）
//! - Linux: X11 なら主モニター全体（ルートウィンドウ）。Wayland などで撮れなければ disnans 自身の画面（WebKitGTK のスナップショット）
//! - それ以外の OS: 撮れない（エラー）
//!
//! 画像の符号化（JPEG）は WebView 側（canvas）で行う。Rust 側では縮小した RGBA の画素だけを返し、
//! 画像のエンコーダーの依存を増やさない。
//! 返すバイナリ: 先頭 12 バイトが ヘッダー（幅 u32 LE・高さ u32 LE・元 u8（0 = 画面全体、1 = disnans 自身）・予備 3 バイト）、
//! 続けて幅×高さ×4 バイトの RGBA（上の行から）

/// 長辺をこれ以下に縮める
const MAX_EDGE: u32 = 1920;

/// 撮った 1 枚（縮小済みの RGBA）
#[allow(dead_code)]
struct Shot {
    width: u32,
    height: u32,
    /// true: 画面全体、false: disnans 自身の画面
    screen: bool,
    rgba: Vec<u8>,
}

#[allow(dead_code)]
impl Shot {
    fn into_bytes(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + self.rgba.len());
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.push(if self.screen { 0 } else { 1 });
        out.extend_from_slice(&[0, 0, 0]);
        out.extend_from_slice(&self.rgba);
        out
    }

    /// 全部真っ黒（または透明）か。X11 のルートウィンドウが中身を持たない環境（XWayland など）で起きる
    fn is_blank(&self) -> bool {
        // 全部を見ると重いので、間引いて見る
        self.rgba.as_chunks::<4>().0.iter().step_by(97).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0)
    }
}

/// 長辺が `MAX_EDGE` 以下になる大きさ（縦横比は保つ）
#[allow(dead_code)]
fn fit(w: u32, h: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= MAX_EDGE || long == 0 {
        return (w.max(1), h.max(1));
    }
    let s = MAX_EDGE as f64 / long as f64;
    (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1))
}

/// 画面の静止画を 1 枚撮る。選択や許可のダイアログは出さない
#[tauri::command]
pub async fn screen_snapshot(window: tauri::WebviewWindow) -> Result<tauri::ipc::Response, String> {
    let shot = capture(window).await?;
    Ok(tauri::ipc::Response::new(shot.into_bytes()))
}

#[cfg(windows)]
async fn capture(_window: tauri::WebviewWindow) -> Result<Shot, String> {
    tauri::async_runtime::spawn_blocking(windows_gdi::capture_primary)
        .await
        .map_err(|e| format!("画面を撮れませんでした: {e}"))?
}

#[cfg(target_os = "linux")]
async fn capture(window: tauri::WebviewWindow) -> Result<Shot, String> {
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<Shot, String>>(1);
    // GTK はメインスレッドでしか触れないので、with_webview（メインスレッドで呼ばれる）の中で撮る
    window
        .with_webview(move |webview| linux::capture(webview.inner(), tx))
        .map_err(|e| format!("画面を撮れませんでした: {e}"))?;
    rx.recv().await.unwrap_or_else(|| Err("画面を撮れませんでした".into()))
}

#[cfg(not(any(windows, target_os = "linux")))]
async fn capture(_window: tauri::WebviewWindow) -> Result<Shot, String> {
    Err("この環境では画面を撮れません".into())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{fit, Shot};
    use gdk::gdk_pixbuf::{InterpType, Pixbuf};
    use gdk::prelude::*;
    use tauri::async_runtime::Sender;
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    /// X11 なら主モニター全体、撮れなければ disnans 自身の画面。結果は `tx` に送る（メインスレッドで呼ぶ）
    pub fn capture(webview: webkit2gtk::WebView, tx: Sender<Result<Shot, String>>) {
        if let Some(shot) = capture_x11_monitor() {
            let _ = tx.try_send(Ok(shot));
            return;
        }
        // Wayland などでは、ほかのアプリの画面をダイアログなしで撮る方法がないので、disnans 自身の画面にする
        webview.snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&gdk::gio::Cancellable>, move |res| {
            let shot = match res {
                Ok(surface) => surface_to_shot(&surface).ok_or_else(|| "画面を画像にできませんでした".to_string()),
                Err(e) => Err(format!("画面を撮れませんでした: {e}")),
            };
            let _ = tx.try_send(shot);
        });
    }

    /// X11 のルートウィンドウから主モニターの範囲を撮る。X11 でない・撮れない・真っ黒なら None
    fn capture_x11_monitor() -> Option<Shot> {
        // Wayland のセッションでは、XWayland 経由で X11 として動いていてもルートウィンドウにほかのアプリは写らない
        if std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty()) {
            return None;
        }
        if std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland")) {
            return None;
        }
        let display = gdk::Display::default()?;
        if !display.backend().is_x11() {
            return None;
        }
        let root = gdk::Window::default_root_window();
        let rect = display.primary_monitor().or_else(|| display.monitor(0)).map(|m| m.geometry());
        let (x, y, w, h) = match rect {
            Some(r) if r.width() > 0 && r.height() > 0 => (r.x(), r.y(), r.width(), r.height()),
            _ => (0, 0, root.width(), root.height()),
        };
        let pixbuf = root.pixbuf(x, y, w, h)?;
        let shot = pixbuf_to_shot(&pixbuf, true)?;
        (!shot.is_blank()).then_some(shot)
    }

    fn surface_to_shot(surface: &gdk::cairo::Surface) -> Option<Shot> {
        let img = gdk::cairo::ImageSurface::try_from(surface.clone()).ok()?;
        let pixbuf = gdk::pixbuf_get_from_surface(surface, 0, 0, img.width(), img.height())?;
        pixbuf_to_shot(&pixbuf, false)
    }

    /// 縮小して、詰めた RGBA にする
    fn pixbuf_to_shot(src: &Pixbuf, screen: bool) -> Option<Shot> {
        let (sw, sh) = (src.width().max(0) as u32, src.height().max(0) as u32);
        if sw == 0 || sh == 0 {
            return None;
        }
        let (w, h) = fit(sw, sh);
        let scaled;
        let pb = if (w, h) != (sw, sh) {
            scaled = src.scale_simple(w as i32, h as i32, InterpType::Bilinear)?;
            &scaled
        } else {
            src
        };
        let (w, h) = (pb.width() as usize, pb.height() as usize);
        let stride = pb.rowstride() as usize;
        let n = pb.n_channels() as usize;
        let alpha = pb.has_alpha();
        let bytes = pb.read_pixel_bytes();
        let data: &[u8] = &bytes;
        let mut rgba = Vec::with_capacity(w * h * 4);
        for row in 0..h {
            let base = row * stride;
            for col in 0..w {
                let i = base + col * n;
                let p = data.get(i..i + n)?;
                rgba.extend_from_slice(&[p[0], p[1], p[2], if alpha { p[3] } else { 255 }]);
            }
        }
        Some(Shot { width: w as u32, height: h as u32, screen, rgba })
    }
}

#[cfg(windows)]
mod windows_gdi {
    use super::{fit, Shot};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
        SetBrushOrgEx, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
        HALFTONE, HGDIOBJ, ROP_CODE, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    /// 主モニター全体を、縮小しながら写す（アプリは DPI 対応なので、物理ピクセルで撮れる）
    pub fn capture_primary() -> Result<Shot, String> {
        unsafe {
            let sw = GetSystemMetrics(SM_CXSCREEN);
            let sh = GetSystemMetrics(SM_CYSCREEN);
            if sw <= 0 || sh <= 0 {
                return Err("画面の大きさが分かりません".into());
            }
            let (w, h) = fit(sw as u32, sh as u32);
            let (w, h) = (w as i32, h as i32);

            let screen = GetDC(None);
            if screen.is_invalid() {
                return Err("画面を撮れませんでした（GetDC）".into());
            }
            let mem = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let result = if mem.is_invalid() || bmp.is_invalid() {
                Err("画面を撮れませんでした（ビットマップを作れません）".to_string())
            } else {
                let old = SelectObject(mem, HGDIOBJ::from(bmp));
                SetStretchBltMode(mem, HALFTONE);
                let _ = SetBrushOrgEx(mem, 0, 0, None);
                let ok = StretchBlt(mem, 0, 0, w, h, Some(screen), 0, 0, sw, sh, ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0)).as_bool();
                SelectObject(mem, old);
                if !ok {
                    Err("画面を撮れませんでした（StretchBlt）".to_string())
                } else {
                    let mut info = BITMAPINFO {
                        bmiHeader: BITMAPINFOHEADER {
                            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                            biWidth: w,
                            // 負の高さで、上の行から並べる
                            biHeight: -h,
                            biPlanes: 1,
                            biBitCount: 32,
                            biCompression: BI_RGB.0,
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    let mut buf = vec![0u8; (w * h * 4) as usize];
                    let lines = GetDIBits(mem, bmp, 0, h as u32, Some(buf.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
                    if lines <= 0 {
                        Err("画面を撮れませんでした（GetDIBits）".to_string())
                    } else {
                        // BGRA → RGBA（GDI の α は意味を持たないので不透明にする）
                        for p in buf.as_chunks_mut::<4>().0 {
                            p.swap(0, 2);
                            p[3] = 255;
                        }
                        Ok(Shot { width: w as u32, height: h as u32, screen: true, rgba: buf })
                    }
                }
            };
            if !bmp.is_invalid() {
                let _ = DeleteObject(HGDIOBJ::from(bmp));
            }
            if !mem.is_invalid() {
                let _ = DeleteDC(mem);
            }
            ReleaseDC(None, screen);
            result
        }
    }
}
