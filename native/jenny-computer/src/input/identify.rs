//! Program names: who a top-level window belongs to, told by the program's file, never its title. A Store
//! app's frame (`ApplicationFrameHost.exe`) belongs to the app inside it; when that app's window cannot be
//! found the window is unidentified (fail closed). A process that cannot be opened to ask counts as
//! running as administrator. Paths are returned as Windows gives them and never logged.

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetAncestor, GetClassNameW, GetWindowThreadProcessId, GA_ROOT,
};

use super::check::{normalize_path, Identity};
use crate::geometry::win::{hwnd_of, is_window, no_such_window};
use crate::protocol::{ProtoError, Request};

const FRAME_HOST: &str = "applicationframehost.exe";
const CORE_WINDOW: &str = "Windows.UI.Core.CoreWindow";

/// Who a window belongs to, in `program.identify`'s terms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// The real program's process.
    pub pid: u32,
    /// Every process the window belongs to: its own and, for a Store app, the app's.
    pub pids: Vec<u32>,
    /// The real program's file as Windows gives it; `None` when it cannot be told.
    pub program: Option<String>,
    pub kind: &'static str,
    pub elevated: bool,
}

impl Found {
    /// The check's view: the program normalised.
    pub fn identity(&self) -> Identity {
        Identity {
            pids: self.pids.clone(),
            program: self.program.as_deref().map(normalize_path),
            elevated: self.elevated,
        }
    }
}

/// The class name of a window.
pub fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    // SAFETY: `buf` is a writable buffer of the length passed; a stale handle copies nothing.
    let copied = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    let copied = usize::try_from(copied).unwrap_or(0);
    String::from_utf16_lossy(buf.get(..copied).unwrap_or_default())
}

fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    // SAFETY: `pid` is a valid out pointer; a window that is gone leaves it 0.
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    pid
}

/// One process, as far as it can be asked.
struct Process {
    image: Option<String>,
    elevated: bool,
}

fn image_of(process: HANDLE) -> Option<String> {
    for capacity in [1024usize, 32_768] {
        let mut buf = vec![0u16; capacity];
        let mut len = capacity as u32;
        // SAFETY: `buf` holds `len` writable units; on success `len` is the length written.
        let ok = unsafe {
            QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        } != 0;
        if ok {
            let len = (len as usize).min(capacity);
            return Some(String::from_utf16_lossy(buf.get(..len).unwrap_or_default()));
        }
    }
    None
}

/// True unless the process's token says it is not elevated.
fn elevated_of(process: HANDLE) -> bool {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `token` is a valid out pointer; the process handle is open for limited query.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return true;
    }
    let mut info = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut len = 0u32;
    // SAFETY: `info` is a valid out buffer of exactly the size passed; the token is open for query.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            (&raw mut info).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
    } != 0;
    // SAFETY: the token this function opened, closed once.
    unsafe { CloseHandle(token) };
    !ok || info.TokenIsElevated != 0
}

fn inspect(pid: u32) -> Process {
    if pid == 0 {
        return Process {
            image: None,
            elevated: true,
        };
    }
    // SAFETY: a plain open for limited query; failure returns null.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Process {
            image: None,
            elevated: true,
        };
    }
    let found = Process {
        image: image_of(process),
        elevated: elevated_of(process),
    };
    // SAFETY: the handle this function opened, closed once.
    unsafe { CloseHandle(process) };
    found
}

fn is_frame_host(image: &str) -> bool {
    image
        .rsplit(['\\', '/'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case(FRAME_HOST))
}

struct StoreSearch {
    frame_pid: u32,
    found: Option<u32>,
}

/// `EnumChildWindows` callback: stop at the first Store app window of another process.
unsafe extern "system" fn visit_child(hwnd: HWND, lparam: LPARAM) -> i32 {
    // SAFETY: `lparam` is the address of the `StoreSearch` that `store_app` keeps alive and exclusively
    // borrowed for the whole `EnumChildWindows` call, which runs this callback on the same thread.
    let search = unsafe { &mut *(lparam as *mut StoreSearch) };
    let pid = pid_of(hwnd);
    if pid != 0 && pid != search.frame_pid && class_name(hwnd) == CORE_WINDOW {
        search.found = Some(pid);
        return 0;
    }
    1
}

/// The process of the Store app inside a frame window.
fn store_app(frame: HWND, frame_pid: u32) -> Option<u32> {
    let mut search = StoreSearch {
        frame_pid,
        found: None,
    };
    // SAFETY: `visit_child` matches the callback type; the pointer passed stays valid and is used only by
    // `visit_child`, during this call.
    unsafe { EnumChildWindows(frame, Some(visit_child), (&raw mut search) as LPARAM) };
    search.found
}

/// Who a top-level window belongs to.
pub fn identify(hwnd: u64) -> Found {
    let window = hwnd_of(hwnd);
    let pid = pid_of(window);
    let own = inspect(pid);
    let unknown = |elevated| Found {
        pid,
        pids: vec![pid],
        program: None,
        kind: "unknown",
        elevated,
    };
    let Some(image) = own.image else {
        return unknown(own.elevated);
    };
    if !is_frame_host(&image) {
        return Found {
            pid,
            pids: vec![pid],
            program: Some(image),
            kind: "desktop",
            elevated: own.elevated,
        };
    }
    let Some(app_pid) = store_app(window, pid) else {
        return unknown(own.elevated);
    };
    let app = inspect(app_pid);
    Found {
        pid: app_pid,
        pids: vec![pid, app_pid],
        kind: if app.image.is_some() {
            "store"
        } else {
            "unknown"
        },
        program: app.image,
        elevated: app.elevated,
    }
}

/// `program.identify`.
pub fn program_identify(req: &Request) -> Result<Value, ProtoError> {
    let hwnd = req.hwnd_arg()?;
    let window = hwnd_of(hwnd);
    // SAFETY: a plain query on any handle value; a stale one answers null.
    let top_level = is_window(hwnd) && unsafe { GetAncestor(window, GA_ROOT) } == window;
    if !top_level {
        return Err(no_such_window());
    }
    let found = identify(hwnd);
    Ok(json!({
        "hwnd": hwnd,
        "pid": found.pid,
        "program": found.program,
        "kind": found.kind,
        "elevated": found.elevated,
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

    #[test]
    fn the_store_frame_is_told_by_its_file_name() {
        assert!(is_frame_host(
            r"C:\Windows\System32\ApplicationFrameHost.exe"
        ));
        assert!(is_frame_host(
            r"\\?\C:\WINDOWS\system32\applicationframehost.EXE"
        ));
        assert!(!is_frame_host(r"C:\Tools\NotApplicationFrameHost.exe"));
        assert!(!is_frame_host(r"C:\Windows\System32\notepad.exe"));
    }

    #[test]
    fn a_process_that_cannot_be_asked_is_unknown_and_elevated() {
        let p = inspect(0);
        assert!(p.image.is_none() && p.elevated);
    }
}
