//! `input.type` and `input.key`. Text goes by character (`KEYEVENTF_UNICODE`), never through the
//! clipboard, in batches of at most 32 characters, each checked just before it is sent and then sent one
//! key at a time with a short gap; a line feed is the Enter key and a tab the Tab key. Keys go by hardware
//! scan code.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::args::{parse_hold, text_batches, Mods};
use super::check::{check_chord, check_keyboard, check_text, parse_chord, parse_expect, Chord};
use super::held::Ev;
use super::inject::{release_all, send};
use super::keys::{code_of_key, modifier_codes, presses, releases, KeyCode};
use super::screen::WinScreen;
use super::watch::gate;
use crate::protocol::{ProtoError, Request};

/// How often a held key looks at the owner's latch.
const HOLD_POLL: Duration = Duration::from_millis(10);
/// The gap after each typed character. Sent all at once, Windows 11 Notepad repeated the last letter
/// before a line break (Sitting B), so each key goes in its own call with a short gap.
const CHAR_GAP: Duration = Duration::from_millis(6);
/// The longer gap after Enter or Tab, which can move the focus or start a new line.
const KEY_GAP: Duration = Duration::from_millis(40);

fn text_events(text: &str, enter: KeyCode, tab: KeyCode) -> Vec<Ev> {
    let mut out = Vec::with_capacity(text.len() * 2);
    let mut units = [0u16; 2];
    for c in text.chars() {
        match c {
            '\n' => out.extend([enter.ev(true), enter.ev(false)]),
            '\t' => out.extend([tab.ev(true), tab.ev(false)]),
            _ => {
                for unit in c.encode_utf16(&mut units).iter() {
                    out.push(Ev::Unicode {
                        unit: *unit,
                        down: true,
                    });
                    out.push(Ev::Unicode {
                        unit: *unit,
                        down: false,
                    });
                }
            }
        }
    }
    out
}

/// `input.type`.
pub fn type_text(req: &Request) -> Result<Value, ProtoError> {
    let expect = parse_expect(req)?;
    let text = req.str_arg("text")?;
    let typed = check_text(text)?;
    let enter = code_of_key("enter")?;
    let tab = code_of_key("tab")?;
    let screen = WinScreen;
    for batch in text_batches(text) {
        let events = text_events(batch, enter, tab);
        check_keyboard(gate(), &screen, &expect)?;
        // Each pair is one key's down and up (a character outside the basic plane is two pairs).
        let mut moved = false;
        for pair in events.chunks(2) {
            // Enter or Tab can move the focus (into a password field) or open a window: check again first.
            if moved {
                check_keyboard(gate(), &screen, &expect)?;
            }
            send(pair)?;
            moved = matches!(pair.first(), Some(Ev::Key { .. }));
            std::thread::sleep(if moved { KEY_GAP } else { CHAR_GAP });
        }
    }
    Ok(json!({"typed": typed}))
}

fn owner_active() -> ProtoError {
    ProtoError::refused("owner_active", "the owner is using the keyboard or mouse")
}

/// `input.key`: the chord's modifiers, then its key; held for `hold_ms` while the latch stays clear;
/// released in reverse order. `stop_chord` is the Stop chord in use, never sent.
pub fn key(req: &Request, stop_chord: Option<&Chord>) -> Result<Value, ProtoError> {
    let expect = parse_expect(req)?;
    let chord = parse_chord(req.str_arg("chord")?)?;
    let hold_ms = parse_hold(req)?;
    let mut codes = modifier_codes(Mods::of_chord(&chord))?;
    codes.push(code_of_key(chord.key)?);
    let mut batch = presses(&codes);
    if hold_ms == 0 {
        batch.extend(releases(&codes));
    }
    let screen = WinScreen;
    check_keyboard(gate(), &screen, &expect)?;
    check_chord(&chord, stop_chord)?;
    send(&batch)?;
    if hold_ms > 0 {
        let end = Instant::now() + Duration::from_millis(hold_ms);
        loop {
            let now = Instant::now();
            if now >= end {
                break;
            }
            std::thread::sleep(HOLD_POLL.min(end - now));
            if gate().owner_active {
                release_all();
                return Err(owner_active());
            }
        }
        release_all();
    }
    Ok(json!({}))
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
    fn text_becomes_character_pairs_with_enter_and_tab_as_keys() {
        let enter = KeyCode {
            scan: 0x1C,
            extended: false,
        };
        let tab = KeyCode {
            scan: 0x0F,
            extended: false,
        };
        let evs = text_events("a\n\t😀", enter, tab);
        assert_eq!(evs.len(), 2 + 2 + 2 + 4);
        assert_eq!(
            evs[0],
            Ev::Unicode {
                unit: 0x61,
                down: true
            }
        );
        assert_eq!(evs[2], enter.ev(true));
        assert_eq!(evs[5], tab.ev(false));
        assert_eq!(
            evs[6],
            Ev::Unicode {
                unit: 0xD83D,
                down: true
            }
        );
    }
}
