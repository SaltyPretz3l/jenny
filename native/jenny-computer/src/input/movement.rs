//! The owner's mouse movement threshold: real movement of at least `move_px` within a sliding `move_ms`
//! window. Fixed-size and allocation-free, because it runs inside the low-level mouse hook.

/// Samples kept. One every [`MIN_GAP_MS`] at most, so the longest window (1000 ms) fits.
pub const RING: usize = 256;
/// The shortest gap between two kept samples.
pub const MIN_GAP_MS: u64 = 4;

#[derive(Debug, Clone, Copy)]
struct Sample {
    t: u64,
    x: i32,
    y: i32,
}

/// The real pointer positions of the last `move_ms`, oldest first.
#[derive(Debug)]
pub struct MoveTrack {
    samples: [Sample; RING],
    start: usize,
    len: usize,
}

impl Default for MoveTrack {
    fn default() -> Self {
        Self::new()
    }
}

impl MoveTrack {
    pub const fn new() -> Self {
        Self {
            samples: [Sample { t: 0, x: 0, y: 0 }; RING],
            start: 0,
            len: 0,
        }
    }

    /// Forget every position (the pointer jumped by injected input, so earlier positions say nothing).
    pub fn clear(&mut self) {
        self.start = 0;
        self.len = 0;
    }

    fn at(&self, i: usize) -> Option<Sample> {
        self.samples.get((self.start + i) % RING).copied()
    }

    fn pop_oldest(&mut self) {
        if self.len > 0 {
            self.start = (self.start + 1) % RING;
            self.len -= 1;
        }
    }

    fn push(&mut self, sample: Sample) {
        if self.len == RING {
            self.pop_oldest();
        }
        if let Some(slot) = self.samples.get_mut((self.start + self.len) % RING) {
            *slot = sample;
            self.len += 1;
        }
    }

    /// Record a real position at `t` ms. True when it lies at least `px` from the oldest position seen
    /// within the last `ms`.
    pub fn real(&mut self, t: u64, x: i32, y: i32, px: u32, ms: u32) -> bool {
        while let Some(oldest) = self.at(0).filter(|_| self.len > 0) {
            if t.saturating_sub(oldest.t) > u64::from(ms) {
                self.pop_oldest();
            } else {
                break;
            }
        }
        let far = self.len > 0
            && self.at(0).is_some_and(|o| {
                let dx = i64::from(x) - i64::from(o.x);
                let dy = i64::from(y) - i64::from(o.y);
                dx * dx + dy * dy >= i64::from(px) * i64::from(px)
            });
        let newest = self.len.checked_sub(1).and_then(|i| self.at(i));
        if newest.is_none_or(|n| t.saturating_sub(n.t) >= MIN_GAP_MS) {
            self.push(Sample { t, x, y });
        }
        far
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
    fn a_hand_moving_past_the_threshold_within_the_window_fires() {
        let mut track = MoveTrack::new();
        let mut fired = false;
        for i in 0..20u64 {
            fired |= track.real(i * 10, (i as i32) * 2, 0, 18, 200);
        }
        // 38 px over 190 ms.
        assert!(fired);
    }

    #[test]
    fn a_slow_drift_and_a_still_mouse_do_not_fire() {
        let mut track = MoveTrack::new();
        // 1 px every 50 ms: 4 px in any 200 ms window.
        for i in 0..200u64 {
            assert!(!track.real(i * 50, i as i32, 0, 18, 200), "step {i}");
        }
        let mut still = MoveTrack::new();
        for i in 0..1000u64 {
            assert!(!still.real(i, 500, 500, 18, 200));
        }
    }

    #[test]
    fn movement_split_across_a_window_edge_still_counts() {
        let mut track = MoveTrack::new();
        assert!(!track.real(0, 0, 0, 18, 200));
        assert!(!track.real(150, 10, 0, 18, 200));
        // 20 px from the sample at 0 ms, 60 ms after the one at 150 ms; the 0 ms one is still in the window.
        assert!(track.real(190, 20, 0, 18, 200));
    }

    #[test]
    fn clearing_forgets_where_the_pointer_was() {
        let mut track = MoveTrack::new();
        track.real(0, 0, 0, 18, 200);
        track.clear();
        // The pointer was put far away by injected input; the next real sample is a new start.
        assert!(!track.real(10, 900, 900, 18, 200));
        assert!(!track.real(20, 905, 900, 18, 200));
    }

    #[test]
    fn a_full_ring_keeps_working() {
        let mut track = MoveTrack::new();
        for i in 0..(RING as u64 * 3) {
            track.real(i * MIN_GAP_MS, 0, 0, 18, 1000);
        }
        assert!(track.real(RING as u64 * 3 * MIN_GAP_MS, 0, 30, 18, 1000));
    }
}
