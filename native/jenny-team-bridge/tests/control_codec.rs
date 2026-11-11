//! Control-line parsing and every rejection, with its reason.

mod common;

use common::*;
use jenny_team_bridge::control::{LineRead, LineReader, Reason, MAX_LINE_BYTES};
use jenny_team_bridge::messages::{
    parse_host_command, parse_host_start, parse_member_command, parse_member_start, AdmitKind,
    HostCommand, MemberCommand,
};
use serde_json::{json, Value};

fn line(value: &Value) -> Vec<u8> {
    value.to_string().into_bytes()
}

fn valid_host_start() -> Value {
    host_start(&random32(), &random32(), 8080, host_limits())
}

fn valid_member_start() -> Value {
    member_start(
        &random32(),
        &keys().public,
        &json!(["192.168.1.5:7000", "[fe80::1]:7000"]),
        &random32(),
        member_limits(),
    )
}

fn host_reason(value: &Value) -> Option<Reason> {
    parse_host_start(&line(value)).err()
}

fn member_reason(value: &Value) -> Option<Reason> {
    parse_member_start(&line(value)).err()
}

#[test]
fn valid_starts_parse() {
    let boot = random32();
    let host_keys = keys();
    let mut start = host_start(&host_keys.secret, &boot, 8080, host_limits());
    start["direct_port"] = json!(7000);
    start["extra"] = json!("ignored");
    let parsed = parse_host_start(&line(&start)).expect("host start parses");
    assert_eq!(*parsed.secret_key, host_keys.secret);
    assert_eq!(*parsed.boot_secret, boot);
    assert_eq!(parsed.alpn, b"jenny-team/1");
    assert_eq!(parsed.loopback_port, 8080);
    assert_eq!(parsed.direct_port, Some(7000));
    assert_eq!(parsed.limits.max_streams_per_connection, 16);
    assert_eq!(parsed.limits.drop_grace_ms, 1000);

    let parsed = parse_member_start(&line(&valid_member_start())).expect("member start parses");
    assert_eq!(parsed.addresses.len(), 2);
    assert_eq!(parsed.addresses[1].to_string(), "[fe80::1]:7000");
    assert_eq!(parsed.limits.connect_timeout_ms, 5000);
}

#[test]
fn bad_starts_are_start_invalid() {
    let invalid = Some(Reason::StartInvalid);
    let mutate = |change: &dyn Fn(&mut Value)| {
        let mut start = valid_host_start();
        change(&mut start);
        host_reason(&start)
    };
    let missing = mutate(&|start| {
        start.as_object_mut().expect("object").remove("boot_secret");
    });
    assert_eq!(missing, invalid, "missing field");
    assert_eq!(
        mutate(&|start| start["loopback_port"] = json!("8080")),
        invalid
    );
    assert_eq!(mutate(&|start| start["loopback_port"] = json!(0)), invalid);
    assert_eq!(
        mutate(&|start| start["loopback_port"] = json!(65536)),
        invalid
    );
    assert_eq!(mutate(&|start| start["direct_port"] = json!(0)), invalid);
    let no_direct = mutate(&|start| {
        start.as_object_mut().expect("object").remove("direct_port");
    });
    assert_eq!(no_direct, invalid, "direct_port must be present");
    assert_eq!(
        mutate(&|start| start["secret_key"] = json!(b64(&[7u8; 31]))),
        invalid
    );
    let padded = format!("{}=", b64(&[7u8; 32]));
    assert_eq!(
        mutate(&|start| start["boot_secret"] = json!(padded)),
        invalid
    );
    let standard = b64(&[0xfbu8; 32]).replace('-', "+").replace('_', "/");
    assert_eq!(
        mutate(&|start| start["secret_key"] = json!(standard)),
        invalid
    );
    assert_eq!(
        mutate(&|start| start["limits"]["max_handshakes"] = json!(0)),
        invalid
    );
    assert_eq!(
        mutate(&|start| start["limits"]["drop_grace_ms"] = json!(-1)),
        invalid
    );
    assert_eq!(
        mutate(&|start| start["limits"]["admit_timeout_ms"] = json!(1.5)),
        invalid
    );
    let too_big = json!(u64::from(u32::MAX) + 1);
    assert_eq!(
        mutate(&|start| start["limits"]["max_connections"] = too_big.clone()),
        invalid
    );
    assert_eq!(mutate(&|start| start["alpn"] = json!("")), invalid);
    assert_eq!(
        mutate(&|start| start["alpn"] = json!("a".repeat(65))),
        invalid
    );
    assert_eq!(
        mutate(&|start| start["mode"] = json!("member")),
        invalid,
        "wrong mode"
    );

    let mut member = valid_member_start();
    member["mode"] = json!("host");
    assert_eq!(member_reason(&member), invalid, "wrong mode");
    let mut member = valid_member_start();
    member["addresses"] = json!(["not an address"]);
    assert_eq!(member_reason(&member), invalid);
    let mut member = valid_member_start();
    member["addresses"] = json!(vec!["10.0.0.1:1"; 17]);
    assert_eq!(member_reason(&member), invalid, "more than 16 addresses");
    let mut member = valid_member_start();
    member["limits"]["max_streams"] = json!(0);
    assert_eq!(member_reason(&member), invalid);
}

