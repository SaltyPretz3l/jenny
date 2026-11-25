//! The check at the moment of input (row 196). The service decides what a chat may do; the helper refuses,
//! in the same call that injects, any input the grant in `expect` does not cover. Pure logic over a
//! [`Screen`], so it is tested against a fake screen; the Windows screen and the injection call it right
//! before each `SendInput`, never earlier and never in another process.
//!
//! Order of the checks and their reasons: `PROTOCOL.md`, "The guard". A refusal never moves a point to make
//! it pass.

use serde_json::Value;

use crate::geometry::Rect;
use crate::protocol::{ProtoError, Request, MAX_ID};

/// Most entries `deny_pids` and `deny_programs` may hold.
pub const MAX_DENY: usize = 256;
/// Bounds of a pointer operation's `scale`.
pub const MIN_SCALE: f64 = 0.05;
pub const MAX_SCALE: f64 = 4.0;
/// Most characters one `input.type` sends.
pub const MAX_TEXT_CHARS: usize = 2000;

/// The keys a chord may name. Each maps to one hardware scan code in the injector.
pub const KEYS: &[&str] = &[
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
    "enter",
    "esc",
    "tab",
    "space",
    "backspace",
    "delete",
    "insert",
    "home",
    "end",
    "pageup",
    "pagedown",
    "up",
    "down",
    "left",
    "right",
    "minus",
    "equals",
    "comma",
    "period",
    "slash",
    "semicolon",
    "quote",
    "backquote",
    "bracketleft",
    "bracketright",
    "backslash",
];

/// The grant one input request carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expect {
    pub hwnd: u64,
    /// Normalised with [`normalize_path`].
    pub program: String,
    pub deny_pids: Vec<u32>,
    /// Normalised with [`normalize_path`].
    pub deny_programs: Vec<String>,
}

/// What the watch says right now. The injector reads it from the watch's atomics just before checking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gate {
    pub watch_running: bool,
    pub owner_active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowState {
    Gone,
    Hidden,
    Minimized,
    Shown,
}

/// Who a top-level window belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Identity {
    /// Every process the window belongs to: its own and, for a Store app, the app's inside the frame.
    pub pids: Vec<u32>,
    /// The real program's file, normalised; `None` when it cannot be told.
    pub program: Option<String>,
    /// The real program's process runs as administrator, or could not be opened to ask.
    pub elevated: bool,
}

/// A point in the window's picture (`capture` with `area` `"bounds"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PicturePoint {
    pub x: i64,
    pub y: i64,
}

/// A physical pixel on the virtual desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenPoint {
    pub x: i32,
    pub y: i32,
}

/// What the check asks of Windows. Every answer is read at the moment of the call.
pub trait Screen {
    /// The desktop taking input is the owner's (not the lock screen, an elevation prompt or Ctrl+Alt+Del).
    fn input_desktop_is_default(&self) -> bool;
    fn window_state(&self, hwnd: u64) -> WindowState;
    /// The window's drawn bounds.
    fn bounds(&self, hwnd: u64) -> Option<Rect>;
    /// The top-level window under a screen point, if any.
    fn root_at(&self, point: ScreenPoint) -> Option<u64>;
    /// The top-level window in front, if any.
    fn foreground_root(&self) -> Option<u64>;
    fn identify(&self, hwnd: u64) -> Identity;
    /// Whether the focused field is a password field; `None` when Windows cannot say.
    fn focused_is_password(&self) -> Option<bool>;
}

/// A chord: zero or more modifiers and one key from [`KEYS`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub key: &'static str,
}

impl Chord {
    fn modifiers(&self) -> usize {
        usize::from(self.ctrl) + usize::from(self.shift) + usize::from(self.alt)
    }

    /// True when `self` holds every modifier of `rule` and the same key.
    fn covers(&self, rule: &Chord) -> bool {
        self.key == rule.key
            && (self.ctrl || !rule.ctrl)
            && (self.shift || !rule.shift)
            && (self.alt || !rule.alt)
    }
}

/// Lower case, `/` as `\`, any `\\?\` (or `\\?\UNC\`) prefix removed, so two spellings of one file compare equal.
pub fn normalize_path(path: &str) -> String {
    let path = path.replace('/', "\\");
    let path = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        path
    };
    path.to_lowercase()
}

