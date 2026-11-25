//! The arguments of the input and watch operations that `check.rs` does not read, and the plain
//! arithmetic of a drag and a long text. Every one is validated here, before any check.

use std::time::Duration;

use serde_json::Value;

use super::check::{parse_stop_chord, Chord, ScreenPoint};
use super::held::Button;
use crate::protocol::{ProtoError, Request};

/// The Stop chord when `watch.start` names none.
pub const DEFAULT_STOP_CHORD: &str = "ctrl+alt+shift+f12";
/// Longest gap between two steps of a drag.
pub const DRAG_STEP_MS: u64 = 16;
/// Most characters one injected batch of `input.type` carries.
pub const TEXT_BATCH: usize = 32;
/// Most wheel notches one `input.scroll` turns, each way.
pub const MAX_NOTCHES: i64 = 20;

/// Modifier keys held for a click, a drag or a chord.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

impl Mods {
    pub fn of_chord(chord: &Chord) -> Self {
        Self {
            ctrl: chord.ctrl,
            shift: chord.shift,
            alt: chord.alt,
        }
    }
}

/// `watch.start`'s settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchSettings {
    pub stop_chord: Chord,
    pub move_px: u32,
    pub move_ms: u32,
}

fn bad(message: impl Into<String>) -> ProtoError {
    ProtoError::bad_request(message)
}

/// `button`: `"left"` (default), `"right"` or `"middle"`.
pub fn parse_button(req: &Request) -> Result<Button, ProtoError> {
    match req.opt_str_arg("button")? {
        None | Some("left") => Ok(Button::Left),
        Some("right") => Ok(Button::Right),
        Some("middle") => Ok(Button::Middle),
        Some(_) => Err(bad("button must be left, right or middle")),
    }
}

