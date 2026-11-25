//! Input injection, the owner-input watch, the Stop chord, held-key release and program names (row 196's
//! lane H3), compiled with the `input` feature. `PROTOCOL.md`, "Input, the owner's watch and program names",
//! is the contract; `check.rs` is the check at the moment of input, which every injection calls right before
//! it hands its batch to Windows (`inject.rs`, the one place that injects).
//!
//! Off Windows the module compiles without any Windows call and every operation answers `not_available`.

pub mod args;
pub mod check;
pub mod held;
pub mod keys;
pub mod movement;

#[cfg(windows)]
mod identify;
#[cfg(windows)]
mod inject;
#[cfg(windows)]
mod keyboard;
#[cfg(windows)]
mod password;
#[cfg(windows)]
mod pointer;
#[cfg(windows)]
mod screen;
#[cfg(windows)]
mod watch;

use serde_json::Value;

use crate::dispatch::Context;
use crate::protocol::{ProtoError, Request};

/// The input state of one `--serve` session: the owner's watch. Ending it (or dropping it) stops the watch
/// and lets go of every key and button this helper still holds.
pub struct Session {
    #[cfg(windows)]
    watch: Option<watch::Watch>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            ensure_dpi_aware();
            Self { watch: None }
        }
        #[cfg(not(windows))]
        {
            Self {}
        }
    }

    /// Stop the watch and let go of everything held. Every exit of the session calls this.
    pub fn end(&mut self) {
        #[cfg(windows)]
        {
            self.watch = None;
            inject::release_all();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.end();
    }
}

/// Every coordinate the injector reads and writes is a physical pixel: per-monitor DPI aware, version 2,
/// before the first input (the run manager sets the same; whichever comes first wins, the other fails
/// harmlessly).
#[cfg(windows)]
fn ensure_dpi_aware() {
    use windows_sys::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    static AWARENESS: std::sync::Once = std::sync::Once::new();
    AWARENESS.call_once(|| {
        // SAFETY: a plain call with a documented constant; it fails when the awareness is already set.
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
    });
}

/// Install, once per process, a panic hook that lets go of held input before the previous hook runs. The
/// release build aborts on panic, and the owner's PC must not be left holding Shift.
pub fn install_panic_release() {
    #[cfg(windows)]
    {
        static INSTALLED: std::sync::Once = std::sync::Once::new();
        INSTALLED.call_once(|| {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                inject::release_after_panic();
                previous(info);
            }));
        });
    }
}

/// Answer one of row 196's operations.
pub fn handle(ctx: &mut Context, req: &Request, op: &str) -> Result<Value, ProtoError> {
    #[cfg(windows)]
    {
        win::handle(ctx, req, op)
    }
    #[cfg(not(windows))]
    {
        let _ = (ctx, req, op);
        Err(ProtoError::not_available())
    }
}

#[cfg(windows)]
mod win {
    use serde_json::{json, Value};

    use super::{args, identify, inject, keyboard, pointer, screen, watch};
    use crate::dispatch::Context;
    use crate::protocol::{ProtoError, Request};

    pub fn handle(ctx: &mut Context, req: &Request, op: &str) -> Result<Value, ProtoError> {
        match op {
            "watch.start" => {
                let settings = args::parse_watch(req)?;
                // A restart: the old watch goes first (the latch keeps its value).
                ctx.input.watch = None;
                let started = watch::Watch::start(ctx.emitter.clone(), &settings)?;
                let registered = started.registered;
                ctx.input.watch = Some(started);
                Ok(json!({"stop_chord_registered": registered}))
            }
            "watch.stop" => {
                ctx.input.watch = None;
                Ok(json!({}))
            }
            "watch.resume" => {
                watch::resume();
                Ok(json!({}))
            }
            "watch.state" => {
                let running = ctx.input.watch.is_some() && watch::gate().watch_running;
                Ok(json!({
                    "running": running,
                    "paused": watch::gate().owner_active,
                    "last_real_input_ms": if running { watch::last_real_input_ms() } else { None },
                    "stop_chord_registered": ctx.input.watch.as_ref().is_some_and(|w| w.registered),
                }))
            }
            "program.identify" => identify::program_identify(req),
            "input.release_all" => Ok(json!({"released": inject::release_all()})),
            _ => {
                let stop_chord = ctx.input.watch.as_ref().map(|w| w.chord.clone());
                let result = match op {
                    "input.focus" => screen::focus(req),
                    "input.move" => pointer::move_to(req),
                    "input.click" => pointer::click(req),
                    "input.drag" => pointer::drag(req),
                    "input.scroll" => pointer::scroll(req),
                    "input.type" => keyboard::type_text(req),
                    "input.key" => keyboard::key(req, stop_chord.as_ref()),
                    other => Err(ProtoError::not_built(other)),
                };
                // No operation returns while holding a key or a button.
                inject::release_all();
                result
            }
        }
    }
}
