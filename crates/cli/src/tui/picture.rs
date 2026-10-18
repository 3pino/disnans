//! 画像のデコード・縮小・平均色。ターミナルへ出す前の下ごしらえ（ターミナルには依存しない）。

use std::io::Cursor;

use image::imageops::FilterType;
use image::{ImageFormat, RgbaImage};

/// アバターは正方形に切り抜いてこの大きさにする。
const AVATAR_PX: u32 = 64;
/// サムネイルはこの長さに収める（元が小さければそのまま）。
const THUMB_MAX_PX: u32 = 320;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Avatar,
    Thumb,
}

#[derive(Clone)]
pub struct Prepared {
    pub png: Vec<u8>,
    pub rgba: RgbaImage,
    /// アバターの平均色を、暗い背景で読めるように明るさだけ調整したもの。
    pub color: (u8, u8, u8),
}

impl std::fmt::Debug for Prepared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Prepared({}x{})", self.rgba.width(), self.rgba.height())
    }
}

pub fn prepare(bytes: &[u8], kind: Kind) -> Result<Prepared, String> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(256 << 20);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|e| e.to_string())?;
    let resized = match kind {
        Kind::Avatar => decoded.resize_to_fill(AVATAR_PX, AVATAR_PX, FilterType::Triangle),
        Kind::Thumb if decoded.width() > THUMB_MAX_PX || decoded.height() > THUMB_MAX_PX => {
            decoded.resize(THUMB_MAX_PX, THUMB_MAX_PX, FilterType::Triangle)
        }
        Kind::Thumb => decoded,
    };
    let rgba = resized.to_rgba8();
    let color = readable(average(&rgba));
    let png = encode_png(&rgba)?;
    Ok(Prepared { png, rgba, color })
}

fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// 縦方向 `start/total` 〜 `end/total` の範囲を切り出した PNG。
pub fn crop_png(image: &RgbaImage, start: u16, end: u16, total: u16) -> Result<Vec<u8>, String> {
    let h = image.height();
    let total = u32::from(total.max(1));
    let y0 = (h * u32::from(start) / total).min(h.saturating_sub(1));
    let y1 = (h * u32::from(end) / total).clamp(y0 + 1, h);
    let part = image::imageops::crop_imm(image, 0, y0, image.width(), y1 - y0).to_image();
    encode_png(&part)
}

/// 不透明度で重みづけした平均色。透明ばかりなら灰色。
fn average(image: &RgbaImage) -> (u8, u8, u8) {
    let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
    for p in image.pixels() {
        let a = u64::from(p[3]);
        r += u64::from(p[0]) * a;
        g += u64::from(p[1]) * a;
        b += u64::from(p[2]) * a;
        n += a;
    }
    if n == 0 {
        return (128, 128, 128);
    }
    ((r / n) as u8, (g / n) as u8, (b / n) as u8)
}

/// 色相と彩度は保ち、明るさだけを 0.62〜0.80 に収める（暗い背景の文字として読める範囲）。
pub fn readable((r, g, b): (u8, u8, u8)) -> (u8, u8, u8) {
    let (h, s, l) = rgb_to_hsl(r, g, b);
    hsl_to_rgb(h, s.min(0.85), l.clamp(0.62, 0.80))
}

fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let (r, g, b) = (
        f32::from(r) / 255.0,
        f32::from(g) / 255.0,
        f32::from(b) / 255.0,
    );
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d == 0.0 {
        return (0.0, 0.0, l);
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let h = if max == r {
        ((g - b) / d).rem_euclid(6.0)
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0, s, l)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0).rem_euclid(2.0) - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match (h / 60.0) as u32 % 6 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let to = |v: f32| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    (to(r), to(g), to(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, px: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, image::Rgba(px))
    }

    #[test]
    fn average_ignores_transparent_pixels() {
        let mut img = solid(2, 1, [200, 0, 0, 255]);
        img.put_pixel(1, 0, image::Rgba([0, 255, 0, 0]));
        assert_eq!(average(&img), (200, 0, 0));
        assert_eq!(average(&solid(1, 1, [9, 9, 9, 0])), (128, 128, 128));
    }

    #[test]
    fn readable_color_is_lifted_but_keeps_the_hue() {
        // 暗い青は明るくなり、青のまま。
        let (r, g, b) = readable((0, 0, 80));
        assert!(b > 150 && b > r && b > g, "{r},{g},{b}");
        // 明るすぎる色は抑える。
        let (r, g, b) = readable((255, 255, 255));
        assert!(r < 230 && g < 230 && b < 230);
        // 黒でも文字として読める明るさになる。
        let (r, ..) = readable((0, 0, 0));
        assert!(r > 130);
    }

    #[test]
    fn prepare_makes_square_avatars_and_bounds_thumbnails() {
        let mut src = Vec::new();
        solid(300, 100, [10, 200, 30, 255])
            .write_to(&mut Cursor::new(&mut src), ImageFormat::Png)
            .unwrap();
        let avatar = prepare(&src, Kind::Avatar).unwrap();
        assert_eq!((avatar.rgba.width(), avatar.rgba.height()), (64, 64));
        let mut big = Vec::new();
        solid(800, 400, [1, 2, 3, 255])
            .write_to(&mut Cursor::new(&mut big), ImageFormat::Png)
            .unwrap();
        let thumb = prepare(&big, Kind::Thumb).unwrap();
        assert_eq!((thumb.rgba.width(), thumb.rgba.height()), (320, 160));
        assert!(prepare(b"not an image", Kind::Thumb).is_err());
    }

    #[test]
    fn crop_keeps_at_least_one_row_and_stays_in_range() {
        let img = solid(10, 40, [1, 1, 1, 255]);
        let png = crop_png(&img, 1, 3, 4).unwrap();
        let cropped = image::load_from_memory(&png).unwrap();
        assert_eq!((cropped.width(), cropped.height()), (10, 20));
        assert!(crop_png(&img, 3, 3, 4).is_ok());
        assert!(crop_png(&img, 9, 12, 4).is_ok());
    }
}
