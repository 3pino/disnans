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
fn luma_matches_white_and_black() {
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
    assert!(
        prepare_frame(&frame, 8, 4, &s, Some(&first.thumb))
            .unwrap()
            .is_none()
    );
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
