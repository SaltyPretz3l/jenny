use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

fn hmac_sha256(key: &[u8], message: &[u8]) -> String {
    let mut block = [0_u8; 64];
    if key.len() > block.len() { block[..32].copy_from_slice(&Sha256::digest(key)); }
    else { block[..key.len()].copy_from_slice(key); }
    let mut inner = [0x36_u8; 64];
    let mut outer = [0x5c_u8; 64];
    for index in 0..64 { inner[index] ^= block[index]; outer[index] ^= block[index]; }
    let digest = Sha256::new().chain_update(inner).chain_update(message).finalize();
    hex::encode(Sha256::new().chain_update(outer).chain_update(digest).finalize())
}

fn sign_response(key: &[u8], sequence: u64, session_id: &str, session_epoch: u64,
    payload_json: &str) -> Value {
    let message = format!("host_to_supervisor\0{sequence}\0ok\0{session_id}\0{session_epoch}\0{payload_json}");
    json!({"direction":"host_to_supervisor", "sequence":sequence, "status":"ok",
        "payload_json":payload_json, "auth_tag":hmac_sha256(key, message.as_bytes())})
}

fn valid_request(value: &Value, key: &[u8], sequence: u64, session_id: &str,
    session_epoch: u64) -> bool {
    let direction = value.get("direction").and_then(Value::as_str).unwrap_or("");
    let operation = value.get("operation").and_then(Value::as_str).unwrap_or("");
    let payload = value.get("payload_json").and_then(Value::as_str).unwrap_or("");
    let tag = value.get("auth_tag").and_then(Value::as_str).unwrap_or("");
    let message = format!("{direction}\0{sequence}\0{operation}\0{session_id}\0{session_epoch}\0{payload}");
    direction == "supervisor_to_host" && value.get("sequence").and_then(Value::as_u64) == Some(sequence)
        && tag == hmac_sha256(key, message.as_bytes())
}

fn valid_secret(value: &Value, key: &[u8], sequence: u64, secret: &[u8]) -> bool {
    let direction = value.get("direction").and_then(Value::as_str).unwrap_or("");
    let grant_id = value.get("grant_id").and_then(Value::as_str).unwrap_or("");
    let size = value.get("secret_size").and_then(Value::as_u64).unwrap_or(0);
    let digest = value.get("secret_digest").and_then(Value::as_str).unwrap_or("");
    let prefix = format!("{direction}\0{sequence}\0{grant_id}\0{size}\0{digest}\0");
    let mut authenticated = prefix.as_bytes().to_vec();
    authenticated.extend_from_slice(secret);
    let expected_tag = hmac_sha256(key, &authenticated);
    direction == "supervisor_to_host_secret" && size == secret.len() as u64
        && digest == hex::encode(Sha256::digest(secret))
        && value.get("sequence").and_then(Value::as_u64) == Some(sequence)
        && value.get("auth_tag").and_then(Value::as_str) == Some(expected_tag.as_str())
}

fn executable_digest() -> String {
    std::env::current_exe().ok().and_then(|path| std::fs::read(path).ok())
        .map(|bytes| hex::encode(Sha256::digest(bytes))).unwrap_or_else(|| "0".repeat(64))
}

fn describe(payload: &Value, digest: &str) -> Value {
    let request = payload.get("payload").unwrap_or(&Value::Null);
    let identity = request.get("identity").unwrap_or(&Value::Null);
    let authority = request.get("authority").unwrap_or(&Value::Null);
    let kind = request.get("kind").and_then(Value::as_str).unwrap_or("");
    let publisher = identity.get("publisher_id").and_then(Value::as_str).unwrap_or("");
    let plugin = identity.get("plugin_id").and_then(Value::as_str).unwrap_or("");
    let contribution = identity.get("contribution_id").and_then(Value::as_str).unwrap_or("");
    let containment = request.get("containment_profile_digest")
        .and_then(Value::as_str).unwrap_or("");
    let generation = authority.get("active_generation_id").cloned().unwrap_or(Value::Null);
    let epoch = authority.get("commit_epoch").cloned().unwrap_or(Value::Null);
    let binding = hex::encode(Sha256::digest(
        format!("{publisher}\0{plugin}\0{contribution}\0{kind}\0{digest}").as_bytes()));
    let mut descriptor = json!({"publisher_id":publisher,"plugin_id":plugin,
        "contribution_id":contribution,"artifact_digest":digest,"executable_digest":digest,
        "binding_digest":binding,"active_generation_id":generation,"commit_epoch":epoch});
    if kind == "native_mcp" {
        let schema_json = r#"{"properties":{},"type":"object"}"#;
        descriptor["binding_schema_version"] = json!(6);
        descriptor["server_id"] = json!("conformance");
        descriptor["containment_profile_digest"] = json!(containment);
        descriptor["tools"] = json!([{"remote_name":"echo","namespaced_name":
            format!("plugin:{publisher}:{plugin}:echo"),"description":"Echo synthetic input",
            "schema_digest":hex::encode(Sha256::digest(schema_json.as_bytes())),
            "schema_json":schema_json,"side_effecting":false}]);
    } else if kind == "engine_adapter" {
        descriptor["adapter_schema_version"] = json!(6);
        descriptor["adapter_id"] = json!("stage8_conformance");
        descriptor["supports_streaming"] = json!(true);
        descriptor["supports_cancellation"] = json!(true);
        descriptor["max_input_bytes"] = json!(65_536);
        descriptor["max_stream_bytes"] = json!(1_048_576);
    } else if kind == "hook" {
        descriptor["hook_schema_version"] = json!(6);
        descriptor["event"] = json!("plugin.enabled");
        descriptor["subject_scope"] = json!("self");
        descriptor["max_depth"] = json!(1);
        descriptor["fanout"] = json!(1);
        descriptor["deadline_ms"] = json!(1000);
        descriptor["replay_safe"] = json!(false);
    }
    json!({"ok":true,"descriptor":descriptor})
}

