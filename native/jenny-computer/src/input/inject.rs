//! The one place that calls `SendInput`, and the process-wide record of what it holds down. Every event
//! goes through [`send`], which records under one lock exactly the events Windows took, so the panic hook,
//! the watch's notifier and every exit can let go of what is still down.

use std::mem::size_of;
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::Duration;

use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use super::check::ScreenPoint;
use super::held::{Button, Ev, Held};
use super::keys::{code_of_vk, VK_LCONTROL, VK_LMENU, VK_LSHIFT};
use super::watch;
use crate::protocol::{ErrorCode, ProtoError};

/// Everything this helper holds down. Reached from the panic hook, so it is a static.
static HELD: Mutex<Held> = Mutex::new(Held::new());

fn held() -> MutexGuard<'static, Held> {
    // A panic while holding the lock left the record as it was after the last whole update.
    HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The virtual desktop's rectangle, read at the moment of sending.
struct Desk {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn desk() -> Desk {
    // SAFETY: plain metric queries with documented indexes.
    unsafe {
        Desk {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

/// A pixel as `SendInput`'s 0 to 65535 absolute coordinate: the smallest value Windows maps back onto
/// that pixel, whether it truncates or rounds (exact for desktops under 32768 pixels).
fn normalise(pixel: i32, origin: i32, size: i32) -> i32 {
    if size <= 1 {
        return 0;
    }
    let offset = i64::from(pixel) - i64::from(origin);
    let size = i64::from(size);
    ((offset * 65536 + size - 1) / size).clamp(0, 65535) as i32
}

fn mouse(dx: i32, dy: i32, data: u32, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn keyboard(scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: 0,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn button_flags(button: Button, down: bool) -> u32 {
    match (button, down) {
        (Button::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (Button::Left, false) => MOUSEEVENTF_LEFTUP,
        (Button::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (Button::Right, false) => MOUSEEVENTF_RIGHTUP,
        (Button::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (Button::Middle, false) => MOUSEEVENTF_MIDDLEUP,
    }
}

fn input_of(ev: Ev, desk: &Desk) -> INPUT {
    let up = |down: bool| if down { 0 } else { KEYEVENTF_KEYUP };
    match ev {
        Ev::Move { x, y } => mouse(
            normalise(x, desk.x, desk.width),
            normalise(y, desk.y, desk.height),
            0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        ),
        Ev::Button { button, down } => mouse(0, 0, 0, button_flags(button, down)),
        Ev::Wheel { horizontal, delta } => mouse(
            0,
            0,
            delta as u32,
            if horizontal {
                MOUSEEVENTF_HWHEEL
            } else {
                MOUSEEVENTF_WHEEL
            },
        ),
        Ev::Key {
            scan,
            extended,
            down,
        } => keyboard(
            scan,
            KEYEVENTF_SCANCODE | up(down) | if extended { KEYEVENTF_EXTENDEDKEY } else { 0 },
        ),
        Ev::Unicode { unit, down } => keyboard(unit, KEYEVENTF_UNICODE | up(down)),
    }
}

/// Hand events to Windows; how many it took (it takes a prefix, in order).
fn send_raw(evs: &[Ev]) -> usize {
    if evs.is_empty() {
        return 0;
    }
    let desk = desk();
    let inputs: Vec<INPUT> = evs.iter().map(|ev| input_of(*ev, &desk)).collect();
    // SAFETY: `inputs` is a live, initialised array of exactly the length passed, and the size passed is
    // the size of one `INPUT`, as the call requires.
    let taken = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    (taken as usize).min(evs.len())
}

fn release_locked(held: &mut Held) -> usize {
    let ups = held.releases();
    let taken = send_raw(&ups);
    for ev in ups.iter().take(taken) {
        held.apply(*ev);
    }
    taken
}

/// Send one checked batch in one `SendInput` call. The caller ran the matching check just before. A batch
/// that presses or moves anything is held back if the owner's latch was set in the meantime; one that only
/// lets go always goes.
pub fn send(evs: &[Ev]) -> Result<(), ProtoError> {
    let mut held = held();
    if !evs.iter().all(|ev| ev.is_release()) && watch::gate().owner_active {
        return Err(ProtoError::refused(
            "owner_active",
            "the owner is using the keyboard or mouse",
        ));
    }
    let taken = send_raw(evs);
    for ev in evs.iter().take(taken) {
        held.apply(*ev);
    }
    if taken < evs.len() {
        return Err(ProtoError::new(
            ErrorCode::Internal,
            "Windows took only part of the input",
        ));
    }
    Ok(())
}

/// Let go of everything held; how many keys and buttons were let go.
pub fn release_all() -> usize {
    release_locked(&mut held())
}

/// From the panic hook: let go of what is held without waiting long for the lock. If the lock cannot be
/// had, let go of the modifier keys, which are what a stuck PC would notice first.
pub fn release_after_panic() {
    for _ in 0..100 {
        match HELD.try_lock() {
            Ok(mut held) => {
                release_locked(&mut held);
                return;
            }
            Err(TryLockError::Poisoned(poisoned)) => {
                release_locked(&mut poisoned.into_inner());
                return;
            }
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(1)),
        }
    }
    let ups: Vec<Ev> = [VK_LCONTROL, VK_LSHIFT, VK_LMENU]
        .into_iter()
        .filter_map(|vk| code_of_vk(vk, false).ok())
        .map(|code| code.ev(false))
        .collect();
    send_raw(&ups);
}

/// Where the pointer is now.
pub fn cursor() -> Option<ScreenPoint> {
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: `point` is a valid out pointer for the call.
    (unsafe { GetCursorPos(&mut point) } != 0).then_some(ScreenPoint {
        x: point.x,
        y: point.y,
    })
}

/// Move the pointer to `point` (one checked batch: the caller checked it just before) and make sure it is
/// on that exact pixel, putting it there if rounding left it off.
pub fn move_verified(point: ScreenPoint) -> Result<(), ProtoError> {
    send(&[Ev::Move {
        x: point.x,
        y: point.y,
    }])?;
    if cursor() == Some(point) {
        return Ok(());
    }
    // SAFETY: a plain call with two integers; a refusal is seen in the read below.
    unsafe { SetCursorPos(point.x, point.y) };
    if cursor() == Some(point) {
        Ok(())
    } else {
        Err(ProtoError::new(
            ErrorCode::Internal,
            "the pointer did not reach the point",
        ))
    }
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

    /// Windows maps an absolute coordinate back to a pixel by truncating `n * size / 65536`.
    fn back(n: i32, origin: i32, size: i32) -> i32 {
        origin + ((i64::from(n) * i64::from(size)) >> 16) as i32
    }

    #[test]
    fn every_pixel_of_a_two_monitor_desktop_maps_back_to_itself() {
        let (origin, size) = (-1920, 1920 + 2560);
        for pixel in origin..origin + size {
            let n = normalise(pixel, origin, size);
            assert!((0..=65535).contains(&n));
            assert_eq!(back(n, origin, size), pixel, "{pixel}");
        }
    }

    #[test]
    fn events_become_the_documented_input_flags() {
        let d = Desk {
            x: 0,
            y: 0,
            width: 1000,
            height: 1000,
        };
        let key = input_of(
            Ev::Key {
                scan: 0x4B,
                extended: true,
                down: false,
            },
            &d,
        );
        assert_eq!(key.r#type, INPUT_KEYBOARD);
        // SAFETY: the union was written as `ki` just above.
        let ki = unsafe { key.Anonymous.ki };
        assert_eq!(ki.wScan, 0x4B);
        assert_eq!(ki.wVk, 0);
        assert_eq!(
            ki.dwFlags,
            KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP | KEYEVENTF_EXTENDEDKEY
        );
        let wheel = input_of(
            Ev::Wheel {
                horizontal: false,
                delta: -240,
            },
            &d,
        );
        // SAFETY: the union was written as `mi` just above.
        let mi = unsafe { wheel.Anonymous.mi };
        assert_eq!(mi.mouseData as i32, -240);
        assert_eq!(mi.dwFlags, MOUSEEVENTF_WHEEL);
        let text = input_of(
            Ev::Unicode {
                unit: 0xE9,
                down: true,
            },
            &d,
        );
        // SAFETY: the union was written as `ki` just above.
        let ki = unsafe { text.Anonymous.ki };
        assert_eq!((ki.wScan, ki.dwFlags), (0xE9, KEYEVENTF_UNICODE));
    }
}
