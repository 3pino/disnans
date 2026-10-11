#![cfg(target_os = "linux")]
//! Linux のネイティブ画面共有（xdg-desktop-portal の ScreenCast ＋ PipeWire ＋ GStreamer）。WebKitGTK の映像描画には頼らない。
//!
//! 流れ:
//! 1. `linux_screen_start`（共有ボタンを押した利用者の操作でだけ呼ぶ）: portal が画面・ウィンドウの選択ダイアログを出す。
//!    利用者が選んだ画面（PipeWire のノード）だけを使う。選ばれなければ主モニターなどに置き換えず、エラーにする。
//! 2. GStreamer: pipewiresrc → videoconvert → appsink（RGBx）。間引きは appsink のコールバックで行う。
//!    videorate の次のフレーム待ちを避け、静止した画面の最初の 1 枚もすぐ取り込む。
//! 3. 専用スレッドで、fps の上限・変化の検出（diffThreshold）・縮小（maxEdge）・減色（color）を行い、JPEG（base64）にして
//!    `linux-screen-frame`（{ data, mime, width, height }）を送る。変わらなくても keepaliveMs ごとに直前の 1 枚を送り直す。
//! 4. 終わり（stop・portal の切断・映像の終了・エラー）は `linux-screen-end`（{ reason }）で知らせる。
//!    reason: "stopped" / "replaced"（開始し直した）/ "portal-closed" / "source-ended" / "error"（message 付き）
//!
//! 失敗は `{ code, message }` で返す。code:
//! - "cancelled": 利用者がダイアログを閉じた、または開始の途中で stop された（JS では AbortError として扱う）
//! - "unavailable": portal・PipeWire・GStreamer の要素が無い
//! - "invalid": オプションが不正（未対応の形式・色）
//! - "not_running": 共有していないのに linux_screen_update を呼んだ
//! - "failed": そのほか
//!
//! 統合（lib.rs・JS は別作業）:
//! - lib.rs: `#[cfg(target_os = "linux")] mod linux_capture;`、`.manage(linux_capture::LinuxScreenState::default())`、
//!   `generate_handler!` に `linux_capture::linux_screen_start` / `linux_screen_stop` / `linux_screen_update`（Linux のみ）
//! - JS: `invoke("linux_screen_start", { options })`（options は省略可）、`invoke("linux_screen_update", { options })`、`invoke("linux_screen_stop")`。
//!   `listen("linux-screen-frame", ...)` / `listen("linux-screen-end", ...)`
//! - options（省いたものは既定）: maxEdge 160〜3840（1280）、scale 0.1〜1（1）、fps 1〜30（5）、quality 0.1〜1（0.6）、format "jpeg" のみ、
//!   color "full" | "gray" | "c256"（full）、diffThreshold 0〜255（1.5）、keepaliveMs 500〜60000（5000）。範囲外は端に寄せる
//! - 実行時に必要なパッケージ: gstreamer1.0-pipewire、gstreamer1.0-plugins-base、xdg-desktop-portal（＋デスクトップに合うバックエンド）
//! - 停止・置き換え・アプリの終了では、パイプラインを Null にしてから portal のセッションを閉じる。fd は共有の終わりまで保持する。

use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use ashpd::desktop::screencast::{
    CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType,
    StartCastOptions,
};
use ashpd::desktop::{PersistMode, ResponseError, Session};
use base64::Engine;
use futures_util::StreamExt;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_video::{self as gst_video, prelude::*};
use jpeg_encoder::ColorType;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State, WebviewWindow};
use tokio_util::sync::CancellationToken;

const EVENT_FRAME: &str = "linux-screen-frame";
const EVENT_END: &str = "linux-screen-end";

/// 範囲（clamp）と既定値
const MAX_EDGE_RANGE: (f64, f64) = (160.0, 3840.0);
const FPS_RANGE: (f64, f64) = (1.0, 30.0);
const QUALITY_RANGE: (f64, f64) = (0.1, 1.0);
const DIFF_RANGE: (f64, f64) = (0.0, 255.0);
const KEEPALIVE_RANGE: (f64, f64) = (500.0, 60_000.0);

/// 変化の判定に使う縮小画像の大きさ（JS 側の判定と同じ 64×36）
const THUMB_W: usize = 64;
const THUMB_H: usize = 36;
/// 縮小画像の 1 画素（RGB の平均の差）がこれを超えたら、全体の平均が小さくても変わったとみなす（小さな文字の変化を拾う）
const PEAK_DIFF: u32 = 24;
/// 停止の確認に使う待ちの単位
const POLL_MS: u64 = 200;
/// portal のセッションを閉じる待ちの上限
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

// ---- 設定 ----

/// 色数
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Color {
    Full,
    Gray,
    /// 3・3・2 bit（256 色相当）に減色する
    C256,
}

/// 受け手が決める設定。開始時と linux_screen_update で変えられる
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Settings {
    pub max_edge: u32,
    pub scale: f64,
    pub fps: f64,
    pub quality: f64,
    pub color: Color,
    pub diff_threshold: f64,
    pub keepalive_ms: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_edge: 1280,
            scale: 1.0,
            fps: 5.0,
            quality: 0.6,
            color: Color::Full,
            diff_threshold: 1.5,
            keepalive_ms: 5000,
        }
    }
}

/// JS から来るオプション。省いたものは既定（または今の設定）のまま
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenOptions {
    /// ホストの購読世代。前の共有の遅れたイベントを新しい共有へ混ぜない
    pub capture_id: Option<u64>,
    pub max_edge: Option<f64>,
    pub scale: Option<f64>,
    pub fps: Option<f64>,
    pub quality: Option<f64>,
    pub format: Option<String>,
    pub color: Option<String>,
    pub diff_threshold: Option<f64>,
    pub keepalive_ms: Option<f64>,
}