fn dispatch(payload: &Value, digest: &str) -> Value {
    let operation = payload.get("operation").and_then(Value::as_str).unwrap_or("");
    let body = payload.get("payload").unwrap_or(&Value::Null);
    match operation {
        "describe" => describe(payload, digest),
        "native_mcp_invoke" => json!({"ok":true,"output":"synthetic conformance result",
            "proof":body.get("proof").cloned().unwrap_or(Value::Null),
            "binding_digest":body.get("binding_digest").cloned().unwrap_or(Value::Null)}),
        "engine_stream" => {
            let stream_operation = body.get("operation").and_then(Value::as_str).unwrap_or("");
            let prompt = body.get("input").and_then(|value| value.get("prompt"))
                .and_then(Value::as_str).unwrap_or("");
            if stream_operation == "start" && prompt == "__jenny_stage8_crash__" {
                std::process::exit(86);
            }
            if stream_operation == "start" && prompt == "__jenny_stage8_wait_for_cancel__" {
                std::thread::sleep(std::time::Duration::from_secs(60));
                json!({"ok":false,"reason":"cancellation_not_observed"})
            } else if stream_operation == "start" { json!({"ok":true,"frames":[
                {"sequence":0,"kind":"text","text":"synthetic conformance response"},
                {"sequence":1,"kind":"done"}]}) } else { json!({"ok":true,"frames":[]}) }
        },
        "hook_delivery" => json!({"ok":true,"dispatched":true}),
        "secret_value_delivery" => json!({"ok":true,"receipt_id":"synthetic-secret-receipt"}),
        _ => json!({"ok":false,"reason":"operation_rejected"}),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let mut lines = stdin.lock().lines().map_while(Result::ok);
    let Some(first) = lines.next() else { return; };
    let Ok(handshake) = serde_json::from_str::<Value>(&first) else { return; };
    let Some(key) = handshake.get("auth_key").and_then(Value::as_str).and_then(|v| hex::decode(v).ok()) else { return; };
    let session_id = handshake.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
    let session_epoch = handshake.get("session_epoch").and_then(Value::as_u64).unwrap_or(0);
    let sequence = Arc::new(AtomicU64::new(1));
    let hello_payload = "{}";
    let hello = sign_response(&key, 0, &session_id, session_epoch, hello_payload);
    let Ok(mut output) = stdout.lock() else { return; };
    if writeln!(output, "{}", hello).and_then(|_| output.flush()).is_err() { return; }
    drop(output);
    #[cfg(windows)]
    if let Some(handle) = handshake.get("secret_channel_handle").and_then(Value::as_u64) {
        use std::fs::File;
        use std::os::windows::io::FromRawHandle;
        let key = key.clone();
        let session_id = session_id.clone();
        let sequence = Arc::clone(&sequence);
        let stdout = Arc::clone(&stdout);
        std::thread::spawn(move || {
            let file = unsafe { File::from_raw_handle(handle as *mut std::ffi::c_void) };
            let mut reader = std::io::BufReader::new(file);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).ok().filter(|read| *read > 0).is_none() { break; }
                let Ok(header) = serde_json::from_str::<Value>(line.trim_end()) else { break; };
                let size = header.get("secret_size").and_then(Value::as_u64).unwrap_or(0);
                if size == 0 || size > 65_536 { break; }
                let mut secret = vec![0_u8; size as usize];
                if reader.read_exact(&mut secret).is_err() { break; }
                let current = sequence.load(Ordering::SeqCst);
                if !valid_secret(&header, &key, current, &secret) { break; }
                let grant = header.get("grant_id").and_then(Value::as_str).unwrap_or("");
                let receipt = hex::encode(Sha256::new().chain_update(grant.as_bytes())
                    .chain_update(Sha256::digest(&secret)).finalize());
                let payload = json!({"ok":true,"receipt_id":receipt}).to_string();
                let response = sign_response(&key, current, &session_id, session_epoch, &payload);
                let Ok(mut output) = stdout.lock() else { break; };
                if writeln!(output, "{}", response).and_then(|_| output.flush()).is_err() { break; }
                sequence.fetch_add(1, Ordering::SeqCst);
            }
        });
    }
    let digest = executable_digest();
    for line in lines {
        if line.len() > 65_536 { break; }
        let Ok(request) = serde_json::from_str::<Value>(&line) else { break; };
        let current = sequence.load(Ordering::SeqCst);
        if !valid_request(&request, &key, current, &session_id, session_epoch) { break; }
        let payload = request.get("payload_json").and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok()).unwrap_or(Value::Null);
        let result = dispatch(&payload, &digest).to_string();
        let response = sign_response(&key, current, &session_id, session_epoch, &result);
        let Ok(mut output) = stdout.lock() else { break; };
        if writeln!(output, "{}", response).and_then(|_| output.flush()).is_err() { break; }
        sequence.fetch_add(1, Ordering::SeqCst);
    }
}
