use std::fs::File;
use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub struct OutputReaderOwner {
    shared: Arc<Mutex<Option<JoinHandle<()>>>>,
}

#[derive(Clone)]
pub struct OutputReaderHandle {
    shared: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl OutputReaderOwner {
    pub fn drain(file: File) -> Self {
        Self::from_join_handle(std::thread::spawn(move || {
            let mut reader = BufReader::new(file);
            let mut buffer = Vec::with_capacity(4096);
            loop {
                buffer.clear();
                match reader.read_until(b'\n', &mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        }))
    }

    fn from_join_handle(handle: JoinHandle<()>) -> Self {
        Self {
            shared: Arc::new(Mutex::new(Some(handle))),
        }
    }

    pub fn handle(&self) -> OutputReaderHandle {
        OutputReaderHandle {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl OutputReaderHandle {
    pub fn wait_until(&self, deadline: Instant) -> bool {
        loop {
            let finished = match self.shared.lock() {
                Ok(guard) => guard.as_ref().map(JoinHandle::is_finished).unwrap_or(true),
                Err(_) => return false,
            };
            if finished {
                let handle = match self.shared.lock() {
                    Ok(mut guard) => guard.take(),
                    Err(_) => return false,
                };
                return handle.map(|owned| owned.join().is_ok()).unwrap_or(true);
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{OutputReaderHandle, OutputReaderOwner};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[test]
    fn join_is_positive_only_after_the_reader_finishes() {
        let completed = OutputReaderOwner::from_join_handle(std::thread::spawn(|| {}));
        assert!(completed
            .handle()
            .wait_until(Instant::now() + Duration::from_secs(1)));

        let release = Arc::new(AtomicBool::new(false));
        let release_thread = Arc::clone(&release);
        let blocked = OutputReaderOwner::from_join_handle(std::thread::spawn(move || {
            while !release_thread.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }));
        let handle: OutputReaderHandle = blocked.handle();
        assert!(!handle.wait_until(Instant::now() + Duration::from_millis(10)));
        release.store(true, Ordering::Release);
        assert!(handle.wait_until(Instant::now() + Duration::from_secs(1)));
    }

    #[test]
    fn cleanup_handle_retains_reader_ownership_after_process_owner_moves() {
        let release = Arc::new(AtomicBool::new(false));
        let release_thread = Arc::clone(&release);
        let handle = {
            let owner = OutputReaderOwner::from_join_handle(std::thread::spawn(move || {
                while !release_thread.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }));
            owner.handle()
        };
        assert!(!handle.wait_until(Instant::now() + Duration::from_millis(10)));
        release.store(true, Ordering::Release);
        assert!(handle.wait_until(Instant::now() + Duration::from_secs(1)));
    }
}