impl ScreenOptions {
    /// `base` に指定のあるものだけ上書きする。数値は範囲に収め、未対応の形式・色は invalid
    pub fn apply(&self, base: Settings) -> Result<Settings, CaptureError> {
        match self.format.as_deref() {
            None | Some("jpeg") => {}
            Some(other) => {
                return Err(CaptureError::invalid(format!(
                    "未対応の形式です: {other}（jpeg のみ）"
                )))
            }
        }
        let color = match self.color.as_deref() {
            None => base.color,
            Some("full") => Color::Full,
            Some("gray") => Color::Gray,
            Some("c256") => Color::C256,
            Some(other) => return Err(CaptureError::invalid(format!("未対応の色数です: {other}"))),
        };
        Ok(Settings {
            max_edge: clamp_opt(self.max_edge, f64::from(base.max_edge), MAX_EDGE_RANGE).round()
                as u32,
            scale: clamp_opt(self.scale, base.scale, (0.1, 1.0)),
            fps: clamp_opt(self.fps, base.fps, FPS_RANGE),
            quality: clamp_opt(self.quality, base.quality, QUALITY_RANGE),
            color,
            diff_threshold: clamp_opt(self.diff_threshold, base.diff_threshold, DIFF_RANGE),
            keepalive_ms: clamp_opt(self.keepalive_ms, base.keepalive_ms as f64, KEEPALIVE_RANGE)
                .round() as u64,
        })
    }
}

/// 値があれば範囲に収め、なければ既定の値（これも範囲に収める）
fn clamp_opt(v: Option<f64>, fallback: f64, (lo, hi): (f64, f64)) -> f64 {
    match v {
        Some(x) if x.is_finite() => x.clamp(lo, hi),
        _ => fallback.clamp(lo, hi),
    }
}

// ---- 画像の計算（純粋な関数。テストする） ----

/// 長辺が max_edge 以下になる大きさ（縦横比は保つ。拡大はしない）
pub fn fit_size(w: u32, h: u32, max_edge: u32) -> (u32, u32) {
    let long = w.max(h);
    if long == 0 || long <= max_edge {
        return (w.max(1), h.max(1));
    }
    let s = f64::from(max_edge) / f64::from(long);
    let scale = |v: u32| ((f64::from(v) * s).round() as u32).max(1);
    (scale(w), scale(h))
}

/// dst の i 番目の画素が、src のどの範囲（[start, end)、1 画素以上）に当たるか
fn span(i: usize, dst: usize, src: usize) -> (usize, usize) {
    let start = i * src / dst;
    let end = ((i + 1) * src / dst).max(start + 1).min(src);
    (start, end)
}

/// RGBx（1 画素 4 バイト。x は読まない）を、面積平均で dw×dh の RGB に縮小する。
/// 同じ大きさなら画素はそのまま。拡大のときは最近傍になる
pub fn downscale_rgb(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 3];
    for dy in 0..dh {
        let (y0, y1) = span(dy, dh, sh);
        for dx in 0..dw {
            let (x0, x1) = span(dx, dw, sw);
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row = &src[(y * sw + x0) * 4..(y * sw + x1) * 4];
                for p in row.chunks_exact(4) {
                    r += u32::from(p[0]);
                    g += u32::from(p[1]);
                    b += u32::from(p[2]);
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as u32;
            let o = (dy * dw + dx) * 3;
            out[o] = ((r + n / 2) / n) as u8;
            out[o + 1] = ((g + n / 2) / n) as u8;
            out[o + 2] = ((b + n / 2) / n) as u8;
        }
    }
    out
}

/// RGB を 3・3・2 bit（256 色相当）に減らす。各段の中央の値にそろえる
pub fn quantize_332(rgb: &mut [u8]) {
    for p in rgb.chunks_exact_mut(3) {
        p[0] = (p[0] & 0xE0) | 0x10;
        p[1] = (p[1] & 0xE0) | 0x10;
        p[2] = (p[2] & 0xC0) | 0x20;
    }
}

/// RGB を輝度（Y）にする（白は 255、黒は 0）
pub fn to_luma(rgb: &[u8]) -> Vec<u8> {
    rgb.chunks_exact(3)
        .map(|p| ((77 * u32::from(p[0]) + 150 * u32::from(p[1]) + 29 * u32::from(p[2])) >> 8) as u8)
        .collect()
}

/// 前回送った縮小画像と比べて変わったか。全体の（チャンネルの）平均の差が threshold を超えたとき、
/// または 1 画素の RGB の平均の差が PEAK_DIFF を超えたときに「変わった」
pub fn changed(prev: &[u8], cur: &[u8], threshold: f64) -> bool {
    if prev.len() != cur.len() || cur.is_empty() {
        return true;
    }
    let mut sum = 0u64;
    let mut peak = 0u32;
    for (a, b) in prev.chunks_exact(3).zip(cur.chunks_exact(3)) {
        let mut px = 0u32;
        for k in 0..3 {
            let d = u32::from(a[k].abs_diff(b[k]));
            sum += u64::from(d);
            px += d;
        }
        peak = peak.max(px / 3);
    }
    let mean = sum as f64 / cur.len() as f64;
    mean > threshold || peak > PEAK_DIFF
}

/// JPEG の品質（0.1〜1.0 を 1〜100 に）
pub fn jpeg_quality(q: f64) -> u8 {
    (q * 100.0).round().clamp(1.0, 100.0) as u8
}

/// 間隔（fps の逆数）ごとに 1 枚通す。`next` は次に通してよい時刻。源の周期（30 fps など）と割り切れなくても、
/// 予定を積み上げるので平均は fps に合う（前回からの経過だけで見ると、25 fps が 15 fps になってしまう）
pub fn take_slot(next: &mut Option<Instant>, now: Instant, interval: Duration) -> bool {
    if next.is_some_and(|t| now < t) {
        return false;
    }
    *next = Some(match *next {
        Some(t) => (t + interval).max(now),
        None => now + interval,
    });
    true
}

/// 1 枚の JPEG 化（pixels は RGB。Gray のときは輝度）
fn encode_jpeg(
    pixels: &[u8],
    w: u32,
    h: u32,
    color: ColorType,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality)
        .encode(pixels, w as u16, h as u16, color)
        .map_err(|e| format!("JPEG にできませんでした: {e}"))?;
    Ok(out)
}

