//! 画像の変換（SPEC 4.4）。CPU を使うので、呼び出し側で `spawn_blocking` すること。
//!
//! - 静止画: 回転情報を反映し、長辺 2560px 以下に縮小して、非可逆 WebP（品質 85）にする。
//!   作り直すので EXIF などのメタデータは残らない
//! - アニメーション（GIF / WebP / APNG）: 変換しない。サムネイルだけ最初のフレームから作る
//! - サムネイル: 長辺 480px の WebP

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use image::codecs::gif::GifDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::webp::WebPDecoder;
use image::imageops::FilterType;
use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader, ImageResult};

pub const MAX_EDGE: u32 = 2560;
pub const THUMB_EDGE: u32 = 480;
pub const QUALITY: f32 = 85.0;

/// アップロードされたファイルの種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 変換する静止画。
    Still(ImageFormat),
    /// そのまま保存するアニメーション。
    Animated(ImageFormat),
    /// 画像ではない（または扱えない形式）。
    Other,
}

/// 変換した画像（WebP のバイト列）。
pub struct Encoded {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// ファイルの中身を見て、種類を判定する（拡張子や Content-Type は信用しない）。
pub fn detect(path: &Path) -> Kind {
    let format = ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .ok()
        .and_then(|r| r.format());
    let Some(format) = format else {
        return Kind::Other;
    };

    match format {
        ImageFormat::Gif | ImageFormat::WebP | ImageFormat::Png => {
            match is_animated(path, format) {
                Ok(true) => Kind::Animated(format),
                Ok(false) => Kind::Still(format),
                Err(_) => Kind::Other,
            }
        }
        ImageFormat::Jpeg | ImageFormat::Bmp | ImageFormat::Tiff => Kind::Still(format),
        _ => Kind::Other,
    }
}

fn is_animated(path: &Path, format: ImageFormat) -> ImageResult<bool> {
    let reader = BufReader::new(File::open(path)?);
    Ok(match format {
        ImageFormat::Gif => GifDecoder::new(reader)?.into_frames().take(2).count() > 1,
        ImageFormat::WebP => WebPDecoder::new(reader)?.has_animation(),
        ImageFormat::Png => PngDecoder::new(reader)?.is_apng()?,
        _ => false,
    })
}

/// 画像を読み込み、回転情報を反映する。アニメーションなら最初のフレームになる。
pub fn decode(path: &Path, format: ImageFormat) -> ImageResult<DynamicImage> {
    let reader = ImageReader::with_format(BufReader::new(File::open(path)?), format);
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}

/// 静止画を、保存用の WebP にする。
pub fn convert(image: &DynamicImage) -> Result<Encoded, String> {
    let resized;
    let image = if image.width().max(image.height()) > MAX_EDGE {
        resized = image.resize(MAX_EDGE, MAX_EDGE, FilterType::Lanczos3);
        &resized
    } else {
        image
    };
    encode_webp(image)
}

/// サムネイル（長辺 480px 以下の WebP）を作る。
pub fn thumbnail(image: &DynamicImage) -> Result<Encoded, String> {
    if image.width().max(image.height()) > THUMB_EDGE {
        encode_webp(&image.thumbnail(THUMB_EDGE, THUMB_EDGE))
    } else {
        encode_webp(image)
    }
}

/// 非可逆 WebP にする（image クレートのエンコーダーは可逆しか作れないので libwebp を使う）。
fn encode_webp(image: &DynamicImage) -> Result<Encoded, String> {
    let (width, height) = (image.width(), image.height());
    let encoded = if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        webp::Encoder::from_rgba(&rgba, width, height).encode_simple(false, QUALITY)
    } else {
        let rgb = image.to_rgb8();
        webp::Encoder::from_rgb(&rgb, width, height).encode_simple(false, QUALITY)
    }
    .map_err(|e| format!("WebP にできませんでした（{width}x{height}）: {e:?}"))?;
    Ok(Encoded {
        data: encoded.to_vec(),
        width,
        height,
    })
}
