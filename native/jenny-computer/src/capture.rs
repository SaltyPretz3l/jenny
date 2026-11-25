//! One frame of one window with Windows' own capture, scaled and PNG-encoded under a byte cap.
//! Built by lane H2 (row 197).
//!
//! `image` holds the pure picture logic (pixel conversion, client crop, box downscale, PNG under a
//! cap, signature); `wgc` holds the Windows part (Windows.Graphics.Capture and Direct3D 11).

mod image;
#[cfg(windows)]
mod wgc;

use base64::Engine;
use serde_json::{json, Value};

use crate::protocol::{ErrorCode, ProtoError, Request};
use image::{FitError, Rect, Rgba};

pub const BUILT: bool = true;

const DEFAULT_LONG_EDGE: u64 = 1568;
const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Which part of the window the picture shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Area {
    /// The drawn bounds, title bar included.
    Bounds,
    /// Only the client area.
    Client,
}

/// One captured frame, and for `area: "client"` the drawn bounds and client rectangle read
/// beside it (both in screen pixels).
struct Grabbed {
    frame: Rgba,
    geometry: Option<(Rect, Rect)>,
}

#[cfg(not(windows))]
mod wgc {
    use super::Grabbed;
    use crate::protocol::ProtoError;

    pub fn grab(_hwnd: u64, _want_client: bool) -> Result<Grabbed, ProtoError> {
        Err(ProtoError::not_available())
    }
}

fn parse_area(value: Option<&str>) -> Result<Area, ProtoError> {
    match value {
        None | Some("bounds") => Ok(Area::Bounds),
        Some("client") => Ok(Area::Client),
        Some(_) => Err(ProtoError::bad_request(
            "area must be \"bounds\" or \"client\"",
        )),
    }
}

fn capture_failed(message: &str) -> ProtoError {
    ProtoError::new(ErrorCode::CaptureFailed, message)
}

/// `capture`.
pub fn capture(req: &Request) -> Result<Value, ProtoError> {
    let hwnd = req.hwnd_arg()?;
    let max_long_edge = req.u64_arg("max_long_edge", DEFAULT_LONG_EDGE, 64, 4096)?;
    let max_bytes = req.u64_arg("max_bytes", DEFAULT_MAX_BYTES, 65_536, DEFAULT_MAX_BYTES)?;
    let area = parse_area(req.opt_str_arg("area")?)?;
    let grabbed = wgc::grab(hwnd, area == Area::Client)?;
    finish(grabbed, area, max_long_edge as u32, max_bytes as usize)
}