fn bad(message: &str) -> ProtoError {
    ProtoError::bad_request(message)
}

/// Read `expect` from a request.
pub fn parse_expect(req: &Request) -> Result<Expect, ProtoError> {
    let Some(Value::Object(map)) = req.args.get("expect") else {
        return Err(bad("expect must be an object"));
    };
    let hwnd = match map.get("hwnd").and_then(Value::as_u64) {
        Some(h) if h != 0 && h <= MAX_ID => h,
        _ => return Err(bad("expect.hwnd must be a window handle")),
    };
    let program = match map.get("program") {
        Some(Value::String(p)) if !p.trim().is_empty() && !p.contains('\0') => normalize_path(p),
        _ => return Err(bad("expect.program must be a program's path")),
    };
    let deny_pids = match map.get("deny_pids") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) if items.len() <= MAX_DENY => items
            .iter()
            .map(|v| v.as_u64().and_then(|n| u32::try_from(n).ok()))
            .collect::<Option<Vec<u32>>>()
            .ok_or_else(|| bad("expect.deny_pids must hold process ids"))?,
        _ => {
            return Err(bad(
                "expect.deny_pids must be an array of at most 256 process ids",
            ))
        }
    };
    let deny_programs = match map.get("deny_programs") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) if items.len() <= MAX_DENY => items
            .iter()
            .map(|v| v.as_str().filter(|s| !s.contains('\0')).map(normalize_path))
            .collect::<Option<Vec<String>>>()
            .ok_or_else(|| bad("expect.deny_programs must hold paths"))?,
        _ => {
            return Err(bad(
                "expect.deny_programs must be an array of at most 256 paths",
            ))
        }
    };
    Ok(Expect {
        hwnd,
        program,
        deny_pids,
        deny_programs,
    })
}

/// Read a pointer operation's `scale`.
pub fn parse_scale(req: &Request) -> Result<f64, ProtoError> {
    match req.args.get("scale").and_then(Value::as_f64) {
        Some(s) if s.is_finite() && (MIN_SCALE..=MAX_SCALE).contains(&s) => Ok(s),
        _ => Err(bad("scale must be a number from 0.05 to 4")),
    }
}

/// Read a point argument (`point`, `from`, `to`).
pub fn parse_point(req: &Request, key: &str) -> Result<PicturePoint, ProtoError> {
    let Some(Value::Object(map)) = req.args.get(key) else {
        return Err(ProtoError::bad_request(format!("{key} must be a point")));
    };
    match (
        map.get("x").and_then(Value::as_i64),
        map.get("y").and_then(Value::as_i64),
    ) {
        (Some(x), Some(y)) => Ok(PicturePoint { x, y }),
        _ => Err(ProtoError::bad_request(format!(
            "{key} must have whole-number x and y"
        ))),
    }
}

/// Parse a chord such as `ctrl+shift+s`. Lower case only; the modifiers come first, once each; no name for
/// the Windows key.
pub fn parse_chord(text: &str) -> Result<Chord, ProtoError> {
    let parts: Vec<&str> = text.split('+').collect();
    let Some((key, mods)) = parts.split_last() else {
        return Err(bad("chord is empty"));
    };
    let key = KEYS
        .iter()
        .copied()
        .find(|k| k == key)
        .ok_or_else(|| bad("chord names a key that is not on the list"))?;
    let mut chord = Chord {
        ctrl: false,
        shift: false,
        alt: false,
        key,
    };
    for m in mods {
        let slot = match *m {
            "ctrl" => &mut chord.ctrl,
            "shift" => &mut chord.shift,
            "alt" => &mut chord.alt,
            _ => return Err(bad("chord modifiers are ctrl, shift and alt")),
        };
        if *slot {
            return Err(bad("chord names a modifier twice"));
        }
        *slot = true;
    }
    Ok(chord)
}

/// A Stop chord: a chord with at least two modifiers, so no key a program uses alone can be it.
pub fn parse_stop_chord(text: &str) -> Result<Chord, ProtoError> {
    let chord = parse_chord(text)?;
    if chord.modifiers() < 2 {
        return Err(bad("stop_chord needs at least two modifiers"));
    }
    Ok(chord)
}

