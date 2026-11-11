//! Request framing and validation. Behaviour is defined by
//! `sidecar/_owned_process_bootstrap.py` (`_read_bootstrap_payload`).

use std::io::{Cursor, Read};

use jenny_launch::payload::{parse_payload, read_request, Rejected, Request, MAX_PAYLOAD_BYTES};

fn frame(body: &[u8]) -> Vec<u8> {
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(body);
    out
}

fn read(bytes: &[u8]) -> Result<Request, Rejected> {
    read_request(&mut Cursor::new(bytes.to_vec()))
}

fn parse(json: &str) -> Result<Request, Rejected> {
    parse_payload(json.as_bytes())
}

const VALID: &str = r#"{"argv":["prog","a b"],"cwd":"C:\\work","env":null,"input_data_b64":null}"#;

#[test]
fn fully_valid_request_without_env_or_input() {
    let request = parse(VALID).unwrap();
    assert_eq!(request.argv, vec!["prog".to_string(), "a b".to_string()]);
    assert_eq!(request.cwd, "C:\\work");
    assert_eq!(request.env, None);
    assert_eq!(request.input, None);
}

#[test]
fn fully_valid_request_with_env_in_document_order_and_input() {
    let json = r#"{"input_data_b64":"aGVsbG8=","env":{"ZED":"1","ALPHA":"2","=C:":"x","M":""},"cwd":"","argv":["p"]}"#;
    let request = parse(json).unwrap();
    assert_eq!(request.cwd, "");
    assert_eq!(request.input, Some(b"hello".to_vec()));
    let env = request.env.unwrap();
    let pairs: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    assert_eq!(
        pairs,
        vec![("ZED", "1"), ("ALPHA", "2"), ("=C:", "x"), ("M", "")]
    );
}

#[test]
fn empty_env_object_is_valid_and_distinct_from_null() {
    let json = r#"{"argv":["p"],"cwd":"c","env":{},"input_data_b64":""}"#;
    let request = parse(json).unwrap();
    assert_eq!(request.env, Some(Vec::new()));
    assert_eq!(request.input, Some(Vec::new()));
}

#[test]
fn escapes_in_strings_are_decoded() {
    let json = r#"{"argv":["a\"b","\u00e9\ud83d\ude00"],"cwd":"x","env":{"K\u0041":"v\n"},"input_data_b64":null}"#;
    let request = parse(json).unwrap();
    assert_eq!(request.argv[0], "a\"b");
    assert_eq!(request.argv[1], "\u{e9}\u{1F600}");
    assert_eq!(request.env.unwrap(), vec![("KA".to_string(), "v\n".to_string())]);
}

#[test]
fn framed_valid_request_reads_exactly_header_plus_length() {
    let mut bytes = frame(VALID.as_bytes());
    let frame_len = bytes.len() as u64;
    bytes.extend_from_slice(b"TRAILING-BYTES-MUST-NOT-BE-CONSUMED");
    let mut cursor = Cursor::new(bytes);
    assert!(read_request(&mut cursor).is_ok());
    assert_eq!(cursor.position(), frame_len);
    let mut rest = Vec::new();
    cursor.read_to_end(&mut rest).unwrap();
    assert_eq!(rest, b"TRAILING-BYTES-MUST-NOT-BE-CONSUMED");
}

#[test]
fn length_zero_is_rejected() {
    assert_eq!(read(&[0, 0, 0, 0]), Err(Rejected));
    assert_eq!(read(&[0, 0, 0, 0, b'{', b'}']), Err(Rejected));
}

#[test]
fn length_over_limit_is_rejected_without_reading_the_body() {
    let over = (MAX_PAYLOAD_BYTES as u32) + 1;
    let mut bytes = over.to_be_bytes().to_vec();
    bytes.extend_from_slice(VALID.as_bytes());
    assert_eq!(read(&bytes), Err(Rejected));
    assert_eq!(read(&u32::MAX.to_be_bytes()), Err(Rejected));
}

#[test]
fn length_at_limit_is_read_then_fails_on_content() {
    assert_eq!(MAX_PAYLOAD_BYTES, 1_048_576);
    let body = vec![b' '; MAX_PAYLOAD_BYTES];
    // All whitespace is not a JSON document: rejected for content, not size.
    assert_eq!(read(&frame(&body)), Err(Rejected));
    // A valid document padded with whitespace to exactly the limit is accepted.
    let mut padded = VALID.as_bytes().to_vec();
    padded.resize(MAX_PAYLOAD_BYTES, b' ');
    assert!(read(&frame(&padded)).is_ok());
}

#[test]
fn short_header_is_rejected() {
    assert_eq!(read(&[]), Err(Rejected));
    assert_eq!(read(&[0]), Err(Rejected));
    assert_eq!(read(&[0, 0, 1]), Err(Rejected));
}

#[test]
fn short_body_is_rejected() {
    let mut bytes = frame(VALID.as_bytes());
    bytes.pop();
    assert_eq!(read(&bytes), Err(Rejected));
    assert_eq!(read(&[0, 0, 0, 5, b'{']), Err(Rejected));
}

#[test]
fn bad_utf8_is_rejected() {
    assert_eq!(parse_payload(b"{\"argv\":[\"\xff\"]}"), Err(Rejected));
    let mut json = VALID.as_bytes().to_vec();
    json.extend_from_slice(b"\xc3");
    assert_eq!(parse_payload(&json), Err(Rejected));
}

#[test]
fn bad_json_is_rejected() {
    for json in ["", "{", "{\"argv\":", "nonsense", "{'argv':[]}", "{} {}", "{\"a\":1,}"] {
        assert_eq!(parse(json), Err(Rejected), "{json}");
    }
    assert_eq!(parse(&format!("{VALID} x")), Err(Rejected));
}

