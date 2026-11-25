#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::HashMap;

use serde_json::json;

use super::*;
use crate::protocol::{parse_request, ErrorCode};

const GAME: u64 = 100;
const GAME_DIALOG: u64 = 101;
const JENNY: u64 = 200;
const OTHER: u64 = 300;
const ADMIN: u64 = 400;
const STORE_FRAME: u64 = 500;
const MYSTERY: u64 = 600;
const GAME_EXE: &str = r"D:\Work\demo-game\target\release\client.exe";
const JENNY_EXE: &str = r"C:\Program Files\Jenny\Jenny.exe";

struct Win {
    state: WindowState,
    bounds: Rect,
    who: Identity,
}

struct Fake {
    default_desktop: bool,
    windows: HashMap<u64, Win>,
    /// Hit areas, first match wins (topmost first).
    hits: Vec<(Rect, u64)>,
    foreground: Option<u64>,
    password: Option<bool>,
}

fn who(pids: &[u32], program: Option<&str>, elevated: bool) -> Identity {
    Identity {
        pids: pids.to_vec(),
        program: program.map(str::to_owned),
        elevated,
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

impl Fake {
    /// The game at 100,100 (1282 by 752), a Jenny window over its top-left corner, and a few others.
    fn new() -> Self {
        let mut windows = HashMap::new();
        let mut add = |hwnd, bounds, who| {
            windows.insert(
                hwnd,
                Win {
                    state: WindowState::Shown,
                    bounds,
                    who,
                },
            );
        };
        add(
            GAME,
            rect(100, 100, 1282, 752),
            who(&[10], Some(GAME_EXE), false),
        );
        // Another window of the same program, spelled differently: same file.
        add(
            GAME_DIALOG,
            rect(400, 300, 200, 100),
            who(
                &[10],
                Some(r"\\?\D:\WORK\demo-game\target\release\CLIENT.EXE"),
                false,
            ),
        );
        add(
            JENNY,
            rect(100, 100, 50, 50),
            who(&[20], Some(JENNY_EXE), false),
        );
        add(
            OTHER,
            rect(0, 0, 3840, 2160),
            who(&[30], Some(r"C:\Windows\explorer.exe"), false),
        );
        add(ADMIN, rect(1300, 800, 50, 50), who(&[40], None, true));
        // A Store app's frame: the frame host's pid and the app's, the app's program.
        add(
            STORE_FRAME,
            rect(1000, 120, 60, 60),
            who(&[50, 51], Some(GAME_EXE), false),
        );
        add(MYSTERY, rect(1100, 120, 60, 60), who(&[60], None, false));
        let hits = vec![
            (rect(100, 100, 50, 50), JENNY),
            (rect(400, 300, 200, 100), GAME_DIALOG),
            (rect(1300, 800, 50, 50), ADMIN),
            (rect(1000, 120, 60, 60), STORE_FRAME),
            (rect(1100, 120, 60, 60), MYSTERY),
            (rect(100, 100, 1282, 752), GAME),
            (rect(0, 0, 3840, 2160), OTHER),
        ];
        Self {
            default_desktop: true,
            windows,
            hits,
            foreground: Some(GAME),
            password: None,
        }
    }

    fn set_state(&mut self, hwnd: u64, state: WindowState) {
        self.windows.get_mut(&hwnd).unwrap().state = state;
    }
}

impl Screen for Fake {
    fn input_desktop_is_default(&self) -> bool {
        self.default_desktop
    }
    fn window_state(&self, hwnd: u64) -> WindowState {
        self.windows
            .get(&hwnd)
            .map_or(WindowState::Gone, |w| w.state)
    }
    fn bounds(&self, hwnd: u64) -> Option<Rect> {
        self.windows.get(&hwnd).map(|w| w.bounds)
    }
    fn root_at(&self, p: ScreenPoint) -> Option<u64> {
        self.hits
            .iter()
            .find(|(r, _)| contains(*r, p))
            .map(|(_, h)| *h)
    }
    fn foreground_root(&self) -> Option<u64> {
        self.foreground
    }
    fn identify(&self, hwnd: u64) -> Identity {
        self.windows
            .get(&hwnd)
            .map(|w| w.who.clone())
            .unwrap_or_default()
    }
    fn focused_is_password(&self) -> Option<bool> {
        self.password
    }
}

const OPEN: Gate = Gate {
    watch_running: true,
    owner_active: false,
};

fn expect() -> Expect {
    Expect {
        hwnd: GAME,
        program: normalize_path(GAME_EXE),
        deny_pids: vec![20],
        deny_programs: vec![normalize_path(JENNY_EXE)],
    }
}

fn pt(x: i64, y: i64) -> PicturePoint {
    PicturePoint { x, y }
}

fn reason(result: Result<impl std::fmt::Debug, ProtoError>) -> &'static str {
    let err = result.unwrap_err();
    assert_eq!(err.code, ErrorCode::Refused);
    err.reason.unwrap()
}

#[test]
fn paths_compare_without_case_prefix_or_slash_direction() {
    assert_eq!(
        normalize_path(r"\\?\C:\Windows\Notepad.EXE"),
        r"c:\windows\notepad.exe"
    );
    assert_eq!(
        normalize_path("C:/Windows/notepad.exe"),
        r"c:\windows\notepad.exe"
    );
    assert_eq!(
        normalize_path(r"\\?\UNC\Server\Share\a.exe"),
        r"\\server\share\a.exe"
    );
}

#[test]
fn expect_is_parsed_and_bounded() {
    let req = parse_request(
        &json!({"id": 1, "op": "input.click", "expect": {
            "hwnd": 5, "program": r"\\?\C:\A.exe", "deny_pids": [1, 2], "deny_programs": [r"C:\J.exe"]}})
        .to_string(),
    )
    .unwrap();
    let e = parse_expect(&req).unwrap();
    assert_eq!(
        e,
        Expect {
            hwnd: 5,
            program: r"c:\a.exe".to_owned(),
            deny_pids: vec![1, 2],
            deny_programs: vec![r"c:\j.exe".to_owned()],
        }
    );
    let bad = |expect: serde_json::Value| {
        let req =
            parse_request(&json!({"id": 1, "op": "input.click", "expect": expect}).to_string())
                .unwrap();
        parse_expect(&req).unwrap_err().code
    };
    assert_eq!(bad(json!({"program": "C:\\a.exe"})), ErrorCode::BadRequest);
    assert_eq!(
        bad(json!({"hwnd": 0, "program": "C:\\a.exe"})),
        ErrorCode::BadRequest
    );
    assert_eq!(
        bad(json!({"hwnd": 5, "program": " "})),
        ErrorCode::BadRequest
    );
    assert_eq!(
        bad(json!({"hwnd": 5, "program": "C:\\a.exe", "deny_pids": [-1]})),
        ErrorCode::BadRequest
    );
    assert_eq!(
        bad(json!({"hwnd": 5, "program": "C:\\a.exe", "deny_pids": vec![1; 257]})),
        ErrorCode::BadRequest
    );
    let missing = parse_request(r#"{"id":1,"op":"input.click"}"#).unwrap();
    assert_eq!(
        parse_expect(&missing).unwrap_err().code,
        ErrorCode::BadRequest
    );
}

#[test]
fn the_checks_run_in_protocol_order() {
    let mut s = Fake::new();
    let e = expect();
    let shut = Gate {
        watch_running: false,
        owner_active: true,
    };
    s.default_desktop = false;
    assert_eq!(
        reason(check_pointer(shut, &s, &e, 1.0, &[pt(10, 10)])),
        "no_watch"
    );
    let active = Gate {
        watch_running: true,
        owner_active: true,
    };
    assert_eq!(
        reason(check_pointer(active, &s, &e, 1.0, &[pt(10, 10)])),
        "owner_active"
    );
    assert_eq!(reason(check_keyboard(OPEN, &s, &e)), "secure_desktop");
    s.default_desktop = true;
    s.set_state(GAME, WindowState::Minimized);
    assert_eq!(
        reason(check_pointer(OPEN, &s, &e, 1.0, &[pt(10, 10)])),
        "window_gone"
    );
    assert_eq!(reason(check_keyboard(OPEN, &s, &e)), "window_gone");
    s.windows.remove(&GAME);
    assert_eq!(reason(check_focus(OPEN, &s, &e)), "window_gone");
}

#[test]
fn points_map_against_the_bounds_now_at_any_scale_and_monitor() {
    let b = rect(100, 100, 1282, 752);
    assert_eq!(
        map_point(b, 1.0, pt(0, 0)).unwrap(),
        ScreenPoint { x: 100, y: 100 }
    );
    assert_eq!(
        map_point(b, 0.5, pt(320, 200)).unwrap(),
        ScreenPoint { x: 740, y: 500 }
    );
    // The far edge of a downscaled picture stays inside the window.
    assert_eq!(
        map_point(b, 0.5, pt(640, 375)).unwrap(),
        ScreenPoint { x: 1380, y: 850 }
    );
    // A second monitor to the left, at 150 percent: negative coordinates.
    let left = rect(-1924, 200, 1926, 1130);
    assert_eq!(
        map_point(left, 1.0, pt(10, 20)).unwrap(),
        ScreenPoint { x: -1914, y: 220 }
    );
    for outside in [pt(-1, 0), pt(0, -1), pt(1282, 0), pt(0, 752)] {
        assert_eq!(reason(map_point(b, 1.0, outside)), "outside_window");
    }
    assert_eq!(reason(map_point(b, 0.5, pt(641, 0))), "outside_window");
    assert_eq!(
        reason(map_point(rect(0, 0, 0, 10), 1.0, pt(0, 0))),
        "outside_window"
    );
}

#[test]
fn a_pointer_lands_only_on_the_granted_program() {
    let s = Fake::new();
    let e = expect();
    // The middle of the game.
    assert_eq!(
        check_pointer(OPEN, &s, &e, 1.0, &[pt(600, 400)]).unwrap(),
        vec![ScreenPoint { x: 700, y: 500 }]
    );
    // The game's own dialog, a second top-level window of the same program.
    assert!(check_pointer(OPEN, &s, &e, 1.0, &[pt(350, 250)]).is_ok());
    // A Store app's frame whose app is the granted program.
    assert!(check_pointer(OPEN, &s, &e, 1.0, &[pt(910, 30)]).is_ok());
    // A Jenny window over the game, by pid and by program.
    assert_eq!(
        reason(check_pointer(OPEN, &s, &e, 1.0, &[pt(10, 10)])),
        "denied"
    );
    let mut by_program = expect();
    by_program.deny_pids.clear();
    assert_eq!(
        reason(check_pointer(OPEN, &s, &by_program, 1.0, &[pt(10, 10)])),
        "denied"
    );
    // An administrator's window, and one whose program cannot be told.
    assert_eq!(
        reason(check_pointer(OPEN, &s, &e, 1.0, &[pt(1210, 710)])),
        "elevated"
    );
    assert_eq!(
        reason(check_pointer(OPEN, &s, &e, 1.0, &[pt(1010, 30)])),
        "unidentified"
    );
    // Every point of an action is checked: one bad end refuses the whole action.
    assert_eq!(
        reason(check_pointer(
            OPEN,
            &s,
            &e,
            1.0,
            &[pt(600, 400), pt(10, 10)]
        )),
        "denied"
    );
}

#[test]
fn a_point_over_no_window_or_another_program_is_wrong_program() {
    let mut s = Fake::new();
    let e = expect();
    s.hits.retain(|(_, h)| *h != JENNY);
    s.windows.get_mut(&GAME).unwrap().who = who(&[10], Some(r"C:\Other\game.exe"), false);
    assert_eq!(
        reason(check_pointer(OPEN, &s, &e, 1.0, &[pt(600, 400)])),
        "wrong_program"
    );
    s.hits.clear();
    assert_eq!(
        reason(check_pointer(OPEN, &s, &e, 1.0, &[pt(600, 400)])),
        "wrong_program"
    );
}

#[test]
fn a_drag_step_is_checked_against_the_window_as_it_is_now() {
    let mut s = Fake::new();
    let e = expect();
    assert!(check_step(OPEN, &s, &e, ScreenPoint { x: 700, y: 500 }).is_ok());
    // The window moved under the drag: the step's point is now outside it.
    s.windows.get_mut(&GAME).unwrap().bounds = rect(800, 600, 1282, 752);
    assert_eq!(
        reason(check_step(OPEN, &s, &e, ScreenPoint { x: 700, y: 500 })),
        "outside_window"
    );
    // The owner took the mouse mid-drag.
    let active = Gate {
        watch_running: true,
        owner_active: true,
    };
    assert_eq!(
        reason(check_step(active, &s, &e, ScreenPoint { x: 900, y: 700 })),
        "owner_active"
    );
}

#[test]
fn keys_go_only_to_the_granted_program_in_front_and_never_into_a_password_field() {
    let mut s = Fake::new();
    let e = expect();
    assert!(check_keyboard(OPEN, &s, &e).is_ok());
    s.foreground = Some(GAME_DIALOG);
    assert!(check_keyboard(OPEN, &s, &e).is_ok());
    s.password = Some(false);
    assert!(check_keyboard(OPEN, &s, &e).is_ok());
    s.password = Some(true);
    assert_eq!(reason(check_keyboard(OPEN, &s, &e)), "password_field");
    s.password = None;
    s.foreground = Some(JENNY);
    assert_eq!(reason(check_keyboard(OPEN, &s, &e)), "denied");
    s.foreground = Some(OTHER);
    assert_eq!(reason(check_keyboard(OPEN, &s, &e)), "wrong_program");
    s.foreground = None;
    assert_eq!(reason(check_keyboard(OPEN, &s, &e)), "wrong_program");
}

#[test]
fn focus_accepts_a_minimised_window_and_confirms_it_came() {
    let mut s = Fake::new();
    let e = expect();
    s.set_state(GAME, WindowState::Minimized);
    s.foreground = Some(OTHER);
    assert!(check_focus(OPEN, &s, &e).is_ok());
    assert_eq!(reason(confirm_front(&s, &e)), "not_front");
    s.set_state(GAME, WindowState::Shown);
    s.foreground = Some(GAME);
    assert!(confirm_front(&s, &e).is_ok());
    let mut jenny = expect();
    jenny.hwnd = JENNY;
    assert_eq!(reason(check_focus(OPEN, &s, &jenny)), "denied");
}

#[test]
fn chords_parse_strictly() {
    assert_eq!(
        parse_chord("ctrl+shift+s").unwrap(),
        Chord {
            ctrl: true,
            shift: true,
            alt: false,
            key: "s"
        }
    );
    assert_eq!(parse_chord("f5").unwrap().key, "f5");
    for bad in [
        "",
        "Ctrl+s",
        "win+r",
        "meta+r",
        "ctrl+ctrl+s",
        "s+ctrl",
        "ctrl+",
        "ctrl+f13",
        "ctrl+s+t",
    ] {
        assert_eq!(
            parse_chord(bad).unwrap_err().code,
            ErrorCode::BadRequest,
            "{bad}"
        );
    }
    assert!(parse_stop_chord("ctrl+alt+shift+f12").is_ok());
    assert_eq!(
        parse_stop_chord("ctrl+f12").unwrap_err().code,
        ErrorCode::BadRequest
    );
}

#[test]
fn the_never_list_holds_whatever_modifiers_are_added() {
    let stop = parse_stop_chord("ctrl+alt+shift+f12").unwrap();
    for refused in [
        "ctrl+esc",
        "ctrl+shift+esc",
        "alt+tab",
        "alt+shift+tab",
        "ctrl+alt+tab",
        "alt+esc",
        "alt+space",
        "alt+f4",
        "ctrl+alt+delete",
        "ctrl+shift+alt+delete",
        "ctrl+v",
        "ctrl+shift+v",
        "shift+insert",
        "ctrl+alt+shift+f12",
    ] {
        let chord = parse_chord(refused).unwrap();
        assert_eq!(
            reason(check_chord(&chord, Some(&stop))),
            "refused_chord",
            "{refused}"
        );
    }
    for allowed in [
        "ctrl+s",
        "alt+f",
        "f5",
        "space",
        "esc",
        "tab",
        "delete",
        "v",
        "insert",
        "ctrl+delete",
        "ctrl+alt+f12",
        "f4",
    ] {
        let chord = parse_chord(allowed).unwrap();
        assert!(check_chord(&chord, Some(&stop)).is_ok(), "{allowed}");
    }
}

#[test]
fn typed_text_is_bounded_and_holds_no_control_character_but_enter_and_tab() {
    assert_eq!(check_text("line one\n\tline two").unwrap(), 18);
    assert_eq!(check_text("ü").unwrap(), 1);
    assert!(check_text(&"x".repeat(2000)).is_ok());
    for bad in ["", "a\rb", "a\u{1b}b", "a\u{7f}"] {
        assert_eq!(
            check_text(bad).unwrap_err().code,
            ErrorCode::BadRequest,
            "{bad:?}"
        );
    }
    assert_eq!(
        check_text(&"x".repeat(2001)).unwrap_err().code,
        ErrorCode::BadRequest
    );
}
