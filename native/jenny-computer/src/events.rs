//! The one writer for replies and events, so lines never interleave.

use std::io::{self, Write};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Map, Value};

use crate::protocol::event_line;

type Sink = Arc<Mutex<Box<dyn Write + Send>>>;

/// Shared, cloneable line writer. Every thread that reports something holds a clone.
#[derive(Clone)]
pub struct Emitter {
    out: Sink,
}

impl Emitter {
    pub fn new(out: Box<dyn Write + Send>) -> Self {
        Self {
            out: Arc::new(Mutex::new(out)),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Box<dyn Write + Send>> {
        // A thread that panicked while holding the lock left at worst a partial line; keep going.
        self.out
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Write one whole line (it must already end with a line feed) and flush.
    pub fn line(&self, text: &str) -> io::Result<()> {
        let mut out = self.lock();
        out.write_all(text.as_bytes())?;
        out.flush()
    }

    pub fn event(&self, name: &str, fields: Map<String, Value>) -> io::Result<()> {
        self.line(&event_line(name, fields))
    }

    /// A `log` event. `message` must not hold a title, a path or a command line.
    pub fn log(&self, level: &str, message: &str) {
        let mut fields = Map::new();
        fields.insert("level".to_owned(), Value::String(level.to_owned()));
        fields.insert("message".to_owned(), Value::String(message.to_owned()));
        let _ = self.event("log", fields);
    }
}

/// An in-memory sink for tests: every clone sees the same bytes.
#[derive(Clone, Default)]
pub struct MemorySink {
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl MemorySink {
    pub fn text(&self) -> String {
        let bytes = self
            .bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

impl Write for MemorySink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
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
    fn lines_from_many_threads_stay_whole() {
        let sink = MemorySink::default();
        let emitter = Emitter::new(Box::new(sink.clone()));
        let handles: Vec<_> = (0..8)
            .map(|n| {
                let e = emitter.clone();
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        e.log("info", &format!("thread {n}"));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let text = sink.text();
        assert_eq!(text.lines().count(), 400);
        for line in text.lines() {
            let v: Value = serde_json::from_str(line).unwrap();
            assert_eq!(v["event"], "log");
        }
    }
}
