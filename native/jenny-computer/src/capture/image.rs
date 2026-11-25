//! Pure picture logic for `capture`: pixel conversion, the client crop, the box downscale, PNG
//! encoding under a byte cap and the signature. No Windows types, so it builds and tests anywhere.

/// A tightly packed 8-bit RGBA picture, `width * height * 4` bytes, top row first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// A rectangle in physical screen pixels (the protocol's `rect`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// A region of a frame in frame pixels, never empty and never outside the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Why a picture could not be brought under its byte cap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FitError {
    /// Even the smallest size tried (long edge 64) was over the cap.
    TooLarge,
    /// The PNG encoder failed.
    Encode,
}

/// The final picture: its PNG bytes and the scaled pixels the PNG was made from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fitted {
    pub png: Vec<u8>,
    pub picture: Rgba,
}

/// Smallest long edge `fit_png` will shrink to before answering `too_large`.
pub const MIN_LONG_EDGE: u32 = 64;
/// Each retry multiplies the long edge by this (4 / 5).
const SHRINK_NUM: u64 = 4;
const SHRINK_DEN: u64 = 5;

/// Read BGRA rows of `row_pitch` bytes (the GPU's padded stride) into tightly packed RGBA.
/// `None` when the source is too short for the stated size or the pitch is under one row.
pub fn bgra_to_rgba(src: &[u8], width: u32, height: u32, row_pitch: usize) -> Option<Vec<u8>> {
    let row_bytes = (width as usize).checked_mul(4)?;
    if width == 0 || height == 0 || row_pitch < row_bytes {
        return None;
    }
    let mut out = Vec::with_capacity(row_bytes.checked_mul(height as usize)?);
    for row in 0..height as usize {
        let start = row.checked_mul(row_pitch)?;
        let line = src.get(start..start.checked_add(row_bytes)?)?;
        // Alpha is forced opaque: a window's capture can carry alpha below 255, and a model must
        // never be shown a transparent picture.
        for &[b, g, r, _a] in line.as_chunks::<4>().0 {
            out.extend_from_slice(&[r, g, b, 255]);
        }
    }
    Some(out)
}

