//! Windows half of the window list: `EnumWindows`, titles, styles, and Show window / Send behind.

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, SetForegroundWindow, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_BOTTOM,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SW_RESTORE, WS_EX_TOOLWINDOW,
};

use super::Candidate;
use crate::geometry::win::{drawn_bounds, hwnd_of, hwnd_value, is_window, no_such_window};
use crate::geometry::Rect;
use crate::protocol::ProtoError;

/// One top-level window as `windows.list` reports it.
pub struct WindowInfo {
    pub hwnd: u64,
    pub pid: u32,
    pub title: String,
    /// The window class, such as `#32770` for a standard dialog (row 196 asks before the first Open or
    /// Save dialog of a program).
    pub class: String,
    pub visible: bool,
    pub cloaked: bool,
    pub tool_window: bool,
    pub bounds: Rect,
}

impl WindowInfo {
    pub fn candidate(&self) -> Candidate {
        Candidate {
            hwnd: self.hwnd,
            pid: self.pid,
            visible: self.visible,
            cloaked: self.cloaked,
            tool_window: self.tool_window,
            width: self.bounds.width,
            height: self.bounds.height,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "hwnd": self.hwnd,
            "pid": self.pid,
            "title": self.title,
            "class": self.class,
            "visible": self.visible,
            "cloaked": self.cloaked,
            "tool_window": self.tool_window,
            "bounds": self.bounds.to_json(),
        })
    }
}

struct Collector {
    pids: Option<Vec<u32>>,
    titles: bool,
    out: Vec<WindowInfo>,
}

/// `(visible, cloaked)` of one window, for the run monitor.
pub fn visible_and_cloaked(hwnd: u64) -> (bool, bool) {
    let hwnd = hwnd_of(hwnd);
    // SAFETY: a plain query on a window handle; a stale handle makes it return 0.
    let visible = unsafe { IsWindowVisible(hwnd) } != 0;
    (visible, cloaked(hwnd))
}

fn cloaked(hwnd: HWND) -> bool {
    let mut value: u32 = 0;
    // SAFETY: `value` is a valid out pointer of exactly 4 bytes, the size DWMWA_CLOAKED returns; a bad
    // handle makes the call return a failure code.
    let hr = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&raw mut value).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    };
    hr == 0 && value != 0
}

fn class_name(hwnd: HWND) -> String {
    // Class names are at most 256 characters.
    let mut buf = [0u16; 257];
    // SAFETY: `buf` is a writable buffer of the length passed; a stale handle makes the call return 0.
    let copied = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    let copied = usize::try_from(copied).unwrap_or(0);
    String::from_utf16_lossy(buf.get(..copied).unwrap_or_default())
}

fn title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    // SAFETY: `buf` is a writable buffer of the length passed. Another process's window gives its
    // caption without waiting on that process.
    let copied = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    let copied = usize::try_from(copied).unwrap_or(0);
    String::from_utf16_lossy(buf.get(..copied).unwrap_or_default())
}

/// `EnumWindows` callback: look at one window and keep it when it passes the process filter.
unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> i32 {
    // SAFETY: `lparam` is the address of the `Collector` that `enumerate` keeps alive and exclusively
    // borrowed for the whole `EnumWindows` call, which runs this callback on the same thread.
    let collector = unsafe { &mut *(lparam as *mut Collector) };
    let mut pid: u32 = 0;
    // SAFETY: `pid` is a valid out pointer; a window that vanished makes the call return 0 and leave it 0.
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid == 0 {
        return 1;
    }
    if let Some(wanted) = &collector.pids {
        if !wanted.contains(&pid) {
            return 1;
        }
    }
    let Some(bounds) = drawn_bounds(hwnd) else {
        return 1;
    };
    // SAFETY: plain queries on a window handle; a stale handle makes them return 0.
    let (visible, ex_style) = unsafe {
        (
            IsWindowVisible(hwnd) != 0,
            GetWindowLongW(hwnd, GWL_EXSTYLE),
        )
    };
    // Titles and classes only for `windows.list`: the run monitor's polls by process need neither.
    let (title, class) = if collector.titles {
        (title(hwnd), class_name(hwnd))
    } else {
        (String::new(), String::new())
    };
    collector.out.push(WindowInfo {
        hwnd: hwnd_value(hwnd),
        pid,
        title,
        class,
        visible,
        cloaked: cloaked(hwnd),
        tool_window: ex_style as u32 & WS_EX_TOOLWINDOW != 0,
        bounds,
    });
    1
}

/// Every top-level window in Z order (top first), only those of `pids` when given.
pub fn enumerate(pids: Option<Vec<u32>>, titles: bool) -> Vec<WindowInfo> {
    let mut collector = Collector {
        pids,
        titles,
        out: Vec::new(),
    };
    // SAFETY: `visit` matches the callback type; the pointer passed stays valid and is used only by
    // `visit`, during this call.
    unsafe { EnumWindows(Some(visit), (&raw mut collector) as LPARAM) };
    collector.out
}

/// `windows.list` result.
pub fn list(pids: Option<Vec<u32>>) -> Value {
    let windows: Vec<Value> = enumerate(pids, true)
        .iter()
        .map(WindowInfo::to_json)
        .collect();
    json!({ "windows": windows })
}

/// `window.show` for a handle.
pub fn show(hwnd_json: u64, front: bool) -> Result<Value, ProtoError> {
    if !is_window(hwnd_json) {
        return Err(no_such_window());
    }
    let hwnd = hwnd_of(hwnd_json);
    if front {
        // SAFETY: plain calls on a window handle; failures are reported through the return value.
        // Windows may refuse to give the foreground to this process; that is not an error here.
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            SetForegroundWindow(hwnd);
        }
    } else {
        // SAFETY: plain call on a window handle; HWND_BOTTOM is a documented special value, and the flags
        // keep the position, size and activation as they are.
        unsafe {
            SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
        }
    }
    Ok(json!({}))
}