/// Crop, scale, encode under the cap and build the result.
fn finish(
    grabbed: Grabbed,
    area: Area,
    max_long_edge: u32,
    max_bytes: usize,
) -> Result<Value, ProtoError> {
    let frame_width = grabbed.frame.width;
    let picture = match (area, grabbed.geometry) {
        (Area::Client, Some((bounds, client))) => {
            let crop = image::client_crop(frame_width, grabbed.frame.height, bounds, client)
                .ok_or_else(|| capture_failed("client area is empty"))?;
            image::crop_pixels(&grabbed.frame, crop)
                .ok_or_else(|| capture_failed("client area is empty"))?
        }
        (Area::Client, None) => return Err(capture_failed("client area is unknown")),
        (Area::Bounds, _) => grabbed.frame,
    };
    // The width of the picture that is fitted: the cropped one for the client area.
    let source_width = picture.width;
    let fitted = image::fit_png(&picture, max_long_edge, max_bytes).map_err(|e| match e {
        FitError::TooLarge => ProtoError::new(
            ErrorCode::TooLarge,
            "picture does not fit max_bytes even at the smallest size",
        ),
        FitError::Encode => ProtoError::new(ErrorCode::Internal, "png encoding failed"),
    })?;
    let scale = f64::from(fitted.picture.width) / f64::from(source_width.max(1));
    Ok(json!({
        "png_base64": base64::engine::general_purpose::STANDARD.encode(&fitted.png),
        "width": fitted.picture.width,
        "height": fitted.picture.height,
        "scale": scale,
        "signature": image::signature(&fitted.picture.data),
    }))
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
    use crate::protocol::parse_request;

    fn call(args: &str) -> Result<Value, ProtoError> {
        let line = format!(r#"{{"id":1,"op":"capture"{args}}}"#);
        capture(&parse_request(&line).unwrap())
    }

    #[test]
    fn bad_arguments_are_bad_requests() {
        for args in [
            r#","hwnd":1,"area":"screen""#,
            r#","hwnd":1,"area":3"#,
            r#","hwnd":1,"max_long_edge":63"#,
            r#","hwnd":1,"max_long_edge":4097"#,
            r#","hwnd":1,"max_bytes":65535"#,
            r#","hwnd":1,"max_bytes":2097153"#,
            r#","hwnd":"1""#,
            "",
        ] {
            assert_eq!(
                call(args).unwrap_err().code,
                ErrorCode::BadRequest,
                "{args}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_handle_that_is_no_window_is_no_such_window() {
        let err = call(r#","hwnd":1"#).unwrap_err();
        assert_eq!(err.code, ErrorCode::NoSuchWindow);
        let err =
            call(r#","hwnd":1,"area":"client","max_long_edge":64,"max_bytes":65536"#).unwrap_err();
        assert_eq!(err.code, ErrorCode::NoSuchWindow);
    }

    fn gradient(width: u32, height: u32) -> Rgba {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                data.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 7, 255]);
            }
        }
        Rgba {
            width,
            height,
            data,
        }
    }

    fn decode(result: &Value) -> (png::OutputInfo, Vec<u8>) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(result["png_base64"].as_str().unwrap())
            .unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut buf = vec![0u8; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        buf.truncate(info.buffer_size());
        (info, buf)
    }

    #[test]
    fn a_bounds_result_has_the_documented_fields() {
        let frame = gradient(200, 100);
        let grabbed = Grabbed {
            frame: frame.clone(),
            geometry: None,
        };
        let result = finish(grabbed, Area::Bounds, 100, 2 * 1024 * 1024).unwrap();
        assert_eq!(result["width"], 100);
        assert_eq!(result["height"], 50);
        assert_eq!(result["scale"].as_f64().unwrap(), 0.5);
        let (info, pixels) = decode(&result);
        assert_eq!((info.width, info.height), (100, 50));
        assert_eq!(
            result["signature"].as_str().unwrap(),
            image::signature(&pixels)
        );
        // Same pixels, same signature.
        let again = finish(
            Grabbed {
                frame,
                geometry: None,
            },
            Area::Bounds,
            100,
            2 * 1024 * 1024,
        )
        .unwrap();
        assert_eq!(again["signature"], result["signature"]);
    }

    #[test]
    fn a_client_result_is_cropped_and_scales_against_the_cropped_picture() {
        let bounds = Rect {
            x: 10,
            y: 10,
            width: 200,
            height: 100,
        };
        let client = Rect {
            x: 12,
            y: 40,
            width: 196,
            height: 69,
        };
        let grabbed = Grabbed {
            frame: gradient(200, 100),
            geometry: Some((bounds, client)),
        };
        let result = finish(grabbed, Area::Client, 4096, 2 * 1024 * 1024).unwrap();
        assert_eq!(result["width"], 196);
        assert_eq!(result["height"], 69);
        // Nothing was downscaled, so the picture has one pixel per screen pixel.
        assert_eq!(result["scale"].as_f64().unwrap(), 1.0);
        let (info, pixels) = decode(&result);
        assert_eq!((info.width, info.height), (196, 69));
        // The top-left picture pixel is frame pixel (2, 30).
        assert_eq!(pixels[..4], [2, 30, 7, 255]);
    }

    #[test]
    fn a_downscaled_client_result_scales_against_the_cropped_width() {
        let bounds = Rect {
            x: 10,
            y: 10,
            width: 200,
            height: 100,
        };
        let client = Rect {
            x: 12,
            y: 40,
            width: 196,
            height: 69,
        };
        let grabbed = Grabbed {
            frame: gradient(200, 100),
            geometry: Some((bounds, client)),
        };
        // The 196-wide crop is fitted to 98 wide: half a picture pixel per screen pixel.
        let result = finish(grabbed, Area::Client, 98, 2 * 1024 * 1024).unwrap();
        assert_eq!(result["width"], 98);
        assert_eq!(result["scale"].as_f64().unwrap(), 0.5);
    }

    #[test]
    fn an_empty_client_area_is_capture_failed_and_a_tiny_cap_is_too_large() {
        let bounds = Rect {
            x: 0,
            y: 0,
            width: 200,
            height: 100,
        };
        let outside = Rect {
            x: 500,
            y: 500,
            width: 10,
            height: 10,
        };
        let err = finish(
            Grabbed {
                frame: gradient(200, 100),
                geometry: Some((bounds, outside)),
            },
            Area::Client,
            4096,
            2 * 1024 * 1024,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::CaptureFailed);
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let data = (0..400 * 400 * 4)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect();
        let noisy = Rgba {
            width: 400,
            height: 400,
            data,
        };
        let err = finish(
            Grabbed {
                frame: noisy,
                geometry: None,
            },
            Area::Bounds,
            400,
            100,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::TooLarge);
    }
}
