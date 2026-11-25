//! `input.move`, `input.click`, `input.scroll` and `input.drag`. Every argument is read first; then each
//! injected batch is sent right after the check that covers it. The router lets go of anything still
//! held when the operation returns, on success and on every error.

use serde_json::{json, Value};

use super::args::{
    drag_steps, parse_button, parse_count, parse_duration, parse_modifiers, parse_scroll,
};
use super::check::{
    check_pointer, check_step, parse_expect, parse_point, parse_scale, Expect, PicturePoint,
    ScreenPoint,
};
use super::held::{Button, Ev};
use super::inject::{move_verified, send};
use super::keys::{modifier_codes, presses, releases};
use super::screen::WinScreen;
use super::watch::gate;
use crate::protocol::{ErrorCode, ProtoError, Request};

/// How many times the pointer is aimed again when the window moves between the move and the press.
const AIM_TRIES: usize = 3;

fn screen_json(p: ScreenPoint) -> Value {
    json!({"x": p.x, "y": p.y})
}

fn internal(message: &str) -> ProtoError {
    ProtoError::new(ErrorCode::Internal, message)
}

fn first(points: &[ScreenPoint]) -> Result<ScreenPoint, ProtoError> {
    points
        .first()
        .copied()
        .ok_or_else(|| internal("the check mapped no point"))
}

fn button(button: Button, down: bool) -> Ev {
    Ev::Button { button, down }
}

/// The pointer on the point's pixel, then the check again: the second check is the one right before the
/// caller's batch, and it must map the point where the pointer already is.
fn aim(
    screen: &WinScreen,
    expect: &Expect,
    scale: f64,
    point: PicturePoint,
) -> Result<ScreenPoint, ProtoError> {
    for _ in 0..AIM_TRIES {
        let target = first(&check_pointer(gate(), screen, expect, scale, &[point])?)?;
        move_verified(target)?;
        let again = first(&check_pointer(gate(), screen, expect, scale, &[point])?)?;
        if again == target {
            return Ok(target);
        }
    }
    Err(internal("the window kept moving under the point"))
}

/// `input.move`.
pub fn move_to(req: &Request) -> Result<Value, ProtoError> {
    let expect = parse_expect(req)?;
    let scale = parse_scale(req)?;
    let point = parse_point(req, "point")?;
    let screen = WinScreen;
    let target = first(&check_pointer(gate(), &screen, &expect, scale, &[point])?)?;
    move_verified(target)?;
    Ok(json!({"screen": screen_json(target)}))
}

/// `input.click`: the modifiers, every press and release of `count` clicks and the modifiers' release in
/// one batch, so Windows sees a double or triple click.
pub fn click(req: &Request) -> Result<Value, ProtoError> {
    let expect = parse_expect(req)?;
    let scale = parse_scale(req)?;
    let point = parse_point(req, "point")?;
    let which = parse_button(req)?;
    let count = parse_count(req)?;
    let mods = modifier_codes(parse_modifiers(req)?)?;
    let mut batch = presses(&mods);
    for _ in 0..count {
        batch.push(button(which, true));
        batch.push(button(which, false));
    }
    batch.extend(releases(&mods));
    let screen = WinScreen;
    let target = aim(&screen, &expect, scale, point)?;
    send(&batch)?;
    Ok(json!({"screen": screen_json(target)}))
}

/// `input.scroll`: `dy` and `dx` notches in one batch.
pub fn scroll(req: &Request) -> Result<Value, ProtoError> {
    let expect = parse_expect(req)?;
    let scale = parse_scale(req)?;
    let point = parse_point(req, "point")?;
    let (dy, dx) = parse_scroll(req)?;
    let delta = |notches: i32| notches * 120;
    let mut batch = Vec::new();
    if dy != 0 {
        batch.push(Ev::Wheel {
            horizontal: false,
            delta: delta(dy),
        });
    }
    if dx != 0 {
        batch.push(Ev::Wheel {
            horizontal: true,
            delta: delta(dx),
        });
    }
    let screen = WinScreen;
    let target = aim(&screen, &expect, scale, point)?;
    send(&batch)?;
    Ok(json!({"screen": screen_json(target)}))
}

/// `input.drag`: press at `from`, step along the line at most 16 ms apart, release at `to`. Every step is
/// checked again (the window, the point inside it, the program under it, the owner's latch); a refused
/// step stops the drag and the router lets go of the button and the modifiers.
pub fn drag(req: &Request) -> Result<Value, ProtoError> {
    let expect = parse_expect(req)?;
    let scale = parse_scale(req)?;
    let from = parse_point(req, "from")?;
    let to = parse_point(req, "to")?;
    let which = parse_button(req)?;
    let mods = modifier_codes(parse_modifiers(req)?)?;
    let duration_ms = parse_duration(req)?;
    let screen = WinScreen;

    let ends = check_pointer(gate(), &screen, &expect, scale, &[from, to])?;
    let (Some(&start), Some(&end)) = (ends.first(), ends.get(1)) else {
        return Err(internal("the check mapped no points"));
    };
    let (steps, wait) = drag_steps(start, end, duration_ms);
    move_verified(start)?;

    let mut press = presses(&mods);
    press.push(button(which, true));
    check_step(gate(), &screen, &expect, start)?;
    send(&press)?;

    let last = steps.len().saturating_sub(1);
    for (i, step) in steps.iter().enumerate() {
        std::thread::sleep(wait);
        let mut batch = vec![Ev::Move {
            x: step.x,
            y: step.y,
        }];
        if i == last {
            batch.push(button(which, false));
            batch.extend(releases(&mods));
        }
        check_step(gate(), &screen, &expect, *step)?;
        send(&batch)?;
    }
    Ok(json!({"from": screen_json(start), "to": screen_json(end)}))
}