/// The never list: refused whatever other modifiers are added.
const NEVER: &[(bool, bool, bool, &str)] = &[
    // (ctrl, shift, alt, key)
    (true, false, false, "esc"),
    (false, false, true, "tab"),
    (false, false, true, "esc"),
    (false, false, true, "space"),
    (false, false, true, "f4"),
    (true, false, true, "delete"),
    (true, false, false, "v"),
    (false, true, false, "insert"),
];

/// Refuse a chord on the never list, or one that holds the Stop chord in use.
pub fn check_chord(chord: &Chord, stop_chord: Option<&Chord>) -> Result<(), ProtoError> {
    let on_list = NEVER.iter().any(|&(ctrl, shift, alt, key)| {
        chord.covers(&Chord {
            ctrl,
            shift,
            alt,
            key,
        })
    });
    if on_list || stop_chord.is_some_and(|stop| chord.covers(stop)) {
        return Err(ProtoError::refused(
            "refused_chord",
            "that key combination is never sent",
        ));
    }
    Ok(())
}

/// Check `input.type`'s text: 1 to 2000 characters, no control character but line feed and tab.
pub fn check_text(text: &str) -> Result<usize, ProtoError> {
    let count = text.chars().count();
    if count == 0 || count > MAX_TEXT_CHARS {
        return Err(bad("text must be 1 to 2000 characters"));
    }
    if text
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(bad(
            "text holds a control character other than a line feed or a tab",
        ));
    }
    Ok(count)
}

/// The checks every input shares, in protocol order up to `window_gone`. Returns the window's bounds, or
/// `None` for a minimised window when `allow_minimized` (only `input.focus`).
fn check_common(
    gate: Gate,
    screen: &dyn Screen,
    expect: &Expect,
    allow_minimized: bool,
) -> Result<Option<Rect>, ProtoError> {
    if !gate.watch_running {
        return Err(ProtoError::refused(
            "no_watch",
            "the owner's watch is not running",
        ));
    }
    if gate.owner_active {
        return Err(ProtoError::refused(
            "owner_active",
            "the owner is using the keyboard or mouse",
        ));
    }
    if !screen.input_desktop_is_default() {
        return Err(ProtoError::refused(
            "secure_desktop",
            "the desktop taking input is not the owner's",
        ));
    }
    let gone = || ProtoError::refused("window_gone", "the granted window is gone or not shown");
    match screen.window_state(expect.hwnd) {
        WindowState::Gone => Err(gone()),
        WindowState::Hidden | WindowState::Minimized if allow_minimized => Ok(None),
        WindowState::Hidden | WindowState::Minimized => Err(gone()),
        WindowState::Shown => screen.bounds(expect.hwnd).map(Some).ok_or_else(gone),
    }
}

/// Refuse input to `root` unless it belongs to the granted program, is not denied and not elevated.
fn check_target(screen: &dyn Screen, expect: &Expect, root: Option<u64>) -> Result<(), ProtoError> {
    let wrong = || {
        ProtoError::refused(
            "wrong_program",
            "the window that would get the input belongs to another program",
        )
    };
    let Some(root) = root else {
        return Err(wrong());
    };
    let who = screen.identify(root);
    let program = who.program.as_deref().map(normalize_path);
    let denied = who.pids.iter().any(|pid| expect.deny_pids.contains(pid))
        || program
            .as_ref()
            .is_some_and(|p| expect.deny_programs.contains(p));
    if denied {
        return Err(ProtoError::refused(
            "denied",
            "the window that would get the input is never touched",
        ));
    }
    if who.elevated {
        return Err(ProtoError::refused(
            "elevated",
            "the window that would get the input runs as administrator",
        ));
    }
    match program {
        None => Err(ProtoError::refused(
            "unidentified",
            "the program of the window that would get the input cannot be told",
        )),
        Some(p) if p != expect.program => Err(wrong()),
        Some(_) => Ok(()),
    }
}