#[test]
fn not_a_start_is_protocol_invalid() {
    let invalid = Some(Reason::ProtocolInvalid);
    assert_eq!(parse_host_start(b"{not json").err(), invalid, "bad JSON");
    assert_eq!(parse_host_start(&[0xff, 0xfe]).err(), invalid, "bad UTF-8");
    assert_eq!(parse_host_start(b"[1]").err(), invalid);
    assert_eq!(
        parse_host_start(br#"{"t":"hello"}"#).err(),
        invalid,
        "unknown t"
    );
    assert_eq!(parse_member_start(br#"{"t":"stop"}"#).err(), invalid);
    assert_eq!(
        parse_host_start(br#"{"mode":"host"}"#).err(),
        invalid,
        "no t"
    );
}

#[test]
fn commands_parse_and_fail_closed() {
    let key = keys();
    let mut key_bytes = [0u8; 32];
    key_bytes.copy_from_slice(&iroh::SecretKey::from_bytes(&key.secret).public().as_bytes()[..]);
    assert_eq!(
        parse_host_command(&line(&json!({ "t": "drop", "key": key.public }))),
        Ok(HostCommand::Drop { key: key_bytes })
    );
    assert_eq!(
        parse_host_command(br#"{"t":"admit_answer","conn":3,"kind":"invite"}"#),
        Ok(HostCommand::AdmitAnswer {
            conn: 3,
            kind: Some(AdmitKind::Invite)
        })
    );
    for kind in [json!(null), json!("admin"), json!(1), json!(["device"])] {
        assert_eq!(
            parse_host_command(&line(
                &json!({ "t": "admit_answer", "conn": 3, "kind": kind })
            )),
            Ok(HostCommand::AdmitAnswer {
                conn: 3,
                kind: None
            }),
            "{kind} refuses"
        );
    }
    assert_eq!(
        parse_host_command(br#"{"t":"stop","extra":1}"#),
        Ok(HostCommand::Stop)
    );
    assert_eq!(
        parse_member_command(br#"{"t":"stop"}"#),
        Ok(MemberCommand::Stop)
    );

    let invalid = Err(Reason::ProtocolInvalid);
    assert_eq!(
        parse_host_command(br#"{"t":"admit_answer","conn":3}"#),
        invalid
    );
    assert_eq!(
        parse_host_command(br#"{"t":"admit_answer","conn":"3","kind":null}"#),
        invalid
    );
    assert_eq!(
        parse_host_command(br#"{"t":"drop","key":"short"}"#),
        invalid
    );
    assert_eq!(
        parse_host_command(&line(&valid_host_start())),
        invalid,
        "a second start"
    );
    assert_eq!(parse_host_command(br#"{"t":"bogus"}"#), invalid);
    assert_eq!(
        parse_member_command(br#"{"t":"drop","key":"x"}"#),
        Err(Reason::ProtocolInvalid)
    );
}

#[tokio::test]
async fn line_reader_bounds_lines_and_drops_carriage_returns() {
    let mut input = b"{\"t\":\"stop\"}\r\nsecond\n".to_vec();
    input.extend(vec![b'a'; MAX_LINE_BYTES + 1]);
    input.push(b'\n');
    let mut reader = LineReader::new(&input[..]);
    match reader.next_line().await {
        LineRead::Line(line) => assert_eq!(&line[..], br#"{"t":"stop"}"#),
        _ => panic!("first line"),
    }
    match reader.next_line().await {
        LineRead::Line(line) => assert_eq!(&line[..], b"second"),
        _ => panic!("second line"),
    }
    assert!(matches!(reader.next_line().await, LineRead::TooLong));

    let exact = [vec![b'b'; MAX_LINE_BYTES], vec![b'\n']].concat();
    let mut reader = LineReader::new(&exact[..]);
    assert!(
        matches!(reader.next_line().await, LineRead::Line(line) if line.len() == MAX_LINE_BYTES)
    );
    assert!(matches!(reader.next_line().await, LineRead::Eof));
}

#[tokio::test]
async fn rejections_write_one_compact_error_line_and_exit_two() {
    let long = [vec![b' '; MAX_LINE_BYTES + 1], vec![b'\n']].concat();
    let mut wrong_mode = valid_host_start();
    wrong_mode["mode"] = json!("member");
    let cases: Vec<(Vec<u8>, &str)> = vec![
        (long, "protocol_invalid"),
        (b"{nope\n".to_vec(), "protocol_invalid"),
        (
            [line(&wrong_mode), b"\n".to_vec()].concat(),
            "start_invalid",
        ),
    ];
    for (input, reason) in cases {
        let mut bridge = Bridge::host();
        bridge.send_raw(&input).await;
        let error = bridge.next().await;
        assert_eq!(error, json!({ "t": "error", "reason": reason }));
        let (code, rest) = bridge.finish().await;
        assert_eq!(code, 2);
        assert!(rest.is_empty());
    }

    // After start: an unknown message ends the run with protocol_invalid.
    let http = FakeHttp::start().await;
    let (mut host, _, _) = start_host(&http, &random32(), host_limits()).await;
    host.send(json!({ "t": "bogus" })).await;
    host.expect("error").await;
    let (code, rest) = host.finish().await;
    assert_eq!(code, 2);
    assert!(rest.iter().all(|line| line["t"] != "stopped"));
}

#[tokio::test]
async fn output_lines_are_compact_single_line_json() {
    let (tx, mut rx) = tokio::sync::mpsc::channel(4);
    let input: &'static [u8] = b"{\"t\":\"start\"}\n";
    let code = jenny_team_bridge::run_host_with(input, tx, options()).await;
    assert_eq!(code, 2);
    let raw = rx.recv().await.expect("one line");
    assert!(!raw.contains('\n') && !raw.contains(' '), "compact: {raw}");
    let value: Value = serde_json::from_str(&raw).expect("JSON");
    assert_eq!(value, json!({ "t": "error", "reason": "start_invalid" }));
}

#[test]
fn loopback_only_is_an_optional_boolean() {
    assert!(
        !parse_host_start(&line(&valid_host_start()))
            .expect("parses")
            .loopback_only
    );
    let mut host = valid_host_start();
    host["loopback_only"] = json!(true);
    assert!(
        parse_host_start(&line(&host))
            .expect("parses")
            .loopback_only
    );
    host["loopback_only"] = json!("yes");
    assert_eq!(host_reason(&host), Some(Reason::StartInvalid));

    let mut member = valid_member_start();
    assert!(
        !parse_member_start(&line(&member))
            .expect("parses")
            .loopback_only
    );
    member["loopback_only"] = json!(true);
    assert!(
        parse_member_start(&line(&member))
            .expect("parses")
            .loopback_only
    );
    member["loopback_only"] = json!(1);
    assert_eq!(member_reason(&member), Some(Reason::StartInvalid));
}
