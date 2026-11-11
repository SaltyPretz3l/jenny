//! Behaviour of the built `jenny-launch.exe`, driven the way the sidecar
//! drives it: framed request on stdin, target output on the launcher's own
//! stdout and stderr, the target's exit code as the launcher's exit code.
#![cfg(windows)]

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};

const LAUNCHER: &str = env!("CARGO_BIN_EXE_jenny-launch");
const REJECTED: &[u8] = b"owned process bootstrap rejected control payload\r\n";
const LAUNCH_FAILED: &[u8] = b"owned process bootstrap target launch failed\r\n";
const ONLY_HERE: &str = "JENNY_LAUNCH_TEST_ONLY_HERE";

struct Finished {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn frame(body: &[u8]) -> Vec<u8> {
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(body);
    out
}

fn request(argv: &[&str], cwd: &str, env: Value, input: Option<&[u8]>) -> Vec<u8> {
    let body = json!({
        "argv": argv,
        "cwd": cwd,
        "env": env,
        "input_data_b64": input.map(|bytes| STANDARD.encode(bytes)),
    });
    frame(body.to_string().as_bytes())
}

fn cmd_exe() -> String {
    std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string())
}

fn cwd_default() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

/// Run the launcher with `args`, feed `stdin_bytes`, and wait with a
/// watchdog so a hang fails the test instead of the run.
fn run_launcher(args: &[&str], stdin_bytes: Vec<u8>, set_env: bool) -> Finished {
    let mut command = Command::new(LAUNCHER);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if set_env {
        command.env(ONLY_HERE, "1");
    }
    let mut child = command.spawn().expect("spawn launcher");
    let pid = child.id();
    let mut stdin = child.stdin.take().expect("stdin pipe");
    let writer = thread::spawn(move || {
        let _ = stdin.write_all(&stdin_bytes);
    });
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });
    match receiver.recv_timeout(Duration::from_secs(60)) {
        Ok(output) => {
            let output = output.expect("launcher output");
            let _ = writer.join();
            Finished {
                code: output.status.code(),
                stdout: output.stdout,
                stderr: output.stderr,
            }
        }
        Err(_) => {
            // Stop only the launcher this test started, by its PID.
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
            panic!("launcher did not exit within 60 s");
        }
    }
}

