//! 256 色の代表色（メディアンカット）。JS の app/src/lib/call/screen/quantize.ts と Kotlin の ScreenQuantizer と同じ計算。
//! 同じ golden（plugins/screen/android/src/test/resources/screen-quantize/quantize-v1.json）で確かめる。
//! 決定的で有界: 標本は最大 SAMPLE_MAX 画素（等間隔）、分割は広い軸の中央、平均は整数の四捨五入、
//! 画素から代表色へは 5 bit ずつのキャッシュ（32768 × 256 まで）。色相の保証はしない（TS 側と同じ）。
//! 純粋な計算だけ（Tauri・GStreamer に依存しない）。linux_capture.rs から #[path] で読む。

pub const PALETTE_MAX: usize = 256;
pub const SAMPLE_MAX: usize = 8192;
const CELLS: usize = 1 << 15;

/// 代表色（RGB の並び・長さ 3×色数）。画素がなければ空
pub fn palette_rgb(rgb: &[u8]) -> Vec<u8> {
    let n = rgb.len() / 3;
    if n == 0 {
        return Vec::new();
    }
    let step = n.div_ceil(SAMPLE_MAX).max(1);
    let m = n.div_ceil(step);
    let mut ch = [vec![0u8; m], vec![0u8; m], vec![0u8; m]];
    for (k, px) in rgb.chunks_exact(3).step_by(step).enumerate() {
        ch[0][k] = px[0];
        ch[1][k] = px[1];
        ch[2][k] = px[2];
    }
    let mut idx: Vec<usize> = (0..m).collect();

    let mut boxes = vec![make_box(&ch, &idx, 0, m)];
    while boxes.len() < PALETTE_MAX {
        // いちばん広く（範囲×画素数が最大）、割れるもの。同点は先の箱
        let mut best: Option<usize> = None;
        let mut best_score: i64 = -1;
        for (b, bx) in boxes.iter().enumerate() {
            if bx.hi - bx.lo < 2 || bx.range <= 0 {
                continue;
            }
            let score = i64::from(bx.range) * (bx.hi - bx.lo) as i64;
            if score > best_score {
                best_score = score;
                best = Some(b);
            }
        }
        let Some(b) = best else { break };
        let bx = boxes[b];
        let v = &ch[bx.axis];
        let mut part: Vec<usize> = idx[bx.lo..bx.hi].to_vec();
        // 値と番号の全順序（番号は一意）なので、並べ替えの結果は一つに決まる
        part.sort_unstable_by_key(|&s| (v[s], s));
        idx[bx.lo..bx.hi].copy_from_slice(&part);
        let mid = bx.lo + ((bx.hi - bx.lo) >> 1);
        boxes[b] = make_box(&ch, &idx, bx.lo, mid);
        boxes.push(make_box(&ch, &idx, mid, bx.hi));
    }

    let mut palette = Vec::with_capacity(boxes.len() * 3);
    for bx in &boxes {
        let mut sums = [0u64; 3];
        for &s in &idx[bx.lo..bx.hi] {
            for (c, sum) in sums.iter_mut().enumerate() {
                *sum += u64::from(ch[c][s]);
            }
        }
        let cnt = (bx.hi - bx.lo) as u64;
        for sum in sums {
            palette.push(round_mean(sum, cnt));
        }
    }
    palette
}

/// RGB の画素を、代表色のいちばん近いものに置き換える（その場で書き換える）
pub fn quantize_rgb(rgb: &mut [u8]) {
    let palette = palette_rgb(rgb);
    let count = palette.len() / 3;
    if count == 0 {
        return;
    }
    let mut cache = vec![u16::MAX; CELLS];
    for px in rgb.chunks_exact_mut(3) {
        let key = (usize::from(px[0] >> 3) << 10)
            | (usize::from(px[1] >> 3) << 5)
            | usize::from(px[2] >> 3);
        if cache[key] == u16::MAX {
            cache[key] = nearest(&palette, cell_centre(key)) as u16;
        }
        let q = usize::from(cache[key]) * 3;
        px.copy_from_slice(&palette[q..q + 3]);
    }
}

#[derive(Clone, Copy)]
struct Bx {
    lo: usize,
    hi: usize,
    axis: usize,
    range: i32,
}

/// 箱の中で、いちばん広い軸（同点は R → G → B の順）と、その範囲
fn make_box(ch: &[Vec<u8>; 3], idx: &[usize], lo: usize, hi: usize) -> Bx {
    let mut axis = 0;
    let mut range: i32 = -1;
    for (c, v) in ch.iter().enumerate() {
        let mut min = 255u8;
        let mut max = 0u8;
        for &s in &idx[lo..hi] {
            min = min.min(v[s]);
            max = max.max(v[s]);
        }
        let r = i32::from(max) - i32::from(min);
        if r > range {
            range = r;
            axis = c;
        }
    }
    Bx {
        lo,
        hi,
        axis,
        range,
    }
}

