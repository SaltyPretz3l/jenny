//! What a window event means and how often "moved" may be reported. Pure, tested on any platform.

use std::time::{Duration, Instant};

/// Windows event numbers (`EVENT_SYSTEM_MINIMIZESTART` and friends), kept as plain numbers so this
/// module has no platform dependency.
pub const EVENT_MINIMIZE_START: u32 = 0x0016;
pub const EVENT_MINIMIZE_END: u32 = 0x0017;
pub const EVENT_OBJECT_DESTROY: u32 = 0x8001;
pub const EVENT_OBJECT_LOCATION_CHANGE: u32 = 0x800B;

/// The `state` of a `run.window_state` event for a Windows event number.
pub fn state_name(event: u32) -> Option<&'static str> {
    match event {
        EVENT_MINIMIZE_START => Some("minimized"),
        EVENT_MINIMIZE_END => Some("restored"),
        EVENT_OBJECT_LOCATION_CHANGE => Some("moved"),
        EVENT_OBJECT_DESTROY => Some("destroyed"),
        _ => None,
    }
}

/// The least time between two `moved` reports for one window.
pub const MOVE_GAP: Duration = Duration::from_millis(100);

/// Lets a `moved` report through at most once per gap and remembers one that was held back, so the
/// final position is reported when the gap ends.
#[derive(Debug)]
pub struct MoveThrottle {
    gap: Duration,
    last: Option<Instant>,
    pending: bool,
}

impl MoveThrottle {
    pub fn new(gap: Duration) -> Self {
        Self {
            gap,
            last: None,
            pending: false,
        }
    }

    /// A move happened at `now`. True when it should be reported now; otherwise it is held back.
    pub fn moved(&mut self, now: Instant) -> bool {
        if self.gap_over(now) {
            self.last = Some(now);
            self.pending = false;
            true
        } else {
            self.pending = true;
            false
        }
    }

    /// How long until a held-back move may be reported, or `None` when nothing is held back.
    pub fn wait(&self, now: Instant) -> Option<Duration> {
        if !self.pending {
            return None;
        }
        let since = self
            .last
            .map_or(self.gap, |last| now.saturating_duration_since(last));
        Some(self.gap.saturating_sub(since))
    }

    /// True once when a held-back move is due at `now`: report it.
    pub fn flush(&mut self, now: Instant) -> bool {
        if self.pending && self.gap_over(now) {
            self.last = Some(now);
            self.pending = false;
            return true;
        }
        false
    }

    fn gap_over(&self, now: Instant) -> bool {
        self.last
            .is_none_or(|last| now.saturating_duration_since(last) >= self.gap)
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

    #[test]
    fn events_map_to_the_documented_states() {
        assert_eq!(state_name(0x16), Some("minimized"));
        assert_eq!(state_name(0x17), Some("restored"));
        assert_eq!(state_name(0x800B), Some("moved"));
        assert_eq!(state_name(0x8001), Some("destroyed"));
        assert_eq!(state_name(0x8000), None);
    }

    #[test]
    fn moves_are_reported_at_most_once_per_gap_and_the_last_one_is_not_lost() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut t = MoveThrottle::new(Duration::from_millis(100));
        assert!(t.moved(at(0)));
        assert_eq!(t.wait(at(0)), None);
        assert!(!t.moved(at(10)));
        assert!(!t.moved(at(60)));
        assert_eq!(t.wait(at(60)), Some(Duration::from_millis(40)));
        assert!(!t.flush(at(90)));
        assert!(t.flush(at(100)));
        assert!(!t.flush(at(100)));
        assert_eq!(t.wait(at(100)), None);
        assert!(t.moved(at(250)));
        assert!(!t.moved(at(260)));
        assert!(t.flush(at(400)));
    }
}