/// 送るべき 1 枚（変わっていれば作る）
pub struct Encoded {
    pub width: u32,
    pub height: u32,
    pub jpeg: Vec<u8>,
    /// 変化の判定に使った縮小画像（次の比べる相手）
    pub thumb: Vec<u8>,
}

/// 1 枚（RGBx、sw×sh）を見て、前回送った縮小画像（prev_thumb）と比べて変わっていれば JPEG にする。変わらなければ None
pub fn prepare_frame(
    rgbx: &[u8],
    sw: usize,
    sh: usize,
    s: &Settings,
    prev_thumb: Option<&[u8]>,
) -> Result<Option<Encoded>, String> {
    if sw == 0 || sh == 0 || rgbx.len() != sw * sh * 4 {
        return Err("フレームの大きさが合いません".into());
    }
    let thumb = downscale_rgb(rgbx, sw, sh, THUMB_W, THUMB_H);
    if prev_thumb.is_some_and(|prev| !changed(prev, &thumb, s.diff_threshold)) {
        return Ok(None);
    }
    let edge = (f64::from(s.max_edge) * s.scale).round().max(160.0) as u32;
    let (w, h) = fit_size(sw as u32, sh as u32, edge);
    let mut rgb = downscale_rgb(rgbx, sw, sh, w as usize, h as usize);
    let color = match s.color {
        Color::Full => ColorType::Rgb,
        Color::C256 => {
            quantize_332(&mut rgb);
            ColorType::Rgb
        }
        Color::Gray => {
            rgb = to_luma(&rgb);
            ColorType::Luma
        }
    };
    let jpeg = encode_jpeg(&rgb, w, h, color, jpeg_quality(s.quality))?;
    Ok(Some(Encoded {
        width: w,
        height: h,
        jpeg,
        thumb,
    }))
}

// ---- エラー ----

/// 失敗の理由（JS へは { code, message } で届く）
#[derive(Debug, Clone, Serialize)]
pub struct CaptureError {
    pub code: &'static str,
    pub message: String,
}

impl CaptureError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn cancelled() -> Self {
        Self::new("cancelled", "画面の選択をキャンセルしました")
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }
    fn unavailable(message: impl Into<String>) -> Self {
        Self::new("unavailable", message)
    }
    fn failed(message: impl Into<String>) -> Self {
        Self::new("failed", message)
    }
    fn not_running() -> Self {
        Self::new("not_running", "画面を共有していません")
    }
}

/// portal（ashpd）の失敗を、利用者が分かる code に直す
fn portal_error(e: ashpd::Error) -> CaptureError {
    match e {
        ashpd::Error::Response(ResponseError::Cancelled)
        | ashpd::Error::Portal(ashpd::PortalError::Cancelled(_)) => CaptureError::cancelled(),
        ashpd::Error::PortalNotFound(_)
        | ashpd::Error::RequiresVersion(..)
        | ashpd::Error::Zbus(_) => {
            CaptureError::unavailable(format!("画面共有（xdg-desktop-portal）を使えません: {e}"))
        }
        other => CaptureError::failed(format!("画面の選択に失敗しました: {other}")),
    }
}

// ---- 状態 ----

/// 共有の状態（lib.rs で `.manage` する）。Drop で共有を止める（アプリの終了）
#[derive(Default)]
pub struct LinuxScreenState {
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// 開始の番号（新しい開始ごとに増える）
    next_id: u64,
    /// 開始の途中（portal のダイアログなど）。新しい開始・stop・終了で取り消す
    pending: Option<(u64, CancellationToken)>,
    /// 共有中
    active: Option<Active>,
}

/// 共有中の 1 回分。所有する資源（パイプライン・portal のセッション・fd）はここにまとめる
struct Active {
    id: u64,
    capture_id: u64,
    window: WebviewWindow,
    /// portal のセッション（閉じる・切断の監視で共有する）
    session: Arc<Session<Screencast>>,
    /// PipeWire の fd（元のもの）。パイプラインを Null にしたあとで閉じる
    fd: OwnedFd,
    pipeline: gst::Pipeline,
    settings: Arc<Mutex<Settings>>,
    /// 付随するスレッド・タスクに止まるよう知らせる
    stop: Arc<AtomicBool>,
}

impl Active {
    /// パイプラインを止める（同期）。portal のセッションは呼び出し側が閉じる（非同期）
    fn stop_capture(self) -> Arc<Session<Screencast>> {
        let Active {
            session,
            fd,
            pipeline,
            stop,
            ..
        } = self;
        stop.store(true, Ordering::SeqCst);
        // Null にすると、映像のスレッドが止まり、PipeWire の接続も切れる
        let _ = pipeline.set_state(gst::State::Null);
        drop(fd);
        session
    }
}

fn lock(shared: &Shared) -> MutexGuard<'_, Inner> {
    shared.inner.lock().unwrap_or_else(PoisonError::into_inner)
}

fn lock_settings(m: &Mutex<Settings>) -> MutexGuard<'_, Settings> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 共有を止めて、終了を知らせる。portal のセッションは背景で閉じる
fn retire(active: Active, reason: &'static str, message: Option<String>) {
    let window = active.window.clone();
    let capture_id = active.capture_id;
    let session = active.stop_capture();
    let _ = window.emit(
        EVENT_END,
        EndPayload {
            capture_id,
            reason,
            message,
        },
    );
    tauri::async_runtime::spawn(async move { close_session(&session).await });
}

/// 映像のスレッドからの終了（その開始がまだ共有中のときだけ）
fn finish(shared: &Shared, id: u64, reason: &'static str, message: Option<String>) {
    let active = lock(shared).active.take_if(|a| a.id == id);
    if let Some(active) = active {
        retire(active, reason, message);
    }
}

async fn close_session(session: &Session<Screencast>) {
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, session.close()).await;
}

