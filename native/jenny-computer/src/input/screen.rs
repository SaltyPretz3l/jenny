//! The check's [`Screen`] for Windows, read at the moment of each call, and `input.focus`.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{HWND, POINT};
use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME,
};
use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
    SetForegroundWindow, ShowWindow, WindowFromPoint, GA_ROOT, SW_RESTORE,
};

use super::check::{
    check_focus, confirm_front, parse_expect, Identity, Screen, ScreenPoint, WindowState,
};
use super::{identify, password, watch};
use crate::geometry::win::{drawn_bounds, hwnd_of, hwnd_value, is_window};
use crate::geometry::Rect;
use crate::protocol::{ProtoError, Request};
use crate::window_list::win::visible_and_cloaked;

/// How often and how long `input.focus` looks for the window in front.
const FRONT_POLL: Duration = Duration::from_millis(25);
const FRONT_WAIT: Duration = Duration::from_millis(500);

/// The real screen.
pub struct WinScreen;

fn root_of(hwnd: HWND) -> Option<u64> {
    if hwnd.is_null() {
        return None;
    }
    // SAFETY: a plain query on a window handle; a stale handle answers null.
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    (!root.is_null()).then(|| hwnd_value(root))
}

impl Screen for WinScreen {
    fn input_desktop_is_default(&self) -> bool {
        // SAFETY: opens the desktop taking input for reading its name; the lock screen, an elevation
        // prompt and Ctrl+Alt+Del's screen refuse this process, which answers null.
        let desk = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
        if desk.is_null() {
            return false;
        }
        let mut name = [0u16; 64];
        let mut needed = 0u32;
        // SAFETY: `name` is a writable buffer of the byte length passed; the handle is open.
        let ok = unsafe {
            GetUserObjectInformationW(
                desk,
                UOI_NAME,
                name.as_mut_ptr().cast(),
                std::mem::size_of_val(&name) as u32,
                &mut needed,
            )
        } != 0;
        // SAFETY: the handle opened above, closed once.
        unsafe { CloseDesktop(desk) };
        let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        ok && String::from_utf16_lossy(name.get(..len).unwrap_or_default())
            .eq_ignore_ascii_case("Default")
    }

    fn window_state(&self, hwnd: u64) -> WindowState {
        if !is_window(hwnd) {
            return WindowState::Gone;
        }
        let (visible, cloaked) = visible_and_cloaked(hwnd);
        if !visible || cloaked {
            return WindowState::Hidden;
        }
        // SAFETY: a plain query on a window handle; a stale handle answers 0.
        if unsafe { IsIconic(hwnd_of(hwnd)) } != 0 {
            WindowState::Minimized
        } else {
            WindowState::Shown
        }
    }

    fn bounds(&self, hwnd: u64) -> Option<Rect> {
        drawn_bounds(hwnd_of(hwnd))
    }

    fn root_at(&self, point: ScreenPoint) -> Option<u64> {
        // SAFETY: a plain query with a point by value.
        let hit = unsafe {
            WindowFromPoint(POINT {
                x: point.x,
                y: point.y,
            })
        };
        root_of(hit)
    }

    fn foreground_root(&self) -> Option<u64> {
        // SAFETY: a plain query.
        root_of(unsafe { GetForegroundWindow() })
    }

    fn identify(&self, hwnd: u64) -> Identity {
        identify::identify(hwnd).identity()
    }

    fn focused_is_password(&self) -> Option<bool> {
        password::focused_is_password()
    }
}

/// Bring a window forward the way the owner's sitting showed works from a background process: attach to
/// the front window's input thread, bring it to the top, make it the foreground window, detach.
fn bring_forward(window: HWND) {
    // SAFETY: plain calls on window handles and thread ids; each failure is reported through its return
    // value and the result is checked by polling afterwards. The attachment is always undone.
    unsafe {
        let front = GetForegroundWindow();
        let front_thread = if front.is_null() {
            0
        } else {
            GetWindowThreadProcessId(front, std::ptr::null_mut())
        };
        let me = GetCurrentThreadId();
        let attached =
            front_thread != 0 && front_thread != me && AttachThreadInput(me, front_thread, 1) != 0;
        BringWindowToTop(window);
        SetForegroundWindow(window);
        if attached {
            AttachThreadInput(me, front_thread, 0);
        }
    }
}

/// `input.focus`: restore if minimised, bring forward, and check that it came. Sends no key or click.
pub fn focus(req: &Request) -> Result<Value, ProtoError> {
    let expect = parse_expect(req)?;
    let screen = WinScreen;
    check_focus(watch::gate(), &screen, &expect)?;
    let window = hwnd_of(expect.hwnd);
    match screen.window_state(expect.hwnd) {
        // A hidden window is never shown by this helper: it cannot come to the front.
        WindowState::Hidden | WindowState::Gone => {
            return confirm_front(&screen, &expect).map(|()| json!({"front": true}))
        }
        // SAFETY: a plain call on a window handle; a stale handle makes it fail.
        WindowState::Minimized => unsafe {
            ShowWindow(window, SW_RESTORE);
        },
        WindowState::Shown => {}
    }
    bring_forward(window);
    let deadline = Instant::now() + FRONT_WAIT;
    loop {
        let front = confirm_front(&screen, &expect);
        if front.is_ok() || Instant::now() >= deadline {
            return front.map(|()| json!({"front": true}));
        }
        std::thread::sleep(FRONT_POLL);
    }
}