/// The client area as a crop of the frame. The frame covers `bounds` (screen pixels) at
/// `frame_width / bounds.width` pixels per screen pixel, so each client edge is converted by
/// its own axis factor, rounded and clamped to the frame. `None` when `bounds` is empty or the
/// result is empty.
pub fn client_crop(
    frame_width: u32,
    frame_height: u32,
    bounds: Rect,
    client: Rect,
) -> Option<Crop> {
    if bounds.width <= 0 || bounds.height <= 0 || frame_width == 0 || frame_height == 0 {
        return None;
    }
    let sx = f64::from(frame_width) / f64::from(bounds.width);
    let sy = f64::from(frame_height) / f64::from(bounds.height);
    let edge = |offset: i64, factor: f64, limit: u32| -> u32 {
        let v = (offset as f64 * factor).round();
        v.clamp(0.0, f64::from(limit)) as u32
    };
    let left = edge(i64::from(client.x) - i64::from(bounds.x), sx, frame_width);
    let right = edge(
        i64::from(client.x) + i64::from(client.width) - i64::from(bounds.x),
        sx,
        frame_width,
    );
    let top = edge(i64::from(client.y) - i64::from(bounds.y), sy, frame_height);
    let bottom = edge(
        i64::from(client.y) + i64::from(client.height) - i64::from(bounds.y),
        sy,
        frame_height,
    );
    if right <= left || bottom <= top {
        return None;
    }
    Some(Crop {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

/// Cut `crop` out of `frame`. `None` when the crop is empty or outside the frame.
pub fn crop_pixels(frame: &Rgba, crop: Crop) -> Option<Rgba> {
    let x_end = crop.x.checked_add(crop.width)?;
    let y_end = crop.y.checked_add(crop.height)?;
    if crop.width == 0 || crop.height == 0 || x_end > frame.width || y_end > frame.height {
        return None;
    }
    let stride = frame.width as usize * 4;
    let mut data = Vec::with_capacity(crop.width as usize * crop.height as usize * 4);
    for row in crop.y..y_end {
        let start = row as usize * stride + crop.x as usize * 4;
        data.extend_from_slice(frame.data.get(start..start + crop.width as usize * 4)?);
    }
    Some(Rgba {
        width: crop.width,
        height: crop.height,
        data,
    })
}

/// Size after scaling the long edge down to `max_long_edge`, keeping the aspect ratio (each
/// side at least 1). Never larger than the input.
pub fn scaled_size(width: u32, height: u32, max_long_edge: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= max_long_edge || long == 0 {
        return (width, height);
    }
    let scale = |side: u32| -> u32 {
        let v =
            (u64::from(side) * u64::from(max_long_edge) + u64::from(long) / 2) / u64::from(long);
        (v as u32).max(1)
    };
    if width >= height {
        (max_long_edge, scale(height))
    } else {
        (scale(width), max_long_edge)
    }
}

/// For each destination index, the half-open source range its box covers.
fn box_ranges(source: usize, dest: usize) -> Vec<(usize, usize)> {
    (0..dest)
        .map(|d| {
            let start = d * source / dest;
            let end = ((d + 1) * source).div_ceil(dest).min(source);
            (start, end.max(start + 1).min(source))
        })
        .collect()
}

/// Scale down so the long edge is at most `max_long_edge`, averaging each destination pixel's
/// box of source pixels. A picture already small enough is returned unchanged.
pub fn box_downscale(src: &Rgba, max_long_edge: u32) -> Rgba {
    let (dw, dh) = scaled_size(src.width, src.height, max_long_edge);
    if (dw, dh) == (src.width, src.height) || src.width == 0 || src.height == 0 {
        return src.clone();
    }
    let (sw, sh) = (src.width as usize, src.height as usize);
    let (dw_u, dh_u) = (dw as usize, dh as usize);
    let rows: Vec<&[u8]> = src.data.chunks_exact(sw * 4).collect();
    let x_ranges = box_ranges(sw, dw_u);
    let y_ranges = box_ranges(sh, dh_u);
    let mut out = Vec::with_capacity(dw_u * dh_u * 4);
    let mut acc = vec![0u32; dw_u * 4];
    for &(y0, y1) in &y_ranges {
        acc.iter_mut().for_each(|v| *v = 0);
        for row in rows.get(y0..y1).unwrap_or(&[]) {
            for (slot, &(x0, x1)) in acc.as_chunks_mut::<4>().0.iter_mut().zip(&x_ranges) {
                let span = row.get(x0 * 4..x1 * 4).unwrap_or(&[]);
                for px in span.as_chunks::<4>().0 {
                    for (sum, &c) in slot.iter_mut().zip(px) {
                        *sum += u32::from(c);
                    }
                }
            }
        }
        for (slot, &(x0, x1)) in acc.as_chunks::<4>().0.iter().zip(&x_ranges) {
            let n = ((y1 - y0) * (x1 - x0)) as u32;
            for &sum in slot {
                out.push(((sum + n / 2) / n.max(1)) as u8);
            }
        }
    }
    Rgba {
        width: dw,
        height: dh,
        data: out,
    }
}

/// PNG, 8-bit RGBA.
pub fn encode_png(picture: &Rgba) -> Result<Vec<u8>, FitError> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, picture.width, picture.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|_| FitError::Encode)?;
    writer
        .write_image_data(&picture.data)
        .map_err(|_| FitError::Encode)?;
    writer.finish().map_err(|_| FitError::Encode)?;
    Ok(out)
}

/// Scale to `max_long_edge`, encode, and while the PNG is over `max_bytes` scale the long edge
/// by 0.8 again (always from `src`, never from the previous result). `TooLarge` when the long
/// edge would fall under 64.
pub fn fit_png(src: &Rgba, max_long_edge: u32, max_bytes: usize) -> Result<Fitted, FitError> {
    let mut edge = max_long_edge.min(src.width.max(src.height));
    loop {
        let picture = box_downscale(src, edge);
        let png = encode_png(&picture)?;
        if png.len() <= max_bytes {
            return Ok(Fitted { png, picture });
        }
        edge = (u64::from(edge) * SHRINK_NUM / SHRINK_DEN) as u32;
        if edge < MIN_LONG_EDGE {
            return Err(FitError::TooLarge);
        }
    }
}

/// The signature of RGBA bytes: 64-bit FNV-1a as 16 lowercase hex digits.
pub fn signature(rgba: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in rgba {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    /// A small deterministic xorshift generator, so the noise frames never change.
    fn noise(width: u32, height: u32, seed: u64) -> Rgba {
        let mut state = seed;
        let data = (0..width as usize * height as usize * 4)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect();
        Rgba {
            width,
            height,
            data,
        }
    }

    fn flat(width: u32, height: u32, px: [u8; 4]) -> Rgba {
        Rgba {
            width,
            height,
            data: px.repeat(width as usize * height as usize),
        }
    }

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn signature_is_stable_and_sees_one_changed_pixel() {
        // FNV-1a 64 of the empty input is the offset basis; of "a" is af63dc4c8601ec8c.
        assert_eq!(signature(&[]), "cbf29ce484222325");
        assert_eq!(signature(b"a"), "af63dc4c8601ec8c");
        let a = vec![7u8; 16];
        let mut b = a.clone();
        assert_eq!(signature(&a), signature(&a));
        b[9] = 8;
        assert_ne!(signature(&a), signature(&b));
        assert_eq!(signature(&a).len(), 16);
    }

    #[test]
    fn bgra_rows_with_padding_become_packed_rgba() {
        // 2 by 2 pixels, pitch 12 (8 bytes of pixels then 4 bytes of padding per row).
        let src = [
            1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99, //
            9, 10, 11, 12, 13, 14, 15, 16, 99, 99, 99, 99,
        ];
        let rgba = bgra_to_rgba(&src, 2, 2, 12).unwrap();
        assert_eq!(
            rgba,
            vec![3, 2, 1, 255, 7, 6, 5, 255, 11, 10, 9, 255, 15, 14, 13, 255]
        );
        // The last row need not carry its padding.
        assert!(bgra_to_rgba(&src[..20], 2, 2, 12).is_some());
        assert!(bgra_to_rgba(&src[..19], 2, 2, 12).is_none());
        assert!(bgra_to_rgba(&src, 2, 2, 4).is_none());
        assert!(bgra_to_rgba(&src, 0, 2, 12).is_none());
    }

    #[test]
    fn client_crop_uses_each_axis_scale_and_clamps() {
        // 100 percent: a 1 px border and a 31 px title bar.
        let bounds = rect(100, 50, 400, 300);
        let client = rect(101, 81, 398, 268);
        let crop = client_crop(400, 300, bounds, client).unwrap();
        assert_eq!(
            crop,
            Crop {
                x: 1,
                y: 31,
                width: 398,
                height: 268
            }
        );
        // The frame is twice as wide and 1.5 times as tall as the bounds.
        let crop = client_crop(800, 450, bounds, client).unwrap();
        assert_eq!(
            crop,
            Crop {
                x: 2,
                y: 47, // 31 * 1.5 = 46.5 rounds to 47
                width: 796,
                height: 402 // bottom 299 * 1.5 = 448.5 rounds to 449, minus 47
            }
        );
        // A client rectangle reaching outside the bounds is clamped to the frame.
        let wide = rect(90, 40, 500, 400);
        let crop = client_crop(400, 300, bounds, wide).unwrap();
        assert_eq!(
            crop,
            Crop {
                x: 0,
                y: 0,
                width: 400,
                height: 300
            }
        );
        // Nothing of the client inside the frame, or empty bounds.
        assert!(client_crop(400, 300, bounds, rect(600, 60, 20, 20)).is_none());
        assert!(client_crop(400, 300, bounds, rect(101, 81, 0, 10)).is_none());
        assert!(client_crop(400, 300, rect(0, 0, 0, 10), client).is_none());
    }

    #[test]
    fn crop_pixels_cuts_the_requested_region() {
        let mut frame = flat(4, 3, [0, 0, 0, 255]);
        // Mark pixel (2, 1).
        let at = (4 + 2) * 4;
        frame.data[at..at + 4].copy_from_slice(&[9, 8, 7, 6]);
        let cut = crop_pixels(
            &frame,
            Crop {
                x: 2,
                y: 1,
                width: 2,
                height: 2,
            },
        )
        .unwrap();
        assert_eq!((cut.width, cut.height), (2, 2));
        assert_eq!(&cut.data[..4], &[9, 8, 7, 6]);
        assert_eq!(cut.data.len(), 16);
        let outside = Crop {
            x: 3,
            y: 0,
            width: 2,
            height: 1,
        };
        assert!(crop_pixels(&frame, outside).is_none());
    }

    #[test]
    fn scaled_size_caps_the_long_edge_keeps_aspect_and_never_grows() {
        assert_eq!(scaled_size(3000, 1500, 1500), (1500, 750));
        assert_eq!(scaled_size(1500, 3000, 1500), (750, 1500));
        assert_eq!(scaled_size(800, 600, 1568), (800, 600));
        assert_eq!(scaled_size(1568, 100, 1568), (1568, 100));
        // A very thin picture keeps one pixel on its short side.
        assert_eq!(scaled_size(10_000, 3, 100), (100, 1));
        assert_eq!(scaled_size(3, 10_000, 100), (1, 100));
    }

    #[test]
    fn box_downscale_averages_boxes_and_leaves_small_pictures_alone() {
        // 4 by 2 into 2 by 1: each output pixel is the mean of a 2 by 2 box.
        let mut src = flat(4, 2, [0, 0, 0, 255]);
        // Row 0 red values 10, 30, 20, 40; row 1 stays 0.
        for (i, v) in [10u8, 30, 20, 40].iter().enumerate() {
            src.data[i * 4] = *v;
        }
        let out = box_downscale(&src, 2);
        assert_eq!((out.width, out.height), (2, 1));
        // Left box red: (10 + 30 + 0 + 0) / 4 = 10; right: (20 + 40) / 4 = 15.
        assert_eq!(out.data, vec![10, 0, 0, 255, 15, 0, 0, 255]);
        let small = noise(30, 20, 5);
        assert_eq!(box_downscale(&small, 64), small);
        let tall = box_downscale(&flat(10, 5000, [1, 2, 3, 4]), 100);
        assert_eq!((tall.width, tall.height), (1, 100));
        assert!(tall
            .data
            .as_chunks::<4>()
            .0
            .iter()
            .all(|p| *p == [1, 2, 3, 4]));
    }

    #[test]
    fn box_downscale_of_a_non_integer_ratio_keeps_flat_colour() {
        let out = box_downscale(&flat(1000, 777, [200, 100, 50, 255]), 333);
        assert_eq!(out.width, 333);
        assert_eq!(out.data.len(), (out.width * out.height * 4) as usize);
        assert!(out
            .data
            .as_chunks::<4>()
            .0
            .iter()
            .all(|p| *p == [200, 100, 50, 255]));
    }

    #[test]
    fn png_decodes_back_to_the_same_pixels() {
        let picture = noise(7, 5, 11);
        let bytes = encode_png(&picture).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut buf = vec![0u8; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (7, 5));
        assert_eq!(info.color_type, png::ColorType::Rgba);
        assert_eq!(info.bit_depth, png::BitDepth::Eight);
        assert_eq!(&buf[..info.buffer_size()], picture.data.as_slice());
    }

    #[test]
    fn a_big_noise_frame_is_shrunk_until_it_fits_the_cap() {
        let frame = noise(2000, 2000, 0x1234_5678_9abc_def1);
        let fitted = fit_png(&frame, 1568, 65_536).unwrap();
        assert!(fitted.png.len() <= 65_536);
        let long = fitted.picture.width.max(fitted.picture.height);
        assert!((64..1568).contains(&long));
        assert_eq!(fitted.picture.width, fitted.picture.height);
        // A cap the first encode meets keeps the requested size.
        let kept = fit_png(&noise(40, 30, 3), 1568, 2 * 1024 * 1024).unwrap();
        assert_eq!((kept.picture.width, kept.picture.height), (40, 30));
    }

    #[test]
    fn an_impossible_cap_is_too_large() {
        let frame = noise(300, 300, 9);
        assert_eq!(fit_png(&frame, 300, 100).unwrap_err(), FitError::TooLarge);
    }
}