/// 開始の途中で失敗したときの後始末（開始の番号を外し、portal のセッションを閉じる）
async fn abort_start(
    shared: &Shared,
    id: u64,
    session: &Session<Screencast>,
    err: CaptureError,
) -> CaptureError {
    {
        let mut inner = lock(shared);
        if inner.pending.as_ref().is_some_and(|(p, _)| *p == id) {
            inner.pending = None;
        }
    }
    close_session(session).await;
    err
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EndPayload {
    capture_id: u64,
    reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FramePayload {
    capture_id: u64,
    data: String,
    mime: &'static str,
    width: u32,
    height: u32,
}

// ---- portal での選択 ----

/// portal で選ばれた画面（PipeWire のノード）と、その fd
struct Negotiated {
    session: Session<Screencast>,
    node: u32,
    fd: OwnedFd,
}

/// カーソルは、使えれば映像に含める（見ている人がカーソルを追えるように）
async fn cursor_mode(sc: &Screencast) -> CursorMode {
    match sc.available_cursor_modes().await {
        Ok(modes) if modes.contains(CursorMode::Embedded) => CursorMode::Embedded,
        _ => CursorMode::Hidden,
    }
}

/// 画面の選択と開始。token が取り消されたら（stop・開始し直し）セッションを閉じて cancelled にする
async fn negotiate(token: &CancellationToken) -> Result<Negotiated, CaptureError> {
    let screencast = Screencast::new().await.map_err(portal_error)?;
    let session = screencast
        .create_session(Default::default())
        .await
        .map_err(portal_error)?;
    let flow = async {
        let cursor = cursor_mode(&screencast).await;
        screencast
            .select_sources(
                &session,
                SelectSourcesOptions::default()
                    .set_cursor_mode(cursor)
                    .set_sources(SourceType::Monitor | SourceType::Window)
                    .set_multiple(false)
                    .set_persist_mode(PersistMode::DoNot),
            )
            .await
            .map_err(portal_error)?
            .response()
            .map_err(portal_error)?;
        let streams = screencast
            .start(&session, None, StartCastOptions::default())
            .await
            .map_err(portal_error)?
            .response()
            .map_err(portal_error)?;
        // 利用者が選んだ画面だけを使う（ほかの画面に置き換えない）
        let node = streams
            .streams()
            .first()
            .map(|s| s.pipe_wire_node_id())
            .ok_or_else(|| CaptureError::failed("選ばれた画面がありません"))?;
        let fd = screencast
            .open_pipe_wire_remote(&session, OpenPipeWireRemoteOptions::default())
            .await
            .map_err(portal_error)?;
        Ok::<_, CaptureError>((node, fd))
    };
    match token.run_until_cancelled(flow).await {
        Some(Ok((node, fd))) => Ok(Negotiated { session, node, fd }),
        Some(Err(e)) => {
            close_session(&session).await;
            Err(e)
        }
        // 取り消された。ダイアログが出たままでも、セッションを閉じると portal が片付ける
        None => {
            close_session(&session).await;
            Err(CaptureError::cancelled())
        }
    }
}

// ---- GStreamer ----

/// 行の詰め物を除き、詰めた RGBx にする。壊れたサイズ・極端に大きい入力は拒否する
fn pack_rgbx(src: &[u8], w: usize, h: usize, stride: usize) -> Option<Vec<u8>> {
    let row = w.checked_mul(4)?;
    let size = row.checked_mul(h)?;
    if w == 0 || h == 0 || stride < row || size > 256 * 1024 * 1024 {
        return None;
    }
    let required = (h - 1).checked_mul(stride)?.checked_add(row)?;
    if src.len() < required {
        return None;
    }
    let mut out = Vec::with_capacity(size);
    for y in 0..h {
        out.extend_from_slice(&src[y * stride..y * stride + row]);
    }
    Some(out)
}

/// appsink から映像のスレッドへ渡す 1 枚（RGBx）
struct RawFrame {
    width: usize,
    height: usize,
    data: Vec<u8>,
}

/// pipewiresrc → videoconvert → appsink を組んで再生を始める。
/// `fd` は呼び出し側（Active）が持つ fd。pipewiresrc は内部で複製して使うので、閉じるのは呼び出し側
fn build_pipeline(
    fd: RawFd,
    node: u32,
    tx: SyncSender<RawFrame>,
    settings: Arc<Mutex<Settings>>,
) -> Result<gst::Pipeline, CaptureError> {
    gst::init().map_err(|e| CaptureError::unavailable(format!("GStreamer を使えません: {e}")))?;
    for name in ["pipewiresrc", "videoconvert", "appsink"] {
        if gst::ElementFactory::find(name).is_none() {
            return Err(CaptureError::unavailable(format!(
                "GStreamer の要素 {name} がありません（gstreamer1.0-pipewire と gstreamer1.0-plugins-base を入れてください）"
            )));
        }
    }
    let fail = |what: &str, e: &dyn std::fmt::Display| CaptureError::failed(format!("{what}: {e}"));

    let src = gst::ElementFactory::make("pipewiresrc")
        .property("fd", fd)
        .property("path", node.to_string())
        .property("do-timestamp", true)
        .build()
        .map_err(|e| fail("pipewiresrc を作れません", &e))?;

    let convert = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| fail("videoconvert を作れません", &e))?;
    // VideoFrame で実際の stride を読む（PipeWire / DMA-BUF の行の詰め物も扱う）
    let sink = gst_app::AppSink::builder()
        .caps(
            &gst::Caps::builder("video/x-raw")
                .field("format", "RGBx")
                .build(),
        )
        .max_buffers(1)
        .drop(true)
        .sync(false)
        .build();
    let mut next_slot: Option<Instant> = None;
    sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Error)?;
                let fps = lock_settings(&settings).fps;
                if !take_slot(
                    &mut next_slot,
                    Instant::now(),
                    Duration::from_secs_f64(1.0 / fps),
                ) {
                    return Ok(gst::FlowSuccess::Ok);
                }
                let (Some(caps), Some(buffer)) = (sample.caps(), sample.buffer()) else {
                    return Ok(gst::FlowSuccess::Ok);
                };
                let info =
                    gst_video::VideoInfo::from_caps(caps).map_err(|_| gst::FlowError::Error)?;
                let video = gst_video::VideoFrameRef::from_buffer_ref_readable(buffer, &info)
                    .map_err(|_| gst::FlowError::Error)?;
                let w = video.width() as usize;
                let h = video.height() as usize;
                let stride =
                    usize::try_from(video.plane_stride()[0]).map_err(|_| gst::FlowError::Error)?;
                let plane = video.plane_data(0).map_err(|_| gst::FlowError::Error)?;
                let data = pack_rgbx(plane, w, h, stride).ok_or(gst::FlowError::Error)?;
                // 受け手が詰まっていれば捨てる（映像を溜めない）
                let _ = tx.try_send(RawFrame {
                    width: w,
                    height: h,
                    data,
                });
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    let sink_el = sink.upcast_ref::<gst::Element>();
    let pipeline = gst::Pipeline::new();
    pipeline
        .add_many([&src, &convert, sink_el])
        .map_err(|e| fail("パイプラインを組めません", &e))?;
    gst::Element::link_many([&src, &convert, sink_el])
        .map_err(|e| fail("パイプラインをつなげません", &e))?;

    if pipeline.set_state(gst::State::Playing).is_err() {
        let _ = pipeline.set_state(gst::State::Null);
        return Err(CaptureError::failed("画面の取り込みを始められません"));
    }
    let (state, _, _) = pipeline.state(gst::ClockTime::from_seconds(5));
    if state.is_err() {
        let _ = pipeline.set_state(gst::State::Null);
        return Err(CaptureError::failed(
            "画面の取り込みを始められません（再生の開始に失敗）",
        ));
    }
    Ok(pipeline)
}

