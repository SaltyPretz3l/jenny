//! Routes one request to the module that owns its operation.
//!
//! The modules below are filled in by later lanes (rows 196 and 197's orchestration document):
//! `window_list`, `job`, `output` and `geometry` by H1, `capture` by H2, `input` by row 196's H3.
//! Their entry points keep the signatures used here.

use serde_json::{json, Value};

use crate::events::Emitter;
use crate::protocol::{ErrorCode, ProtoError, Request, PROTOCOL, RESERVED_INPUT_OPS};
use crate::{capture, geometry, job, window_list};

/// What the helper does after answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    Exit,
}

/// How one request is answered.
#[derive(Debug)]
pub enum Reply {
    /// The reply is known now; the serve loop writes it.
    Now(Result<Value, ProtoError>),
    /// The reply is written later by a thread of its own (a `run.stop`), so the loop writes nothing.
    Later,
}

/// State shared by every request of one `--serve` session.
pub struct Context {
    pub emitter: Emitter,
    pub runs: job::Runs,
    /// Row 196: the owner's watch; ending it lets go of every key and button still held.
    #[cfg(feature = "input")]
    pub input: crate::input::Session,
}

impl Context {
    pub fn new(emitter: Emitter) -> Self {
        let runs = job::Runs::new(emitter.clone());
        Self {
            emitter,
            runs,
            #[cfg(feature = "input")]
            input: crate::input::Session::new(),
        }
    }
}

/// True where the helper works at all.
pub const AVAILABLE: bool = cfg!(windows);

pub fn hello() -> Value {
    json!({
        "protocol": PROTOCOL,
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "available": AVAILABLE,
        "built": {
            "windows": AVAILABLE && window_list::BUILT,
            "run": AVAILABLE && job::BUILT,
            "geometry": AVAILABLE && geometry::BUILT,
            "capture": AVAILABLE && capture::BUILT,
            "input": AVAILABLE && cfg!(feature = "input"),
        },
    })
}

pub fn handle(ctx: &mut Context, req: &Request) -> (Reply, Flow) {
    match req.op.as_str() {
        "hello" => return (Reply::Now(Ok(hello())), Flow::Continue),
        "shutdown" => {
            ctx.runs.shutdown_all();
            return (Reply::Now(Ok(json!({}))), Flow::Exit);
        }
        _ => {}
    }
    let known = crate::protocol::OPS.contains(&req.op.as_str())
        || RESERVED_INPUT_OPS.contains(&req.op.as_str());
    if !known {
        return (
            Reply::Now(Err(ProtoError::new(ErrorCode::UnknownOp, "unknown op"))),
            Flow::Continue,
        );
    }
    if !AVAILABLE {
        return (Reply::Now(Err(ProtoError::not_available())), Flow::Continue);
    }
    let result = match req.op.as_str() {
        "windows.list" => window_list::list(ctx, req),
        "window.show" => window_list::show(req),
        "window.geometry" => geometry::geometry(req),
        "run.start" => ctx.runs.start(req),
        "run.close" => ctx.runs.close(req),
        "run.stop" => return (stop(ctx, req), Flow::Continue),
        "run.output" => ctx.runs.output(req),
        "run.list" => ctx.runs.list(),
        "capture" => capture::capture(req),
        op => input_op(ctx, req, op),
    };
    (Reply::Now(result), Flow::Continue)
}

/// `run.stop` leaves the request loop: its thread writes the reply when the stop is done.
#[cfg(windows)]
fn stop(ctx: &mut Context, req: &Request) -> Reply {
    match ctx.runs.stop_detached(req) {
        Ok(Some(done)) => Reply::Now(Ok(done)),
        Ok(None) => Reply::Later,
        Err(err) => Reply::Now(Err(err)),
    }
}

/// Off Windows every operation was answered `not_available` before this.
#[cfg(not(windows))]
fn stop(ctx: &mut Context, req: &Request) -> Reply {
    Reply::Now(ctx.runs.stop(req))
}