/// Map a picture point onto the screen against the window's bounds now. Refused when it lies outside the
/// picture.
pub fn map_point(bounds: Rect, scale: f64, point: PicturePoint) -> Result<ScreenPoint, ProtoError> {
    let outside = || ProtoError::refused("outside_window", "the point lies outside the window");
    if bounds.width <= 0 || bounds.height <= 0 || !(scale.is_finite() && scale > 0.0) {
        return Err(outside());
    }
    let picture_w = (f64::from(bounds.width) * scale).round() as i64;
    let picture_h = (f64::from(bounds.height) * scale).round() as i64;
    if point.x < 0 || point.y < 0 || point.x >= picture_w || point.y >= picture_h {
        return Err(outside());
    }
    // Inside the picture maps inside the bounds; the clamp only absorbs rounding at the far edge.
    let dx = ((point.x as f64) / scale).round() as i64;
    let dy = ((point.y as f64) / scale).round() as i64;
    let dx = dx.min(i64::from(bounds.width) - 1);
    let dy = dy.min(i64::from(bounds.height) - 1);
    let x = i64::from(bounds.x) + dx;
    let y = i64::from(bounds.y) + dy;
    match (i32::try_from(x), i32::try_from(y)) {
        (Ok(x), Ok(y)) => Ok(ScreenPoint { x, y }),
        _ => Err(outside()),
    }
}

fn contains(bounds: Rect, p: ScreenPoint) -> bool {
    p.x >= bounds.x && p.y >= bounds.y && p.x < bounds.right() && p.y < bounds.bottom()
}

/// A pointer action's check: map every point and check the window under each. Returns the screen points,
/// in order.
pub fn check_pointer(
    gate: Gate,
    screen: &dyn Screen,
    expect: &Expect,
    scale: f64,
    points: &[PicturePoint],
) -> Result<Vec<ScreenPoint>, ProtoError> {
    let bounds = check_common(gate, screen, expect, false)?
        .ok_or_else(|| ProtoError::refused("window_gone", "the granted window is not shown"))?;
    let mapped = points
        .iter()
        .map(|p| map_point(bounds, scale, *p))
        .collect::<Result<Vec<_>, _>>()?;
    for p in &mapped {
        check_target(screen, expect, screen.root_at(*p))?;
    }
    Ok(mapped)
}

/// One step of a drag, already on the screen: everything again, the point inside the window's bounds now,
/// and the window under it.
pub fn check_step(
    gate: Gate,
    screen: &dyn Screen,
    expect: &Expect,
    point: ScreenPoint,
) -> Result<(), ProtoError> {
    let bounds = check_common(gate, screen, expect, false)?
        .ok_or_else(|| ProtoError::refused("window_gone", "the granted window is not shown"))?;
    if !contains(bounds, point) {
        return Err(ProtoError::refused(
            "outside_window",
            "the drag's path leaves the window",
        ));
    }
    check_target(screen, expect, screen.root_at(point))
}

/// `input.type` and `input.key`: the window in front belongs to the granted program and the focused field
/// is not a password field.
pub fn check_keyboard(gate: Gate, screen: &dyn Screen, expect: &Expect) -> Result<(), ProtoError> {
    check_common(gate, screen, expect, false)?;
    check_target(screen, expect, screen.foreground_root())?;
    if screen.focused_is_password() == Some(true) {
        return Err(ProtoError::refused(
            "password_field",
            "the focused field is a password field",
        ));
    }
    Ok(())
}

/// `input.focus`, before: the granted window itself may be minimised, but must be the granted program's.
pub fn check_focus(gate: Gate, screen: &dyn Screen, expect: &Expect) -> Result<(), ProtoError> {
    check_common(gate, screen, expect, true)?;
    check_target(screen, expect, Some(expect.hwnd))
}

/// `input.focus`, after: the granted window is the one in front.
pub fn confirm_front(screen: &dyn Screen, expect: &Expect) -> Result<(), ProtoError> {
    if screen.foreground_root() == Some(expect.hwnd)
        && screen.window_state(expect.hwnd) == WindowState::Shown
    {
        Ok(())
    } else {
        Err(ProtoError::refused(
            "not_front",
            "the window did not come to the front",
        ))
    }
}

#[cfg(test)]
#[path = "check_tests.rs"]
mod tests;