/// 整数の平均（四捨五入。半分は上）。cnt は 1 以上・平均は 255 以下
fn round_mean(sum: u64, cnt: u64) -> u8 {
    ((2 * sum + cnt) / (2 * cnt)) as u8
}

/// 5 bit の段の中心の色（段の中の色は、この色で代表を選ぶ）
fn cell_centre(key: usize) -> [i32; 3] {
    [
        (((key >> 10) << 3) + 4) as i32,
        ((((key >> 5) & 31) << 3) + 4) as i32,
        (((key & 31) << 3) + 4) as i32,
    ]
}

/// 代表色のうち、色にいちばん近いもの（同点は番号の小さいほう）
fn nearest(palette: &[u8], c: [i32; 3]) -> usize {
    let mut best = 0;
    let mut best_d = i64::MAX;
    for (p, rgb) in palette.chunks_exact(3).enumerate() {
        let mut d = 0i64;
        for k in 0..3 {
            let diff = i64::from(i32::from(rgb[k]) - c[k]);
            d += diff * diff;
        }
        if d < best_d {
            best_d = d;
            best = p;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同じ golden（TS の quantize.test.ts・Kotlin の ScreenQuantizerTest も読む）
    const GOLDEN: &str = include_str!(
        "../plugins/screen/android/src/test/resources/screen-quantize/quantize-v1.json"
    );

    /// golden の入力（TS の synth・Kotlin の synth と同じ式。RGBA）
    fn synth(kind: &str, w: usize, h: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(w * h * 4);
        for i in 0..w * h {
            let (r, g, b, a) = match kind {
                "mixed" => (
                    (i * 37) & 255,
                    (i * 91 + 7) & 255,
                    160 + (i * 29) % 96,
                    if i % 5 == 0 { (i * 17) & 255 } else { 255 },
                ),
                "blue" => ((i * 7) & 63, (i * 5) & 63, 200 + (i * 3) % 56, 255),
                _ => (10, 20, 200, if i % 2 == 0 { 255 } else { 128 }),
            };
            out.extend_from_slice(&[r as u8, g as u8, b as u8, a as u8]);
        }
        out
    }

    /// TS の fnv と同じ（RGBA の順のバイトで FNV-1a 32 bit）
    fn fnv(bytes: &[u8]) -> String {
        let mut h: u32 = 0x811c_9dc5;
        for &b in bytes {
            h ^= u32::from(b);
            h = h.wrapping_mul(0x0100_0193);
        }
        format!("{h:08x}")
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn rgb_of(rgba: &[u8]) -> Vec<u8> {
        rgba.chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect()
    }

    #[test]
    fn matches_the_shared_golden() {
        let fx: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
        assert_eq!(fx["version"], 1);
        for c in fx["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let w = c["w"].as_u64().unwrap() as usize;
            let h = c["h"].as_u64().unwrap() as usize;
            let rgba = synth(c["kind"].as_str().unwrap(), w, h);
            let rgb = rgb_of(&rgba);
            assert_eq!(
                hex(&palette_rgb(&rgb)),
                c["palette"].as_str().unwrap(),
                "{name}: palette"
            );
            let mut q = rgb.clone();
            quantize_rgb(&mut q);
            let mut out = rgba.clone();
            for (p, o) in q.chunks_exact(3).zip(out.chunks_exact_mut(4)) {
                o[..3].copy_from_slice(p);
            }
            assert_eq!(fnv(&out), c["hash"].as_str().unwrap(), "{name}: output");
        }
    }

    #[test]
    fn empty_and_flat_frames() {
        assert!(palette_rgb(&[]).is_empty());
        let mut none: Vec<u8> = Vec::new();
        quantize_rgb(&mut none);
        let mut flat: Vec<u8> = [10u8, 20, 200].repeat(16);
        quantize_rgb(&mut flat);
        assert_eq!(flat, [10u8, 20, 200].repeat(16));
    }

    #[test]
    fn white_and_black_stay_exact() {
        let mut px = vec![255, 255, 255, 0, 0, 0];
        quantize_rgb(&mut px);
        assert_eq!(px, vec![255, 255, 255, 0, 0, 0]);
    }

    #[test]
    fn worst_case_720p_is_bounded() {
        // すべての画素がなるべく違う色（最悪に近い入力）。代表色は上限以内で、完了する
        let mut s: u32 = 11;
        let mut rgb = vec![0u8; 1280 * 720 * 3];
        for v in rgb.iter_mut() {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *v = (s >> 24) as u8;
        }
        assert!(palette_rgb(&rgb).len() / 3 <= PALETTE_MAX);
        quantize_rgb(&mut rgb);
        assert_eq!(rgb.len(), 1280 * 720 * 3);
    }
}
