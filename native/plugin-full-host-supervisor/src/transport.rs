use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const ELECTRON_TO_SUPERVISOR: &str = "electron_to_supervisor";
pub const SUPERVISOR_TO_ELECTRON: &str = "supervisor_to_electron";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub operation: String,
    pub request_id: String,
    pub direction: String,
    pub sequence: u64,
    pub auth_tag: String,
    pub auth_key: Option<String>,
    pub executable_path: Option<String>,
    pub executable_digest: Option<String>,
    pub session_id: Option<String>,
    pub session_epoch: Option<u64>,
    pub launch_context_json: Option<String>,
    pub payload_json: Option<String>,
    pub workload_profile_json: Option<String>,
    pub workload_profile_id: Option<String>,
    pub proof_timeout_ms: Option<u64>,
    pub secret_size: Option<u64>,
    pub secret_digest: Option<String>,
    pub grant_id: Option<String>,
}

#[derive(Serialize)]
pub struct Response<T: Serialize> {
    pub request_id: String,
    pub direction: &'static str,
    pub sequence: u64,
    pub ok: bool,
    pub reason: Option<String>,
    pub result: Option<T>,
    pub auth_tag: String,
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> String {
    let mut block = [0_u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for index in 0..64 {
        inner_pad[index] ^= block[index];
        outer_pad[index] ^= block[index];
    }
    let inner = Sha256::new().chain_update(inner_pad).chain_update(message).finalize();
    hex::encode(Sha256::new().chain_update(outer_pad).chain_update(inner).finalize())
}

fn field(value: Option<&str>) -> &str { value.unwrap_or("") }

pub fn request_auth_message(request: &Request) -> String {
    format!("{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}", request.direction,
        request.sequence, request.request_id, request.operation,
        field(request.executable_path.as_deref()), field(request.executable_digest.as_deref()),
        field(request.session_id.as_deref()), request.session_epoch.map(|v| v.to_string()).unwrap_or_default())
        + "\0" + field(request.launch_context_json.as_deref())
        + "\0" + field(request.payload_json.as_deref())
        + "\0" + field(request.workload_profile_json.as_deref())
        + "\0" + field(request.workload_profile_id.as_deref())
        + "\0" + &request.proof_timeout_ms.map(|v| v.to_string()).unwrap_or_default()
        + "\0" + &request.secret_size.map(|v| v.to_string()).unwrap_or_default()
        + "\0" + field(request.secret_digest.as_deref())
        + "\0" + field(request.grant_id.as_deref())
}

pub fn authenticate_request(request: &Request, key: &[u8], expected_sequence: u64) -> bool {
    request.direction == ELECTRON_TO_SUPERVISOR && request.sequence == expected_sequence
        && request.auth_tag.len() == 64
        && hmac_sha256(key, request_auth_message(request).as_bytes()) == request.auth_tag
}

pub fn response<T: Serialize>(request_id: String, sequence: u64,
    result: Result<T, String>, key: &[u8]) -> Response<T> {
    let (ok, reason, value) = match result {
        Ok(value) => (true, None, Some(value)),
        Err(reason) => (false, Some(reason), None),
    };
    let result_json = value.as_ref().and_then(|item| serde_json::to_string(item).ok())
        .unwrap_or_default();
    let message = format!("{}\0{}\0{}\0{}\0{}\0{}", SUPERVISOR_TO_ELECTRON,
        sequence, request_id, ok, reason.as_deref().unwrap_or(""), result_json);
    Response { request_id, direction: SUPERVISOR_TO_ELECTRON, sequence, ok, reason,
        result: value, auth_tag: hmac_sha256(key, message.as_bytes()) }
}

pub fn host_request(key: &[u8], direction: &str, sequence: u64, operation: &str,
    session_id: &str, session_epoch: u64, payload_json: &str) -> Value {
    let message = format!("{direction}\0{sequence}\0{operation}\0{session_id}\0{session_epoch}\0{payload_json}");
    serde_json::json!({ "protocol_version": 1, "direction": direction,
        "sequence": sequence, "operation": operation, "session_id": session_id,
        "session_epoch": session_epoch, "payload_json": payload_json,
        "auth_tag": hmac_sha256(key, message.as_bytes()) })
}

pub fn secret_request(key: &[u8], sequence: u64, grant_id: &str, secret: &[u8]) -> Value {
    let digest = hex::encode(Sha256::digest(secret));
    let prefix = format!(
        "supervisor_to_host_secret\0{sequence}\0{grant_id}\0{}\0{digest}\0",
        secret.len()
    );
    let mut authenticated = prefix.as_bytes().to_vec();
    authenticated.extend_from_slice(secret);
    serde_json::json!({ "protocol_version": 1, "direction": "supervisor_to_host_secret",
        "sequence": sequence, "grant_id": grant_id, "secret_size": secret.len(),
        "secret_digest": digest, "auth_tag": hmac_sha256(key, &authenticated) })
}

pub fn validate_host_response(value: &Value, key: &[u8], expected_sequence: u64,
    session_id: &str, session_epoch: u64) -> bool {
    let direction = value.get("direction").and_then(Value::as_str).unwrap_or("");
    let sequence = value.get("sequence").and_then(Value::as_u64).unwrap_or(u64::MAX);
    let status = value.get("status").and_then(Value::as_str).unwrap_or("");
    let payload = value.get("payload_json").and_then(Value::as_str).unwrap_or("");
    let tag = value.get("auth_tag").and_then(Value::as_str).unwrap_or("");
    let message = format!("{direction}\0{sequence}\0{status}\0{session_id}\0{session_epoch}\0{payload}");
    direction == "host_to_supervisor" && sequence == expected_sequence && tag.len() == 64
        && hmac_sha256(key, message.as_bytes()) == tag
}