#[test]
fn non_object_documents_are_rejected() {
    for json in ["[]", "null", "\"str\"", "12", "true", "[{\"argv\":[]}]"] {
        assert_eq!(parse(json), Err(Rejected), "{json}");
    }
}

#[test]
fn missing_key_is_rejected_for_each_key() {
    let full = [
        ("argv", r#"["p"]"#),
        ("cwd", r#""c""#),
        ("env", "null"),
        ("input_data_b64", "null"),
    ];
    for skip in 0..full.len() {
        let parts: Vec<String> = full
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != skip)
            .map(|(_, (key, value))| format!("\"{key}\":{value}"))
            .collect();
        let json = format!("{{{}}}", parts.join(","));
        assert_eq!(parse(&json), Err(Rejected), "{json}");
    }
    assert_eq!(parse("{}"), Err(Rejected));
}

#[test]
fn extra_key_is_rejected() {
    let json = r#"{"argv":["p"],"cwd":"c","env":null,"input_data_b64":null,"extra":1}"#;
    assert_eq!(parse(json), Err(Rejected));
    let renamed = r#"{"argv":["p"],"cwd":"c","env":null,"input_data":null}"#;
    assert_eq!(parse(renamed), Err(Rejected));
}

#[test]
fn duplicate_key_is_rejected_even_with_the_right_key_set() {
    let json = r#"{"argv":["p"],"cwd":"c","env":null,"input_data_b64":null,"cwd":"d"}"#;
    assert_eq!(parse(json), Err(Rejected));
    // A duplicate spelled with an escape is still a duplicate.
    let escaped = r#"{"argv":["p"],"cwd":"c","env":null,"input_data_b64":null,"\u0063wd":"d"}"#;
    assert_eq!(parse(escaped), Err(Rejected));
    // Duplicates inside env are rejected too.
    let env = r#"{"argv":["p"],"cwd":"c","env":{"A":"1","A":"2"},"input_data_b64":null}"#;
    assert_eq!(parse(env), Err(Rejected));
}

#[test]
fn wrong_types_are_rejected() {
    let cases = [
        r#"{"argv":"p","cwd":"c","env":null,"input_data_b64":null}"#,
        r#"{"argv":null,"cwd":"c","env":null,"input_data_b64":null}"#,
        r#"{"argv":{"0":"p"},"cwd":"c","env":null,"input_data_b64":null}"#,
        r#"{"argv":["p",1],"cwd":"c","env":null,"input_data_b64":null}"#,
        r#"{"argv":["p",null],"cwd":"c","env":null,"input_data_b64":null}"#,
        r#"{"argv":["p",["x"]],"cwd":"c","env":null,"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":1,"env":null,"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":null,"env":null,"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":["c"],"env":null,"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":"c","env":[],"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":"c","env":"A=1","input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":"c","env":{"A":1},"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":"c","env":{"A":null},"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":"c","env":{"A":["1"]},"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":"c","env":null,"input_data_b64":1}"#,
        r#"{"argv":["p"],"cwd":"c","env":null,"input_data_b64":[]}"#,
        r#"{"argv":["p"],"cwd":"c","env":null,"input_data_b64":{}}"#,
    ];
    for json in cases {
        assert_eq!(parse(json), Err(Rejected), "{json}");
    }
}

#[test]
fn empty_argv_and_empty_program_are_rejected() {
    let empty = r#"{"argv":[],"cwd":"c","env":null,"input_data_b64":null}"#;
    assert_eq!(parse(empty), Err(Rejected));
    let blank = r#"{"argv":["","x"],"cwd":"c","env":null,"input_data_b64":null}"#;
    assert_eq!(parse(blank), Err(Rejected));
    // An empty later argument is fine.
    let later = r#"{"argv":["p",""],"cwd":"c","env":null,"input_data_b64":null}"#;
    assert!(parse(later).is_ok());
}

#[test]
fn nul_characters_are_rejected_everywhere() {
    let cases = [
        r#"{"argv":["p\u0000"],"cwd":"c","env":null,"input_data_b64":null}"#,
        r#"{"argv":["p","a\u0000b"],"cwd":"c","env":null,"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":"c\u0000","env":null,"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":"c","env":{"A\u0000":"1"},"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":"c","env":{"A":"1\u0000"},"input_data_b64":null}"#,
        r#"{"argv":["p"],"cwd":"c","env":{"A":"\u0000"},"input_data_b64":null}"#,
    ];
    for json in cases {
        assert_eq!(parse(json), Err(Rejected), "{json}");
    }
}

#[test]
fn bad_base64_is_rejected() {
    let wrap = |value: &str| {
        format!(r#"{{"argv":["p"],"cwd":"c","env":null,"input_data_b64":"{value}"}}"#)
    };
    // Missing padding, bad alphabet, whitespace, data after padding, URL-safe
    // alphabet, wrong padding count, non-canonical trailing bits.
    for value in [
        "aGVsbG8", "a*b=", "aGVs bG8=", "aGVsbG8=aGVsbG8=", "-_-_", "aGVsbG8==", "aGVsbG9=",
        "a", "====",
    ] {
        assert_eq!(parse(&wrap(value)), Err(Rejected), "{value}");
    }
    assert_eq!(parse(&wrap("aGVsbG8=")).unwrap().input, Some(b"hello".to_vec()));
}

#[test]
fn nesting_beyond_the_parser_limit_is_rejected_not_a_crash() {
    let deep = format!(
        r#"{{"argv":["p"],"cwd":"c","env":null,"input_data_b64":{}0{}}}"#,
        "[".repeat(5000),
        "]".repeat(5000)
    );
    assert_eq!(parse(&deep), Err(Rejected));
}