#[cfg(not(feature = "input"))]
fn input_op(_ctx: &mut Context, _req: &Request, op: &str) -> Result<Value, ProtoError> {
    Err(ProtoError::not_built(op))
}

#[cfg(feature = "input")]
fn input_op(ctx: &mut Context, req: &Request, op: &str) -> Result<Value, ProtoError> {
    crate::input::handle(ctx, req, op)
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
    use crate::events::MemorySink;
    use crate::protocol::parse_request;

    fn ctx() -> Context {
        Context::new(Emitter::new(Box::new(MemorySink::default())))
    }

    fn run(ctx: &mut Context, line: &str) -> (Result<Value, ProtoError>, Flow) {
        match handle(ctx, &parse_request(line).unwrap()) {
            (Reply::Now(result), flow) => (result, flow),
            (Reply::Later, _) => panic!("answered later: {line}"),
        }
    }

    #[test]
    fn hello_reports_protocol_platform_and_what_is_built() {
        let v = hello();
        assert_eq!(v["protocol"], 1);
        assert_eq!(v["platform"], std::env::consts::OS);
        assert_eq!(v["available"], cfg!(windows));
        assert_eq!(
            v["built"]["input"],
            cfg!(windows) && cfg!(feature = "input")
        );
    }

    #[test]
    fn unknown_ops_are_refused_and_the_session_goes_on() {
        let (res, flow) = run(&mut ctx(), r#"{"id":1,"op":"format.disk"}"#);
        assert_eq!(res.unwrap_err().code, ErrorCode::UnknownOp);
        assert_eq!(flow, Flow::Continue);
    }

    #[test]
    fn input_ops_are_not_built_without_the_feature() {
        for op in RESERVED_INPUT_OPS {
            // With the feature, `watch.start` without arguments would register the owner's Stop chord.
            if cfg!(feature = "input") && *op == "watch.start" {
                continue;
            }
            let (res, _) = run(&mut ctx(), &format!(r#"{{"id":1,"op":"{op}"}}"#));
            if !cfg!(windows) {
                assert_eq!(res.unwrap_err().code, ErrorCode::NotAvailable, "{op}");
            } else if cfg!(feature = "input") {
                // Built: answered, or refused as malformed for want of its arguments.
                if let Err(err) = res {
                    assert_eq!(err.code, ErrorCode::BadRequest, "{op}");
                }
            } else {
                assert_eq!(res.unwrap_err().code, ErrorCode::NotBuilt, "{op}");
            }
        }
    }

    #[test]
    fn shutdown_answers_and_ends_the_session() {
        let (res, flow) = run(&mut ctx(), r#"{"id":2,"op":"shutdown"}"#);
        assert_eq!(res.unwrap(), json!({}));
        assert_eq!(flow, Flow::Exit);
    }

    #[cfg(windows)]
    #[test]
    fn run_close_is_routed_and_names_an_unknown_run() {
        let (res, _) = run(&mut ctx(), r#"{"id":4,"op":"run.close","run_id":"nobody"}"#);
        assert_eq!(res.unwrap_err().code, ErrorCode::NoSuchRun);
    }

    #[cfg(windows)]
    #[test]
    fn run_stop_names_an_unknown_run_at_once_and_refuses_a_bad_request() {
        let (res, flow) = run(&mut ctx(), r#"{"id":5,"op":"run.stop","run_id":"nobody"}"#);
        assert_eq!(res.unwrap_err().code, ErrorCode::NoSuchRun);
        assert_eq!(flow, Flow::Continue);
        let (res, _) = run(&mut ctx(), r#"{"id":6,"op":"run.stop"}"#);
        assert_eq!(res.unwrap_err().code, ErrorCode::BadRequest);
    }

    #[cfg(not(windows))]
    #[test]
    fn every_other_op_is_not_available_off_windows() {
        let (res, _) = run(&mut ctx(), r#"{"id":3,"op":"run.list"}"#);
        assert_eq!(res.unwrap_err().code, ErrorCode::NotAvailable);
    }
}