/// `modifiers`: an array of `"shift"`, `"ctrl"`, `"alt"`, each at most once; none by default.
pub fn parse_modifiers(req: &Request) -> Result<Mods, ProtoError> {
    let items = match req.args.get("modifiers") {
        None | Some(Value::Null) => return Ok(Mods::default()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(bad("modifiers must be an array")),
    };
    let mut mods = Mods::default();
    for item in items {
        let slot = match item.as_str() {
            Some("ctrl") => &mut mods.ctrl,
            Some("shift") => &mut mods.shift,
            Some("alt") => &mut mods.alt,
            _ => return Err(bad("modifiers are shift, ctrl and alt")),
        };
        if *slot {
            return Err(bad("modifiers name a key twice"));
        }
        *slot = true;
    }
    Ok(mods)
}

/// `count`: 1 to 3, default 1.
pub fn parse_count(req: &Request) -> Result<u32, ProtoError> {
    Ok(req.u64_arg("count", 1, 1, 3)? as u32)
}

/// `duration_ms` of a drag: 100 to 2000, default 200.
pub fn parse_duration(req: &Request) -> Result<u64, ProtoError> {
    req.u64_arg("duration_ms", 200, 100, 2000)
}

/// `hold_ms` of a key: 0 to 2000, default 0.
pub fn parse_hold(req: &Request) -> Result<u64, ProtoError> {
    req.u64_arg("hold_ms", 0, 0, 2000)
}

fn notches(req: &Request, key: &str) -> Result<i32, ProtoError> {
    match req.args.get(key) {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value
            .as_i64()
            .filter(|n| (-MAX_NOTCHES..=MAX_NOTCHES).contains(n))
            .and_then(|n| i32::try_from(n).ok())
            .ok_or_else(|| bad(format!("{key} must be a whole number from -20 to 20"))),
    }
}

/// `dy` and `dx` of a scroll, in wheel notches; not both 0.
pub fn parse_scroll(req: &Request) -> Result<(i32, i32), ProtoError> {
    let dy = notches(req, "dy")?;
    let dx = notches(req, "dx")?;
    if dy == 0 && dx == 0 {
        return Err(bad("dy and dx cannot both be 0"));
    }
    Ok((dy, dx))
}

/// `watch.start`'s arguments.
pub fn parse_watch(req: &Request) -> Result<WatchSettings, ProtoError> {
    let chord = req.opt_str_arg("stop_chord")?.unwrap_or(DEFAULT_STOP_CHORD);
    let stop_chord = parse_stop_chord(chord)?;
    let move_px = req.u64_arg("move_px", 18, 8, 100)? as u32;
    let move_ms = req.u64_arg("move_ms", 200, 50, 1000)? as u32;
    Ok(WatchSettings {
        stop_chord,
        move_px,
        move_ms,
    })
}

fn lerp(a: i32, b: i32, f: f64) -> i32 {
    (f64::from(a) + (f64::from(b) - f64::from(a)) * f).round() as i32
}

/// The steps of a drag after the press at `from`: points along the straight line, the last one `to`, and
/// the wait before each (at most [`DRAG_STEP_MS`]).
pub fn drag_steps(
    from: ScreenPoint,
    to: ScreenPoint,
    duration_ms: u64,
) -> (Vec<ScreenPoint>, Duration) {
    let n = duration_ms.div_ceil(DRAG_STEP_MS).max(1);
    let points = (1..=n)
        .map(|i| {
            let f = i as f64 / n as f64;
            ScreenPoint {
                x: lerp(from.x, to.x, f),
                y: lerp(from.y, to.y, f),
            }
        })
        .collect();
    (points, Duration::from_micros(duration_ms * 1000 / n))
}

/// Text cut into batches of at most [`TEXT_BATCH`] characters, never inside a character.
pub fn text_batches(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let cut = rest
            .char_indices()
            .nth(TEXT_BATCH)
            .map_or(rest.len(), |(i, _)| i);
        let (head, tail) = rest.split_at(cut);
        out.push(head);
        rest = tail;
    }
    out
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
    use crate::protocol::{parse_request, ErrorCode};
    use serde_json::json;

    fn req(value: Value) -> Request {
        parse_request(&value.to_string()).unwrap()
    }

    fn is_bad<T: std::fmt::Debug>(result: Result<T, ProtoError>) {
        assert_eq!(result.unwrap_err().code, ErrorCode::BadRequest);
    }

    #[test]
    fn buttons_modifiers_and_counts_follow_the_protocol() {
        assert_eq!(
            parse_button(&req(json!({"id":1,"op":"x"}))).unwrap(),
            Button::Left
        );
        assert_eq!(
            parse_button(&req(json!({"id":1,"op":"x","button":"middle"}))).unwrap(),
            Button::Middle
        );
        is_bad(parse_button(&req(json!({"id":1,"op":"x","button":"x1"}))));
        let mods = parse_modifiers(&req(json!({"id":1,"op":"x","modifiers":["alt","ctrl"]})));
        assert_eq!(
            mods.unwrap(),
            Mods {
                ctrl: true,
                shift: false,
                alt: true
            }
        );
        is_bad(parse_modifiers(&req(
            json!({"id":1,"op":"x","modifiers":["win"]}),
        )));
        is_bad(parse_modifiers(&req(
            json!({"id":1,"op":"x","modifiers":["alt","alt"]}),
        )));
        is_bad(parse_modifiers(&req(
            json!({"id":1,"op":"x","modifiers":"alt"}),
        )));
        assert_eq!(parse_count(&req(json!({"id":1,"op":"x"}))).unwrap(), 1);
        is_bad(parse_count(&req(json!({"id":1,"op":"x","count":4}))));
        is_bad(parse_count(&req(json!({"id":1,"op":"x","count":0}))));
        is_bad(parse_duration(&req(
            json!({"id":1,"op":"x","duration_ms":50}),
        )));
        is_bad(parse_hold(&req(json!({"id":1,"op":"x","hold_ms":2001}))));
    }

    #[test]
    fn a_scroll_needs_some_turn_within_twenty_notches() {
        assert_eq!(
            parse_scroll(&req(json!({"id":1,"op":"x","dy":-3}))).unwrap(),
            (-3, 0)
        );
        assert_eq!(
            parse_scroll(&req(json!({"id":1,"op":"x","dx":20,"dy":1}))).unwrap(),
            (1, 20)
        );
        is_bad(parse_scroll(&req(json!({"id":1,"op":"x"}))));
        is_bad(parse_scroll(&req(json!({"id":1,"op":"x","dy":21}))));
        is_bad(parse_scroll(&req(json!({"id":1,"op":"x","dy":1.5}))));
    }

    #[test]
    fn watch_settings_default_and_refuse_a_one_modifier_chord() {
        let s = parse_watch(&req(json!({"id":1,"op":"watch.start"}))).unwrap();
        assert_eq!(s.stop_chord.key, "f12");
        assert!(s.stop_chord.ctrl && s.stop_chord.alt && s.stop_chord.shift);
        assert_eq!((s.move_px, s.move_ms), (18, 200));
        is_bad(parse_watch(&req(
            json!({"id":1,"op":"watch.start","stop_chord":"ctrl+f11"}),
        )));
        is_bad(parse_watch(&req(
            json!({"id":1,"op":"watch.start","move_px":101}),
        )));
        is_bad(parse_watch(&req(
            json!({"id":1,"op":"watch.start","move_ms":49}),
        )));
    }

    #[test]
    fn drag_steps_end_at_the_target_at_most_sixteen_ms_apart() {
        let from = ScreenPoint { x: -100, y: 10 };
        let to = ScreenPoint { x: 100, y: 50 };
        for duration in [100, 200, 333, 2000] {
            let (steps, wait) = drag_steps(from, to, duration);
            assert_eq!(*steps.last().unwrap(), to);
            assert!(wait <= Duration::from_millis(DRAG_STEP_MS), "{duration}");
            assert!(wait * steps.len() as u32 <= Duration::from_millis(duration));
        }
        let (steps, _) = drag_steps(from, to, 200);
        assert_eq!(steps.len(), 13);
        assert!(steps.windows(2).all(|w| w[0].x <= w[1].x));
    }

    #[test]
    fn text_is_cut_on_characters() {
        let text = "é".repeat(70);
        let batches = text_batches(&text);
        assert_eq!(
            batches
                .iter()
                .map(|b| b.chars().count())
                .collect::<Vec<_>>(),
            vec![32, 32, 6]
        );
        assert_eq!(batches.concat(), text);
        assert_eq!(text_batches("hi"), vec!["hi"]);
    }
}
