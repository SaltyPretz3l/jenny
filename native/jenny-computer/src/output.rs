//! The bounded output ring a run's stdout and stderr drain into (200 lines, 16 KiB).
//! Built by lane H1 (row 197).

use std::collections::VecDeque;

/// Most lines the ring keeps.
pub const MAX_LINES: usize = 200;
/// Most bytes (of line text, separators excluded) the ring keeps.
pub const MAX_BYTES: usize = 16 * 1024;

/// The newest lines of a byte stream, bounded by line count and by bytes.
#[derive(Debug)]
pub struct Ring {
    max_lines: usize,
    max_bytes: usize,
    done: VecDeque<Vec<u8>>,
    partial: Vec<u8>,
    bytes: usize,
    dropped: u64,
}

impl Default for Ring {
    fn default() -> Self {
        Self::new()
    }
}

impl Ring {
    pub fn new() -> Self {
        Self::with_limits(MAX_LINES, MAX_BYTES)
    }

    pub fn with_limits(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            max_lines: max_lines.max(1),
            max_bytes: max_bytes.max(1),
            done: VecDeque::new(),
            partial: Vec::new(),
            bytes: 0,
            dropped: 0,
        }
    }

    /// Feed a chunk of the stream. Lines end at a line feed; a carriage return before it is removed.
    pub fn push(&mut self, data: &[u8]) {
        let mut rest = data;
        while !rest.is_empty() {
            match rest.iter().position(|&b| b == b'\n') {
                Some(pos) => {
                    let (head, tail) = rest.split_at(pos);
                    self.append(head);
                    self.finish_line();
                    rest = tail.get(1..).unwrap_or_default();
                }
                None => {
                    self.append(rest);
                    break;
                }
            }
        }
        self.evict();
    }

    /// The newest `max` lines, oldest first, text decoded lossily. An unterminated tail counts as a line.
    pub fn lines(&self, max: usize) -> Vec<String> {
        let tail = self.partial.strip_suffix(b"\r").unwrap_or(&self.partial);
        let tail = (!tail.is_empty()).then_some(tail);
        let total = self.done.len() + usize::from(tail.is_some());
        self.done
            .iter()
            .map(Vec::as_slice)
            .chain(tail)
            .skip(total.saturating_sub(max))
            .map(|line| String::from_utf8_lossy(line).into_owned())
            .collect()
    }

    /// Bytes evicted or cut since the start.
    pub fn dropped_bytes(&self) -> u64 {
        self.dropped
    }

    /// Add text to the unterminated line, cutting it to its last `max_bytes` bytes.
    fn append(&mut self, text: &[u8]) {
        self.partial.extend_from_slice(text);
        self.bytes += text.len();
        if self.partial.len() > self.max_bytes {
            let cut = self.partial.len() - self.max_bytes;
            self.partial.drain(..cut);
            self.bytes -= cut;
            self.dropped += cut as u64;
        }
    }

    /// The unterminated line ended: drop its carriage return, keep it, and make room.
    fn finish_line(&mut self) {
        if self.partial.last() == Some(&b'\r') {
            self.partial.pop();
            self.bytes -= 1;
        }
        self.done.push_back(std::mem::take(&mut self.partial));
        self.evict();
    }

    /// Evict the oldest finished lines until the ring is inside both limits.
    fn evict(&mut self) {
        loop {
            let lines = self.done.len() + usize::from(!self.partial.is_empty());
            if lines <= self.max_lines && self.bytes <= self.max_bytes {
                return;
            }
            let Some(old) = self.done.pop_front() else {
                return;
            };
            self.bytes -= old.len();
            self.dropped += old.len() as u64;
        }
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
    fn the_oldest_lines_go_first_when_there_are_too_many() {
        let mut ring = Ring::with_limits(3, 1024);
        ring.push(b"a\nbb\nccc\ndddd\ne\n");
        assert_eq!(ring.lines(10), ["ccc", "dddd", "e"]);
        assert_eq!(ring.dropped_bytes(), 3);
    }

    #[test]
    fn the_oldest_lines_go_first_when_there_are_too_many_bytes() {
        let mut ring = Ring::with_limits(100, 10);
        ring.push(b"aaaa\nbbbb\ncccc\n");
        assert_eq!(ring.lines(10), ["bbbb", "cccc"]);
        assert_eq!(ring.dropped_bytes(), 4);
        ring.push(b"ddd\n");
        assert_eq!(ring.lines(10), ["cccc", "ddd"]);
        assert_eq!(ring.dropped_bytes(), 8);
    }

    #[test]
    fn a_single_overlong_line_is_cut_to_its_last_bytes() {
        let mut ring = Ring::with_limits(10, 8);
        ring.push(b"0123456789abcdef\nok\n");
        // 8 bytes cut from the long line, then the cut remainder evicted to make room for "ok".
        assert_eq!(ring.lines(10), ["ok"]);
        assert_eq!(ring.dropped_bytes(), 16);
        let mut ring = Ring::with_limits(10, 8);
        ring.push(b"0123456789abcdef");
        ring.push(b"gh");
        assert_eq!(ring.lines(10), ["abcdefgh"]);
        assert_eq!(ring.dropped_bytes(), 10);
    }

    #[test]
    fn the_default_limits_are_200_lines_and_16_kib() {
        let mut ring = Ring::new();
        for n in 0..250 {
            ring.push(format!("line {n}\n").as_bytes());
        }
        let lines = ring.lines(1000);
        assert_eq!(lines.len(), 200);
        assert_eq!(lines.first().map(String::as_str), Some("line 50"));
        assert_eq!(lines.last().map(String::as_str), Some("line 249"));
        assert_eq!(ring.lines(5).len(), 5);
        let mut ring = Ring::new();
        ring.push(&vec![b'x'; MAX_BYTES + 100]);
        ring.push(b"\n");
        let lines = ring.lines(1);
        assert_eq!(lines.first().map(String::len), Some(MAX_BYTES));
        assert_eq!(ring.dropped_bytes(), 100);
    }

    #[test]
    fn crlf_is_one_separator_and_bad_utf8_is_replaced() {
        let mut ring = Ring::new();
        ring.push(b"one\r\ntwo\r");
        ring.push(b"\nbad \xff\xfe end\n\n");
        assert_eq!(
            ring.lines(10),
            ["one", "two", "bad \u{fffd}\u{fffd} end", ""]
        );
        assert_eq!(ring.dropped_bytes(), 0);
    }

    #[test]
    fn an_unterminated_tail_is_the_last_line_and_grows_across_pushes() {
        let mut ring = Ring::new();
        ring.push(b"done\npart");
        assert_eq!(ring.lines(10), ["done", "part"]);
        ring.push(b"ial");
        assert_eq!(ring.lines(10), ["done", "partial"]);
        ring.push(b"\n");
        assert_eq!(ring.lines(10), ["done", "partial"]);
        assert_eq!(ring.lines(1), ["partial"]);
        assert!(ring.lines(0).is_empty());
    }

    #[test]
    fn a_lone_carriage_return_tail_is_not_a_line() {
        let mut ring = Ring::new();
        ring.push(b"a\n\r");
        assert_eq!(ring.lines(10), ["a"]);
    }
}