fn bootstrap(request_bytes: Vec<u8>, set_env: bool) -> Finished {
    run_launcher(&["--owned-process-bootstrap"], request_bytes, set_env)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn cmd_c(command: &str, env: Value, input: Option<&[u8]>) -> Vec<u8> {
    let program = cmd_exe();
    request(
        &[program.as_str(), "/d", "/s", "/c", command],
        &cwd_default(),
        env,
        input,
    )
}

#[test]
fn version_prints_the_exact_line() {
    let done = run_launcher(&["--version"], Vec::new(), false);
    assert_eq!(done.code, Some(0));
    assert_eq!(done.stdout, b"jenny-launch protocol 1\n");
    assert!(done.stderr.is_empty());
}

#[test]
fn unknown_arguments_exit_125_with_one_stderr_line() {
    for args in [&[][..], &["--nope"][..], &["--version", "x"][..]] {
        let done = run_launcher(args, Vec::new(), false);
        assert_eq!(done.code, Some(125), "{args:?}");
        assert!(done.stdout.is_empty());
        let lines = done.stderr.split(|b| *b == b'\n').filter(|l| !l.is_empty());
        assert_eq!(lines.count(), 1, "{args:?}");
    }
}

#[test]
fn bad_requests_exit_125_with_the_exact_message_and_start_nothing() {
    let marker = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("must-not-exist.txt");
    let _ = std::fs::remove_file(&marker);
    let would_run = format!("echo x> \"{}\"", marker.display());
    let valid = cmd_c(&would_run, Value::Null, None);
    let mut short = valid.clone();
    short.truncate(valid.len() - 1);
    let mut extra = br#"{"argv":["a"],"cwd":"c","env":null,"input_data_b64":null,"x":1}"#.to_vec();
    extra = frame(&extra);
    let cases: Vec<Vec<u8>> = vec![
        Vec::new(),
        vec![0, 0],
        vec![0, 0, 0, 0],
        (2_000_000u32).to_be_bytes().to_vec(),
        short,
        frame(b"not json"),
        frame(b"[]"),
        extra,
    ];
    for case in cases {
        let done = bootstrap(case, false);
        assert_eq!(done.code, Some(125));
        assert_eq!(done.stderr, REJECTED);
        assert!(done.stdout.is_empty());
    }
    assert!(!marker.exists(), "a rejected request started a target");
}

#[test]
fn target_stdout_and_stderr_reach_the_launcher_streams() {
    let done = bootstrap(cmd_c("echo out& echo err>&2", Value::Null, None), false);
    assert_eq!(done.code, Some(0));
    assert_eq!(done.stdout, b"out\r\n");
    assert_eq!(done.stderr, b"err\r\n");
}

#[test]
fn exit_code_is_mirrored() {
    let done = bootstrap(cmd_c("exit 7", Value::Null, None), false);
    assert_eq!(done.code, Some(7));
    assert!(done.stderr.is_empty());
}

#[test]
fn large_exit_codes_are_mirrored_bit_for_bit() {
    let done = bootstrap(cmd_c("exit 3221225477", Value::Null, None), false);
    assert_eq!(done.code, Some(3_221_225_477u32 as i32));
}

#[test]
fn input_bytes_reach_the_targets_stdin() {
    let done = bootstrap(
        request(&["findstr", "^"], &cwd_default(), Value::Null, Some(b"hello\r\nworld\r\n")),
        false,
    );
    assert_eq!(done.code, Some(0));
    assert_eq!(done.stdout, b"hello\r\nworld\r\n");
}

#[test]
fn two_hundred_thousand_input_bytes_arrive_complete() {
    let line = format!("{}\n", "x".repeat(99));
    let input = line.repeat(2000);
    assert_eq!(input.len(), 200_000);
    let done = bootstrap(
        request(&["find", "/v", "/c", ""], &cwd_default(), Value::Null, Some(input.as_bytes())),
        false,
    );
    assert_eq!(done.code, Some(0), "{}", text(&done.stderr));
    assert_eq!(text(&done.stdout), "2000");
}

#[test]
fn a_target_that_never_reads_its_stdin_still_exits_cleanly() {
    let input = vec![b'y'; 200_000];
    // The target stays alive for about a second without reading, so the
    // launcher is blocked in its write until the target exits and the pipe
    // breaks. A second case exits at once.
    let done = bootstrap(
        cmd_c("ping -n 2 127.0.0.1 >nul & exit 3", Value::Null, Some(&input)),
        false,
    );
    assert_eq!(done.code, Some(3));
    assert!(done.stderr.is_empty(), "{}", text(&done.stderr));
    let done = bootstrap(cmd_c("exit 4", Value::Null, Some(&input)), false);
    assert_eq!(done.code, Some(4));
    assert!(done.stderr.is_empty(), "{}", text(&done.stderr));
}

#[test]
fn without_input_the_targets_stdin_is_the_nul_device() {
    let done = bootstrap(
        request(&["findstr", "^"], &cwd_default(), Value::Null, None),
        false,
    );
    // findstr finds no line on an empty stdin and exits 1 without hanging.
    assert_eq!(done.code, Some(1));
    assert!(done.stdout.is_empty());
}

#[test]
fn the_launcher_does_not_wait_for_end_of_input() {
    let mut child = Command::new(LAUNCHER)
        .arg("--owned-process-bootstrap")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn launcher");
    let mut stdin = child.stdin.take().expect("stdin pipe");
    stdin
        .write_all(&cmd_c("exit 9", Value::Null, None))
        .expect("write request");
    // stdin stays open: the launcher must act on exactly 4 + N bytes.
    let mut exited = None;
    for _ in 0..200 {
        exited = child.try_wait().expect("poll launcher");
        if exited.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if exited.is_none() {
        // Stop only the launcher this test started, by its PID.
        let _ = child.kill();
        let _ = child.wait();
    }
    drop(stdin);
    assert_eq!(exited.and_then(|status| status.code()), Some(9));
}

const PROBE: &str = "if defined JENNY_LAUNCH_TEST_ONLY_HERE (echo present) else (echo absent)";

#[test]
fn env_null_inherits_the_launchers_environment() {
    let done = bootstrap(cmd_c(PROBE, Value::Null, None), true);
    assert_eq!(text(&done.stdout), "present");
}

#[test]
fn env_given_replaces_the_environment() {
    let done = bootstrap(cmd_c(PROBE, json!({"SOMETHING": "else"}), None), true);
    assert_eq!(text(&done.stdout), "absent");
}

#[test]
fn env_pairs_reach_the_target_including_a_leading_equals_and_empty_object() {
    let done = bootstrap(
        cmd_c("echo %A_VALUE%", json!({"A_VALUE": "seen", "=C:": "C:\\x"}), None),
        false,
    );
    assert_eq!(done.code, Some(0));
    assert_eq!(text(&done.stdout), "seen");
    let empty = bootstrap(cmd_c("echo ok", json!({}), None), false);
    assert_eq!(empty.code, Some(0));
    assert_eq!(text(&empty.stdout), "ok");
}

#[test]
fn bad_env_keys_are_a_launch_failure() {
    for key in ["", "A=B", "A="] {
        let done = bootstrap(cmd_c("echo ok", json!({ key: "v" }), None), false);
        assert_eq!(done.code, Some(126), "{key:?}");
        assert_eq!(done.stderr, LAUNCH_FAILED, "{key:?}");
        assert!(done.stdout.is_empty());
    }
}

#[test]
fn cwd_is_honoured() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("cwd probe");
    std::fs::create_dir_all(&dir).expect("create probe dir");
    let program = cmd_exe();
    let done = bootstrap(
        request(
            &[program.as_str(), "/d", "/s", "/c", "cd"],
            &dir.to_string_lossy(),
            Value::Null,
            None,
        ),
        false,
    );
    assert_eq!(done.code, Some(0));
    let printed = text(&done.stdout).to_lowercase();
    assert!(printed.ends_with("cwd probe"), "{printed}");
}

#[test]
fn missing_executable_and_bad_cwd_exit_126_with_the_exact_message() {
    let missing = bootstrap(
        request(&["Z:\\no\\such\\prog.exe"], &cwd_default(), Value::Null, None),
        false,
    );
    assert_eq!(missing.code, Some(126));
    assert_eq!(missing.stderr, LAUNCH_FAILED);
    assert!(missing.stdout.is_empty());

    let program = cmd_exe();
    for cwd in ["", "Z:\\no\\such\\dir"] {
        let done = bootstrap(
            request(&[program.as_str(), "/c", "echo hi"], cwd, Value::Null, None),
            false,
        );
        assert_eq!(done.code, Some(126), "cwd {cwd:?}");
        assert_eq!(done.stderr, LAUNCH_FAILED);
    }
}

#[test]
fn a_verbatim_cmd_command_string_keeps_its_inner_quotes() {
    let done = bootstrap(
        cmd_c("echo \"quoted  text\" & echo second", Value::Null, None),
        false,
    );
    assert_eq!(done.code, Some(0));
    assert_eq!(text(&done.stdout), "\"quoted  text\" \r\nsecond");
}
