//! The window list and Show window / Send behind. Built by lane H1 (row 197).

use serde_json::Value;

use crate::dispatch::Context;
use crate::protocol::{ProtoError, Request};

#[cfg(windows)]
pub(crate) mod win;

pub const BUILT: bool = true;

/// What the choice rule needs to know about one top-level window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Candidate {
    pub hwnd: u64,
    pub pid: u32,
    pub visible: bool,
    pub cloaked: bool,
    pub tool_window: bool,
    /// Width and height of the drawn bounds.
    pub width: i32,
    pub height: i32,
}

/// The window a run is shown by: the first candidate that is visible, not cloaked, not a tool window
/// and wider and taller than 0.
pub fn choose_window(candidates: &[Candidate]) -> Option<&Candidate> {
    candidates
        .iter()
        .find(|c| c.visible && !c.cloaked && !c.tool_window && c.width > 0 && c.height > 0)
}

/// Whether a run should leave the window it follows for another one. A window that still exists but is
/// hidden or cloaked (a splash screen that hides instead of closing) is replaced by the window the choice
/// rule finds now; with none found the run keeps it, since a main window minimised to the tray is hidden
/// too. A shown window is never replaced.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn window_to_switch_to(
    current: u64,
    current_visible: bool,
    current_cloaked: bool,
    candidate: Option<(u64, u32)>,
) -> Option<(u64, u32)> {
    if current_visible && !current_cloaked {
        return None;
    }
    candidate.filter(|(hwnd, _)| *hwnd != current)
}

/// `windows.list`: top-level windows, optionally only those of one run's job.
pub fn list(ctx: &mut Context, req: &Request) -> Result<Value, ProtoError> {
    #[cfg(windows)]
    {
        let pids = match req.opt_str_arg("run_id")? {
            Some(id) if crate::protocol::valid_run_id(id) => Some(ctx.runs.job_pids(id)?),
            Some(_) => {
                return Err(ProtoError::bad_request(
                    "run_id must be 1 to 64 characters from A-Z a-z 0-9 _ -",
                ))
            }
            None => None,
        };
        Ok(win::list(pids))
    }
    #[cfg(not(windows))]
    {
        let _ = (ctx, req);
        Err(ProtoError::not_available())
    }
}

/// `window.show`: bring a window forward or send it behind, never minimising it.
pub fn show(req: &Request) -> Result<Value, ProtoError> {
    let hwnd = req.hwnd_arg()?;
    let front = match req.str_arg("mode")? {
        "front" => true,
        "behind" => false,
        _ => {
            return Err(ProtoError::bad_request(
                "mode must be \"front\" or \"behind\"",
            ))
        }
    };
    #[cfg(windows)]
    {
        win::show(hwnd, front)
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd, front);
        Err(ProtoError::not_available())
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

    fn fine(hwnd: u64) -> Candidate {
        Candidate {
            hwnd,
            pid: 10,
            visible: true,
            cloaked: false,
            tool_window: false,
            width: 800,
            height: 600,
        }
    }

    /// A fake screen: what a game start looks like, from a hidden helper window to the real one.
    #[test]
    fn the_first_eligible_window_is_chosen_and_the_rest_are_skipped() {
        let screen = [
            Candidate {
                visible: false,
                ..fine(1)
            },
            Candidate {
                cloaked: true,
                ..fine(2)
            },
            Candidate {
                tool_window: true,
                ..fine(3)
            },
            Candidate {
                width: 0,
                ..fine(4)
            },
            Candidate {
                height: 0,
                ..fine(5)
            },
            fine(6),
            fine(7),
        ];
        assert_eq!(choose_window(&screen).map(|c| c.hwnd), Some(6));
    }

    #[test]
    fn no_eligible_window_means_none() {
        assert_eq!(choose_window(&[]), None);
        let screen = [
            Candidate {
                visible: false,
                ..fine(1)
            },
            Candidate {
                width: -1,
                ..fine(2)
            },
        ];
        assert_eq!(choose_window(&screen), None);
    }

    #[test]
    fn a_splash_is_replaced_by_the_next_choice_once_it_is_gone() {
        let splash = fine(8);
        let real = fine(9);
        assert_eq!(choose_window(&[splash, real]).map(|c| c.hwnd), Some(8));
        assert_eq!(choose_window(&[real]).map(|c| c.hwnd), Some(9));
    }

    #[test]
    fn a_hidden_or_cloaked_window_gives_way_to_a_found_one_and_a_shown_one_never_does() {
        let found = Some((9, 20));
        // Hidden, cloaked, or both: switch to the one found.
        assert_eq!(window_to_switch_to(8, false, false, found), found);
        assert_eq!(window_to_switch_to(8, true, true, found), found);
        assert_eq!(window_to_switch_to(8, false, true, found), found);
        // Shown and not cloaked: keep it, whatever else exists.
        assert_eq!(window_to_switch_to(8, true, false, found), None);
        // Nothing else found (a main window hidden in the tray): keep it.
        assert_eq!(window_to_switch_to(8, false, false, None), None);
        // The search found the same window again: nothing to switch.
        assert_eq!(window_to_switch_to(8, false, false, Some((8, 20))), None);
    }

    #[test]
    fn show_refuses_a_bad_mode_before_it_looks_at_the_window() {
        use crate::protocol::{parse_request, ErrorCode};
        let req =
            parse_request(r#"{"id":1,"op":"window.show","hwnd":1,"mode":"minimize"}"#).unwrap();
        assert_eq!(show(&req).unwrap_err().code, ErrorCode::BadRequest);
        let req = parse_request(r#"{"id":1,"op":"window.show","hwnd":1}"#).unwrap();
        assert_eq!(show(&req).unwrap_err().code, ErrorCode::BadRequest);
    }
}
