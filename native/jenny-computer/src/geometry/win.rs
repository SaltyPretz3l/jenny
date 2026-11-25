//! The Windows half of `window.geometry`, plus the small window helpers other modules share.

use std::mem::{size_of, zeroed};

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowRect, IsIconic, IsWindow,
};

use super::{offset, Rect};
use crate::protocol::{ErrorCode, ProtoError};

/// A JSON window handle as the Win32 type. Handles fit in 32 bits, so this loses nothing.
pub fn hwnd_of(hwnd: u64) -> HWND {
    hwnd as usize as HWND
}

/// The JSON form of a window handle.
pub fn hwnd_value(hwnd: HWND) -> u64 {
    hwnd as usize as u64
}

pub fn is_window(hwnd: u64) -> bool {
    // SAFETY: `IsWindow` takes any handle value, valid or not, and only reports whether it names a window.
    unsafe { IsWindow(hwnd_of(hwnd)) != 0 }
}

pub fn no_such_window() -> ProtoError {
    ProtoError::new(ErrorCode::NoSuchWindow, "no window with that handle")
}

fn rect_of(raw: &RECT) -> Rect {
    Rect::from_edges(raw.left, raw.top, raw.right, raw.bottom)
}

/// The window rectangle, invisible resize borders included.
pub fn window_rect(hwnd: HWND) -> Option<Rect> {
    // SAFETY: RECT is a plain struct of integers; all-zero is valid.
    let mut raw: RECT = unsafe { zeroed() };
    // SAFETY: `raw` is a valid out pointer for the call; a bad handle makes the call fail.
    (unsafe { GetWindowRect(hwnd, &mut raw) } != 0).then(|| rect_of(&raw))
}

/// The drawn bounds (DWM's extended frame bounds), falling back to the window rectangle.
pub fn drawn_bounds(hwnd: HWND) -> Option<Rect> {
    // SAFETY: RECT is a plain struct of integers; all-zero is valid.
    let mut raw: RECT = unsafe { zeroed() };
    // SAFETY: `raw` is a valid out pointer of exactly the size passed; a bad handle makes the call
    // return a failure code.
    let hr = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&raw mut raw).cast(),
            size_of::<RECT>() as u32,
        )
    };
    if hr == 0 {
        Some(rect_of(&raw))
    } else {
        window_rect(hwnd)
    }
}

/// The client area in screen coordinates.
pub fn client_rect(hwnd: HWND) -> Option<Rect> {
    // SAFETY: RECT is a plain struct of integers; all-zero is valid.
    let mut raw: RECT = unsafe { zeroed() };
    // SAFETY: `raw` is a valid out pointer for the call; a bad handle makes the call fail.
    if unsafe { GetClientRect(hwnd, &mut raw) } == 0 {
        return None;
    }
    let mut origin = POINT { x: 0, y: 0 };
    // SAFETY: `origin` is a valid in/out pointer for the call; a bad handle makes the call fail.
    if unsafe { ClientToScreen(hwnd, &mut origin) } == 0 {
        return None;
    }
    Some(Rect {
        x: origin.x,
        y: origin.y,
        width: raw.right.saturating_sub(raw.left),
        height: raw.bottom.saturating_sub(raw.top),
    })
}

/// `window.geometry` for a handle.
pub fn geometry(hwnd_json: u64) -> Result<Value, ProtoError> {
    if !is_window(hwnd_json) {
        return Err(no_such_window());
    }
    let hwnd = hwnd_of(hwnd_json);
    let (Some(window), Some(bounds), Some(client)) =
        (window_rect(hwnd), drawn_bounds(hwnd), client_rect(hwnd))
    else {
        // The window went away between the check and the reads.
        return Err(no_such_window());
    };
    // SAFETY: plain calls on a window handle; a handle that stopped being valid makes them return 0 / FALSE.
    let (dpi, minimized) = unsafe { (GetDpiForWindow(hwnd), IsIconic(hwnd) != 0) };
    let dpi = if dpi == 0 { 96 } else { dpi };
    Ok(json!({
        "hwnd": hwnd_json,
        "window": window.to_json(),
        "bounds": bounds.to_json(),
        "client": client.to_json(),
        "offset": offset(bounds, client).to_json(),
        "dpi": dpi,
        "scale": f64::from(dpi) / 96.0,
        "minimized": minimized,
    }))
}
