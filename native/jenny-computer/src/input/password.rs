//! Whether the focused field is a password field, asked two ways: the classic edit-control style and UI
//! Automation. Either saying yes is a yes; a failure of either is only no answer, never an error.

use std::cell::RefCell;

use windows::core::Interface;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, CUIAutomation8, IUIAutomation, IUIAutomation2,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetGUIThreadInfo, GetWindowLongW, GetWindowThreadProcessId, ES_PASSWORD,
    GUITHREADINFO, GWL_STYLE,
};

use super::identify::class_name;

/// How long UI Automation may wait on a program, for its connection and for each call.
const UIA_TIMEOUT_MS: u32 = 500;

thread_local! {
    /// One UI Automation client per thread, created on first use with COM set up for that thread.
    static AUTOMATION: RefCell<Option<IUIAutomation>> = const { RefCell::new(None) };
}

/// The classic answer: the foreground thread's focused window is an edit control with `ES_PASSWORD`.
/// The style bit means something else on other classes, so only edit controls are asked.
fn classic() -> Option<bool> {
    // SAFETY: plain queries; a missing window answers null or 0.
    let thread = unsafe {
        let front = GetForegroundWindow();
        if front.is_null() {
            return None;
        }
        GetWindowThreadProcessId(front, std::ptr::null_mut())
    };
    if thread == 0 {
        return None;
    }
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is a valid out pointer with `cbSize` set, as the call requires.
    if unsafe { GetGUIThreadInfo(thread, &mut info) } == 0 || info.hwndFocus.is_null() {
        return None;
    }
    // SAFETY: a plain query on a window handle; a stale handle answers 0.
    let style = unsafe { GetWindowLongW(info.hwndFocus, GWL_STYLE) };
    let edit = class_name(info.hwndFocus)
        .to_ascii_lowercase()
        .contains("edit");
    Some(edit && style & ES_PASSWORD != 0)
}

fn create_automation() -> Option<IUIAutomation> {
    // SAFETY: COM set up for this thread. Already set up (S_FALSE) or set up as a single-threaded
    // apartment (RPC_E_CHANGED_MODE) both leave COM usable; it is never torn down, since the client
    // cached for this thread outlives the call.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    // SAFETY: creating the system's UI Automation client by its documented class ids.
    let automation: IUIAutomation = unsafe {
        CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
            .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
    }
    .ok()?;
    if let Ok(two) = automation.cast::<IUIAutomation2>() {
        // SAFETY: plain setters on a live client; a refusal leaves the default timeouts.
        unsafe {
            let _ = two.SetConnectionTimeout(UIA_TIMEOUT_MS);
            let _ = two.SetTransactionTimeout(UIA_TIMEOUT_MS);
        }
    }
    Some(automation)
}

/// UI Automation's answer for the focused element.
fn automation() -> Option<bool> {
    AUTOMATION
        .try_with(|cell| {
            let mut slot = cell.try_borrow_mut().ok()?;
            if slot.is_none() {
                *slot = create_automation();
            }
            let automation = slot.as_ref()?;
            // SAFETY: calls on a live client and the element it returned; failures are COM errors.
            unsafe {
                let element = automation.GetFocusedElement().ok()?;
                Some(element.CurrentIsPassword().ok()?.as_bool())
            }
        })
        .ok()
        .flatten()
}

/// `Some(true)` if either way says password, `Some(false)` if one answered and neither said so, `None`
/// when neither could answer.
pub fn focused_is_password() -> Option<bool> {
    let classic = classic();
    if classic == Some(true) {
        return Some(true);
    }
    match (classic, automation()) {
        (_, Some(true)) => Some(true),
        (None, None) => None,
        _ => Some(false),
    }
}