/// 最初の実際のフレームを待つ。キャンセル・ソースの失敗・無応答を区別する
fn wait_first_frame(
    pipeline: &gst::Pipeline,
    rx: &Receiver<RawFrame>,
    cancel: &CancellationToken,
) -> Result<RawFrame, CaptureError> {
    let started = Instant::now();
    let bus = pipeline.bus();
    loop {
        if cancel.is_cancelled() {
            return Err(CaptureError::cancelled());
        }
        if let Some(msg) = bus.as_ref().and_then(|b| {
            b.timed_pop_filtered(
                Some(gst::ClockTime::ZERO),
                &[gst::MessageType::Error, gst::MessageType::Eos],
            )
        }) {
            return Err(match msg.view() {
                gst::MessageView::Error(e) => {
                    CaptureError::failed(format!("画面を取得できません: {}", e.error()))
                }
                _ => CaptureError::failed("画面の取得が終了しました"),
            });
        }
        match rx.recv_timeout(Duration::from_millis(POLL_MS)) {
            Ok(frame) => return Ok(frame),
            Err(RecvTimeoutError::Disconnected) => {
                return Err(CaptureError::failed("画面の取得が終了しました"))
            }
            Err(RecvTimeoutError::Timeout) if started.elapsed() >= Duration::from_secs(8) => {
                return Err(CaptureError::failed("画面の映像が届きません（portal / PipeWire）。共有を止めて、もう一度試してください"));
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

/// 停止・置き換えと同時に古い映像を送り出さない（イベント自体にもホストの世代を付ける）
fn emit_active(shared: &Shared, id: u64, window: &WebviewWindow, payload: &FramePayload) -> bool {
    let inner = lock(shared);
    if !inner
        .active
        .as_ref()
        .is_some_and(|a| a.id == id && !a.stop.load(Ordering::SeqCst))
    {
        return false;
    }
    let _ = window.emit(EVENT_FRAME, payload);
    true
}

// ---- 付随するスレッド・タスク ----

/// GStreamer のバスを見て、映像の終わりとエラーを知らせる
fn run_bus(shared: Arc<Shared>, id: u64, pipeline: gst::Pipeline, stop: Arc<AtomicBool>) {
    let Some(bus) = pipeline.bus() else {
        finish(&shared, id, "error", Some("バスがありません".into()));
        return;
    };
    while !stop.load(Ordering::SeqCst) {
        let timeout = Some(gst::ClockTime::from_mseconds(POLL_MS));
        let Some(msg) =
            bus.timed_pop_filtered(timeout, &[gst::MessageType::Error, gst::MessageType::Eos])
        else {
            continue;
        };
        match msg.view() {
            gst::MessageView::Eos(_) => {
                finish(&shared, id, "source-ended", None);
                return;
            }
            gst::MessageView::Error(e) => {
                finish(&shared, id, "error", Some(e.error().to_string()));
                return;
            }
            _ => {}
        }
    }
}

/// portal のセッションが閉じられたら（利用者が共有を止めた・portal が終えた）知らせる。
/// 購読はこのタスクの中で行う（購読の戻り値はセッションを借りるため、タスクの中に置く）
fn spawn_closed_watch(
    shared: Arc<Shared>,
    id: u64,
    session: Arc<Session<Screencast>>,
    stop: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        let Ok(closed) = session.receive_closed().await else {
            finish(
                &shared,
                id,
                "error",
                Some("portal の切断を監視できません".into()),
            );
            return;
        };
        let mut closed = std::pin::pin!(closed.map(|_| ()));
        while !stop.load(Ordering::SeqCst) {
            match tokio::time::timeout(Duration::from_millis(POLL_MS), closed.next()).await {
                Err(_) => continue,
                Ok(_) => {
                    finish(&shared, id, "portal-closed", None);
                    return;
                }
            }
        }
    });
}

/// 受け取った映像を、fps・変化・縮小・減色・JPEG にして送る。変わらないときは keepaliveMs ごとに直前の 1 枚を送り直す
fn run_worker(
    window: WebviewWindow,
    rx: Receiver<RawFrame>,
    settings: Arc<Mutex<Settings>>,
    stop: Arc<AtomicBool>,
    shared: Arc<Shared>,
    id: u64,
    capture_id: u64,
) {
    let mut prev_thumb: Option<Vec<u8>> = None;
    let mut last: Option<FramePayload> = None;
    let mut last_raw: Option<RawFrame> = None;
    let mut applied: Option<Settings> = None;
    let mut sent_at: Option<Instant> = None;
    while !stop.load(Ordering::SeqCst) {
        let s = *lock_settings(&settings);
        let settings_changed = applied != Some(s);
        let keep = Duration::from_millis(s.keepalive_ms);
        let wait = match sent_at {
            Some(t) => keep.saturating_sub(t.elapsed()),
            None => keep,
        }
        .min(Duration::from_millis(POLL_MS));
        let incoming = match rx.recv_timeout(wait) {
            Ok(raw) => {
                last_raw = Some(raw);
                true
            }
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => {
                finish(&shared, id, "source-ended", None);
                return;
            }
        };
        // 品質・縮小の変更は、画面が静止している間も効かせる
        if settings_changed {
            prev_thumb = None;
        }
        if let Some(raw) = last_raw.as_ref().filter(|_| incoming || settings_changed) {
            match prepare_frame(&raw.data, raw.width, raw.height, &s, prev_thumb.as_deref()) {
                Ok(Some(enc)) => {
                    let payload = FramePayload {
                        capture_id,
                        data: base64::engine::general_purpose::STANDARD.encode(&enc.jpeg),
                        mime: "image/jpeg",
                        width: enc.width,
                        height: enc.height,
                    };
                    if !emit_active(&shared, id, &window, &payload) {
                        return;
                    }
                    last = Some(payload);
                    prev_thumb = Some(enc.thumb);
                    sent_at = Some(Instant::now());
                }
                Ok(None) => {}
                Err(message) => {
                    finish(&shared, id, "error", Some(message));
                    return;
                }
            }
        }
        applied = Some(s);
        if let (Some(payload), Some(t)) = (&last, sent_at) {
            if t.elapsed() >= keep {
                if !emit_active(&shared, id, &window, payload) {
                    return;
                }
                sent_at = Some(Instant::now());
            }
        }
    }
}

// ---- 開始・停止 ----

/// 共有を始める（利用者が共有を押したときだけ呼ぶ）
async fn start_capture(
    window: WebviewWindow,
    shared: Arc<Shared>,
    opts: ScreenOptions,
) -> Result<(), CaptureError> {
    // ダイアログを出す前に、オプションを検査する
    let defaults = opts.apply(Settings::default())?;
    {
        // 共有中なら選び直さず、設定だけ更新する（選び直すには先に stop する）
        let inner = lock(&shared);
        if let Some(active) = inner.active.as_ref() {
            let mut s = lock_settings(&active.settings);
            *s = opts.apply(*s)?;
            return Ok(());
        }
    }

    let token = CancellationToken::new();
    // 途中の開始があれば取り消す（新しい開始が優先。古い方は cancelled になる）
    let id = {
        let mut inner = lock(&shared);
        inner.next_id += 1;
        let id = inner.next_id;
        if let Some((_, old)) = inner.pending.replace((id, token.clone())) {
            old.cancel();
        }
        id
    };

    let capture_id = opts.capture_id.unwrap_or(id);
    let negotiated = match negotiate(&token).await {
        Ok(n) => n,
        Err(e) => {
            let mut inner = lock(&shared);
            if inner.pending.as_ref().is_some_and(|(p, _)| *p == id) {
                inner.pending = None;
            }
            return Err(e);
        }
    };
    let Negotiated { session, node, fd } = negotiated;
    let session = Arc::new(session);

    let raw_fd = fd.as_raw_fd();
    let settings = Arc::new(Mutex::new(defaults));
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel::<RawFrame>(1);
    let built = {
        let settings = settings.clone();
        let cancel = token.clone();
        // 最初の 1 枚が取れるまで成功扱いにしない。取れない共有を「共有中」のまま残さない
        tauri::async_runtime::spawn_blocking(move || {
            let seed = tx.clone();
            let pipeline = build_pipeline(raw_fd, node, tx, settings)?;
            match wait_first_frame(&pipeline, &rx, &cancel) {
                Ok(first) => {
                    // 次のフレームがすでに入っていればそちらの方が新しいので、それを使う
                    let _ = seed.try_send(first);
                    Ok((pipeline, rx))
                }
                Err(e) => {
                    let _ = pipeline.set_state(gst::State::Null);
                    Err(e)
                }
            }
        })
        .await
    };
    let (pipeline, rx) = match built {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => return Err(abort_start(&shared, id, &session, e).await),
        Err(e) => {
            let e = CaptureError::failed(format!("画面の取り込みを始められません: {e}"));
            return Err(abort_start(&shared, id, &session, e).await);
        }
    };

    let active = Active {
        id,
        capture_id,
        window: window.clone(),
        session: session.clone(),
        fd,
        pipeline: pipeline.clone(),
        settings: settings.clone(),
        stop: stop.clone(),
    };
    // 取り消されていれば、登録せずに片付ける（ロックは await の前に離す）
    let registered = {
        let mut inner = lock(&shared);
        if inner.pending.as_ref().is_some_and(|(p, _)| *p == id) {
            inner.pending = None;
        }
        if token.is_cancelled() {
            Err(active)
        } else {
            Ok(inner.active.replace(active))
        }
    };
    match registered {
        Ok(Some(old)) => retire(old, "replaced", None),
        Ok(None) => {}
        Err(active) => {
            let session = active.stop_capture();
            close_session(&session).await;
            return Err(CaptureError::cancelled());
        }
    }

    spawn_closed_watch(shared.clone(), id, session.clone(), stop.clone());
    let bus = {
        let (shared, stop, pipeline) = (shared.clone(), stop.clone(), pipeline.clone());
        std::thread::Builder::new()
            .name("disnans-screen-bus".into())
            .spawn(move || run_bus(shared, id, pipeline, stop))
    };
    let worker = {
        let shared = shared.clone();
        std::thread::Builder::new()
            .name("disnans-screen-worker".into())
            .spawn(move || run_worker(window, rx, settings, stop, shared, id, capture_id))
    };
    if bus.is_err() || worker.is_err() {
        finish(&shared, id, "error", Some("スレッドを作れません".into()));
        return Err(CaptureError::failed("画面の取得のスレッドを作れません"));
    }
    Ok(())
}

/// 共有を止める（共有していなければ何もしない）。開始の途中なら、その開始を cancelled にする
async fn stop_capture(shared: &Shared) {
    let (pending, active) = {
        let mut inner = lock(shared);
        (inner.pending.take(), inner.active.take())
    };
    if let Some((_, token)) = pending {
        token.cancel();
    }
    if let Some(active) = active {
        retire(active, "stopped", None);
    }
}

// ---- コマンド ----

/// 画面の共有を始める。portal が画面の選択ダイアログを出す（この呼び出しが利用者の操作から来たときだけ使う）。
/// 既に共有中なら、画面は選び直さずに設定だけ更新する。
#[tauri::command]
pub async fn linux_screen_start(
    window: WebviewWindow,
    state: State<'_, LinuxScreenState>,
    options: Option<ScreenOptions>,
) -> Result<(), CaptureError> {
    start_capture(window, state.shared.clone(), options.unwrap_or_default()).await
}

/// 画面の共有を止める（共有していなくても、エラーにはしない）
#[tauri::command]
pub async fn linux_screen_stop(state: State<'_, LinuxScreenState>) -> Result<(), CaptureError> {
    stop_capture(&state.shared).await;
    Ok(())
}

/// 共有中の設定（maxEdge・fps・quality・color・diffThreshold・keepaliveMs）を変える。次のフレームから効く
#[tauri::command]
pub fn linux_screen_update(
    state: State<'_, LinuxScreenState>,
    options: ScreenOptions,
) -> Result<(), CaptureError> {
    let inner = lock(&state.shared);
    let active = inner
        .active
        .as_ref()
        .ok_or_else(CaptureError::not_running)?;
    let mut s = lock_settings(&active.settings);
    *s = options.apply(*s)?;
    Ok(())
}

impl LinuxScreenState {
    /// 共有を止める（同期）。開始の途中なら取り消す。アプリの終了で呼ぶ（Drop からも呼ばれる）。
    /// portal のセッションを閉じるのは背景で（終了が先に来ても、portal は接続が切れたときに片付ける）
    pub fn shutdown(&self) {
        let (pending, active) = {
            let mut inner = lock(&self.shared);
            (inner.pending.take(), inner.active.take())
        };
        if let Some((_, token)) = pending {
            token.cancel();
        }
        if let Some(active) = active {
            let session = active.stop_capture();
            tauri::async_runtime::spawn(async move { close_session(&session).await });
        }
    }
}

impl Drop for LinuxScreenState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgbx(px: &[[u8; 3]]) -> Vec<u8> {
        px.iter().flat_map(|p| [p[0], p[1], p[2], 0]).collect()
    }

    #[test]
    fn padded_rows_are_packed_and_invalid_sizes_rejected() {
        let rows = vec![
            1, 2, 3, 0, 4, 5, 6, 0, 99, 99, 99, 99, 7, 8, 9, 0, 10, 11, 12, 0,
        ];
        assert_eq!(
            pack_rgbx(&rows, 2, 2, 12).unwrap(),
            vec![1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0]
        );
        assert!(pack_rgbx(&rows[..19], 2, 2, 12).is_none());
        assert!(pack_rgbx(&rows, 2, 2, 4).is_none());
        assert!(pack_rgbx(&rows, usize::MAX, 2, 12).is_none());
        assert!(pack_rgbx(&rows, 2, 0, 12).is_none());
    }

    #[test]
    fn first_frame_wait_handles_frame_cancel_and_disconnect_without_capture() {
        gst::init().unwrap();
        let pipeline = gst::Pipeline::new();
        let (tx, rx) = mpsc::sync_channel(1);
        let cancel = CancellationToken::new();
        tx.send(RawFrame {
            width: 1,
            height: 1,
            data: vec![1, 2, 3, 0],
        })
        .unwrap();
        assert_eq!(
            wait_first_frame(&pipeline, &rx, &cancel).unwrap().data,
            vec![1, 2, 3, 0]
        );
        cancel.cancel();
        assert_eq!(
            wait_first_frame(&pipeline, &rx, &cancel)
                .err()
                .unwrap()
                .code,
            "cancelled"
        );
        drop(tx);
        assert_eq!(
            wait_first_frame(&pipeline, &rx, &CancellationToken::new())
                .err()
                .unwrap()
                .code,
            "failed"
        );
    }

    #[test]
    fn scale_patch_is_relative_to_original_edge_not_compounded() {
        let base = Settings {
            max_edge: 400,
            ..Settings::default()
        };
        let patch = ScreenOptions {
            scale: Some(0.5),
            ..Default::default()
        };
        let once = patch.apply(base).unwrap();
        let twice = patch.apply(once).unwrap();
        assert_eq!(once, twice);
        assert_eq!(twice.max_edge, 400);
        let data = vec![100; 400 * 200 * 4];
        let encoded = prepare_frame(&data, 400, 200, &twice, None)
            .unwrap()
            .unwrap();
        assert_eq!((encoded.width, encoded.height), (200, 100));
    }

    #[test]
    fn options_are_clamped_and_defaulted() {
        let base = Settings::default();
        let s = ScreenOptions::default().apply(base).unwrap();
        assert_eq!(s, base);

        let s = ScreenOptions {
            max_edge: Some(10_000.0),
            fps: Some(0.0),
            quality: Some(7.0),
            diff_threshold: Some(-3.0),
            keepalive_ms: Some(1.0),
            ..Default::default()
        }
        .apply(base)
        .unwrap();
        assert_eq!(s.max_edge, 3840);
        assert_eq!(s.fps, 1.0);
        assert_eq!(s.quality, 1.0);
        assert_eq!(s.diff_threshold, 0.0);
        assert_eq!(s.keepalive_ms, 500);

        let s = ScreenOptions {
            max_edge: Some(1.0),
            fps: Some(999.0),
            quality: Some(0.0),
            ..Default::default()
        }
        .apply(base)
        .unwrap();
        assert_eq!((s.max_edge, s.fps, s.quality), (160, 30.0, 0.1));
    }

    #[test]
    fn options_reject_unknown_format_and_color() {
        let e = ScreenOptions {
            format: Some("webp".into()),
            ..Default::default()
        }
        .apply(Settings::default())
        .unwrap_err();
        assert_eq!(e.code, "invalid");
        let e = ScreenOptions {
            color: Some("sepia".into()),
            ..Default::default()
        }
        .apply(Settings::default())
        .unwrap_err();
        assert_eq!(e.code, "invalid");
        let s = ScreenOptions {
            format: Some("jpeg".into()),
            color: Some("c256".into()),
            ..Default::default()
        }
        .apply(Settings::default())
        .unwrap();
        assert_eq!(s.color, Color::C256);
    }

    #[test]
    fn fit_keeps_aspect_and_never_upscales() {
        assert_eq!(fit_size(3840, 2160, 1280), (1280, 720));
        assert_eq!(fit_size(720, 1280, 640), (360, 640));
        assert_eq!(fit_size(800, 600, 1280), (800, 600));
        assert_eq!(fit_size(1, 100_000, 160), (1, 160));
    }

    #[test]
    fn downscale_averages_blocks() {
        // 2×2 → 1×1 の平均
        let src = rgbx(&[[0, 0, 0], [100, 0, 0], [0, 200, 0], [100, 200, 255]]);
        assert_eq!(downscale_rgb(&src, 2, 2, 1, 1), vec![50, 100, 64]);
        // 同じ大きさなら画素はそのまま
        let same = downscale_rgb(&src, 2, 2, 2, 2);
        assert_eq!(same, vec![0, 0, 0, 100, 0, 0, 0, 200, 0, 100, 200, 255]);
    }

    #[test]
    fn span_covers_every_source_pixel_once() {
        for (sw, dw) in [(1920usize, 64usize), (7, 3), (3, 7), (5, 5)] {
            let mut next = 0;
            for i in 0..dw {
                let (a, b) = span(i, dw, sw);
                assert!(b > a && b <= sw);
                if sw >= dw {
                    assert_eq!(a, next, "gap at {i}");
                    next = b;
                }
            }
            if sw >= dw {
                assert_eq!(next, sw);
            }
        }
    }

    #[test]
    fn quantize_keeps_bins_and_luma_matches_white_and_black() {
        let mut px = vec![255, 255, 255, 0, 0, 0];
        quantize_332(&mut px);
        assert_eq!(px, vec![0xF0, 0xF0, 0xE0, 0x10, 0x10, 0x20]);
        assert_eq!(to_luma(&[255, 255, 255, 0, 0, 0]), vec![255, 0]);
    }

    #[test]
    fn change_detection_uses_mean_and_peak() {
        let a = vec![10u8; 30];
        assert!(!changed(&a, &a, 0.0));
        // 全体に 1 ずつの差: 平均 1 は 1.5 以下
        let b: Vec<u8> = a.iter().map(|v| v + 1).collect();
        assert!(!changed(&a, &b, 1.5));
        assert!(changed(&a, &b, 0.5));
        // 1 画素だけ大きく変わった（平均は小さい）
        let mut c = a.clone();
        c[0..3].copy_from_slice(&[200, 200, 200]);
        assert!(changed(&a, &c, 100.0));
        // 形が違うものは変わったとみなす
        assert!(changed(&a, &a[..3], 1.5));
    }

    #[test]
    fn pacer_averages_to_the_requested_rate() {
        // 30 fps の源を 1 秒流したとき、25 fps の設定では約 25 枚、5 fps では 5 枚になる
        for (fps, expect) in [(25.0f64, 25i32), (5.0, 5), (30.0, 30), (7.0, 7)] {
            let t0 = Instant::now();
            let interval = Duration::from_secs_f64(1.0 / fps);
            let mut next = None;
            let n = (0..=30)
                .filter(|i| take_slot(&mut next, t0 + Duration::from_micros(33_333 * i), interval))
                .count() as i32;
            assert!((n - expect).abs() <= 1, "fps {fps}: {n}");
        }
    }

    #[test]
    fn jpeg_quality_range() {
        assert_eq!(jpeg_quality(0.6), 60);
        assert_eq!(jpeg_quality(0.0), 1);
        assert_eq!(jpeg_quality(1.0), 100);
    }

    #[test]
    fn prepare_frame_encodes_then_skips_unchanged() {
        let s = Settings {
            max_edge: 160,
            ..Settings::default()
        };
        let frame: Vec<u8> = (0..8 * 4 * 4).map(|i| (i % 251) as u8).collect();
        let first = prepare_frame(&frame, 8, 4, &s, None)
            .unwrap()
            .expect("最初は必ず送る");
        assert_eq!((first.width, first.height), (8, 4));
        assert_eq!(&first.jpeg[..2], &[0xFF, 0xD8], "JPEG の SOI");
        assert!(prepare_frame(&frame, 8, 4, &s, Some(&first.thumb))
            .unwrap()
            .is_none());
        assert!(prepare_frame(&frame[..10], 8, 4, &s, None).is_err());
    }

    #[test]
    fn prepare_frame_gray_and_c256_are_jpeg() {
        let frame = rgbx(&[[10, 200, 30]; 16]);
        for color in [Color::Gray, Color::C256] {
            let s = Settings {
                color,
                ..Settings::default()
            };
            let e = prepare_frame(&frame, 4, 4, &s, None).unwrap().unwrap();
            assert_eq!(&e.jpeg[..2], &[0xFF, 0xD8]);
        }
    }

    #[test]
    fn errors_serialize_as_code_and_message() {
        let v = serde_json::to_value(CaptureError::cancelled()).unwrap();
        assert_eq!(v["code"], "cancelled");
        assert!(v["message"].as_str().unwrap().contains("キャンセル"));
    }

    #[test]
    fn portal_errors_map_to_codes() {
        assert_eq!(
            portal_error(ashpd::Error::Response(ResponseError::Cancelled)).code,
            "cancelled"
        );
        assert_eq!(
            portal_error(ashpd::Error::Response(ResponseError::Other)).code,
            "failed"
        );
        assert_eq!(
            portal_error(ashpd::Error::RequiresVersion(4, 3)).code,
            "unavailable"
        );
    }
}
