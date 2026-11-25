//! The input events the injector sends and the record of what they leave held down. Pure: the one
//! injection site (`inject.rs`) applies each event Windows took, so the record is always what is down.

/// A mouse button the protocol names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// One input event, in screen terms. Windows' own form is built at the moment it is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ev {
    /// Move the pointer to a physical pixel of the virtual desktop.
    Move {
        x: i32,
        y: i32,
    },
    Button {
        button: Button,
        down: bool,
    },
    /// A wheel turn in `WHEEL_DELTA` units: vertical (up positive) or horizontal (right positive).
    Wheel {
        horizontal: bool,
        delta: i32,
    },
    /// A key by hardware scan code.
    Key {
        scan: u16,
        extended: bool,
        down: bool,
    },
    /// One UTF-16 unit of text.
    Unicode {
        unit: u16,
        down: bool,
    },
}

/// Something this helper pressed and has not let go of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pressed {
    Button(Button),
    Key { scan: u16, extended: bool },
    Unicode(u16),
}

impl Pressed {
    /// The event that lets go of it.
    pub fn release(self) -> Ev {
        match self {
            Pressed::Button(button) => Ev::Button {
                button,
                down: false,
            },
            Pressed::Key { scan, extended } => Ev::Key {
                scan,
                extended,
                down: false,
            },
            Pressed::Unicode(unit) => Ev::Unicode { unit, down: false },
        }
    }
}

impl Ev {
    /// What the event presses or lets go of, and whether it presses.
    fn pressed(self) -> Option<(Pressed, bool)> {
        match self {
            Ev::Button { button, down } => Some((Pressed::Button(button), down)),
            Ev::Key {
                scan,
                extended,
                down,
            } => Some((Pressed::Key { scan, extended }, down)),
            Ev::Unicode { unit, down } => Some((Pressed::Unicode(unit), down)),
            Ev::Move { .. } | Ev::Wheel { .. } => None,
        }
    }

    /// True for an event that only lets go of something: always allowed, even with the latch set.
    pub fn is_release(self) -> bool {
        matches!(self.pressed(), Some((_, false)))
    }
}

/// Every key and button held down by this helper, in the order pressed.
#[derive(Debug, Default)]
pub struct Held {
    down: Vec<Pressed>,
}

impl Held {
    pub const fn new() -> Self {
        Self { down: Vec::new() }
    }

    /// Record one event Windows took.
    pub fn apply(&mut self, ev: Ev) {
        let Some((what, down)) = ev.pressed() else {
            return;
        };
        let at = self.down.iter().position(|p| *p == what);
        match (down, at) {
            (true, None) => self.down.push(what),
            (false, Some(index)) => {
                self.down.remove(index);
            }
            _ => {}
        }
    }

    pub fn len(&self) -> usize {
        self.down.len()
    }

    pub fn is_empty(&self) -> bool {
        self.down.is_empty()
    }

    /// The events that let go of everything held, last pressed first. The record changes only as
    /// [`Held::apply`] is given the ones Windows took.
    pub fn releases(&self) -> Vec<Ev> {
        self.down.iter().rev().map(|p| p.release()).collect()
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

    fn key(scan: u16, down: bool) -> Ev {
        Ev::Key {
            scan,
            extended: false,
            down,
        }
    }

    #[test]
    fn presses_are_recorded_and_released_last_first() {
        let mut held = Held::new();
        for ev in [
            key(0x1D, true),
            key(0x2A, true),
            Ev::Move { x: 3, y: 4 },
            Ev::Button {
                button: Button::Left,
                down: true,
            },
        ] {
            held.apply(ev);
        }
        assert_eq!(held.len(), 3);
        let ups = held.releases();
        assert_eq!(
            ups,
            vec![
                Ev::Button {
                    button: Button::Left,
                    down: false
                },
                key(0x2A, false),
                key(0x1D, false),
            ]
        );
        for ev in &ups {
            held.apply(*ev);
        }
        assert!(held.is_empty());
    }

    #[test]
    fn a_batch_that_presses_and_lets_go_leaves_nothing_held() {
        let mut held = Held::new();
        for ev in [
            key(0x2A, true),
            Ev::Button {
                button: Button::Right,
                down: true,
            },
            Ev::Button {
                button: Button::Right,
                down: false,
            },
            Ev::Unicode {
                unit: 0x41,
                down: true,
            },
            Ev::Unicode {
                unit: 0x41,
                down: false,
            },
            key(0x2A, false),
        ] {
            held.apply(ev);
        }
        assert!(held.is_empty());
    }

    #[test]
    fn a_batch_cut_short_leaves_its_presses_on_record() {
        let mut held = Held::new();
        let batch = [key(0x1D, true), key(0x1F, true), key(0x1F, false)];
        for ev in batch.iter().take(2) {
            held.apply(*ev);
        }
        assert_eq!(held.releases(), vec![key(0x1F, false), key(0x1D, false)]);
    }

    #[test]
    fn only_lets_go_events_are_releases() {
        assert!(key(1, false).is_release());
        assert!(!key(1, true).is_release());
        assert!(!Ev::Move { x: 0, y: 0 }.is_release());
        assert!(!Ev::Wheel {
            horizontal: false,
            delta: 120
        }
        .is_release());
    }
}
