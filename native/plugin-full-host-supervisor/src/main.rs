mod containment;
mod identity;
mod process_tree;
mod transport;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use transport::{authenticate_request, response, Request, Response};

struct SessionEntry {
    process: Mutex<containment::ContainedProcess>,
    termination: containment::TerminationHandle,
}

type Sessions = Arc<Mutex<HashMap<String, Arc<SessionEntry>>>>;

#[derive(Serialize)]
struct Capabilities { capabilities: Vec<&'static str> }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LaunchContext {
    publisher_id: String, plugin_id: String, contribution_id: String, artifact_digest: String,
    registry_revision: u64, dependency_graph_hash: String, commit_epoch: u64,
    active_generation_id: String, launch_nonce_digest: String, containment_profile: String,
    containment_capabilities_digest: String, created_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkloadProfile {
    workload_profile_schema_version: u8,
    profile_id: String,
    profile_digest: String,
    publisher_id: String,
    plugin_id: String,
    contribution_id: String,
    active_process_limit: u32,
    process_memory_hard_bytes: u64,
    job_memory_hard_bytes: u64,
    cpu_hard_cap_percent: u32,
    forced_termination_proof_ms: u64,
}

fn workload_limits(request: &Request, context: &LaunchContext)
    -> Result<containment::WorkloadLimits, String> {
    let profile: WorkloadProfile = serde_json::from_str(
        request.workload_profile_json.as_deref()
            .ok_or_else(|| "workload_profile_missing".to_string())?
    ).map_err(|_| "workload_profile_invalid".to_string())?;
    if profile.workload_profile_schema_version != 1
        || profile.profile_digest.len() != 64
        || !profile.profile_digest.bytes().all(|value| value.is_ascii_hexdigit())
        || profile.publisher_id != context.publisher_id
        || profile.plugin_id != context.plugin_id
        || profile.contribution_id != context.contribution_id {
        return Err("workload_profile_authority_mismatch".to_string());
    }
    let default = profile.profile_id == "default_full_host_v1"
        && profile.active_process_limit == 16
        && profile.process_memory_hard_bytes == 2_147_483_648
        && profile.job_memory_hard_bytes == 2_147_483_648
        && profile.cpu_hard_cap_percent == 75
        && profile.forced_termination_proof_ms == 10_000;
    let image = profile.profile_id == "gpu_image_v1"
        && profile.publisher_id == "jenny-official"
        && profile.plugin_id == "local-image-generation"
        && profile.contribution_id == "local_image_generation"
        && profile.active_process_limit == 192
        && profile.process_memory_hard_bytes == 34_359_738_368
        && profile.job_memory_hard_bytes == 51_539_607_552
        && profile.cpu_hard_cap_percent == 90
        && profile.forced_termination_proof_ms == 30_000;
    if !default && !image { return Err("workload_profile_rejected".to_string()); }
    Ok(containment::WorkloadLimits {
        active_process_limit: profile.active_process_limit,
        process_memory_hard_bytes: usize::try_from(profile.process_memory_hard_bytes)
            .map_err(|_| "workload_profile_rejected".to_string())?,
        job_memory_hard_bytes: usize::try_from(profile.job_memory_hard_bytes)
            .map_err(|_| "workload_profile_rejected".to_string())?,
        cpu_hard_cap_percent: profile.cpu_hard_cap_percent,
        forced_termination_proof_ms: profile.forced_termination_proof_ms,
    })
}

#[derive(Serialize)]
struct LaunchReceipt {
    attestation_schema_version: u8, receipt_id: String, publisher_id: String, plugin_id: String,
    contribution_id: String, artifact_digest: String, executable_digest: String,
    observed_executable_digest: String, registry_revision: u64, dependency_graph_hash: String,
    commit_epoch: u64, active_generation_id: String, process_instance_id: String,
    session_id: String, session_epoch: u64, launch_nonce_digest: String,
    containment_profile: String, containment_capabilities_digest: String,
    peer_identity_digest: String, created_at: String,
}

fn capabilities() -> Capabilities {
    #[cfg(windows)]
    { Capabilities { capabilities: vec!["suspended_launch", "identity_locked_image",
        "job_kill_on_close", "tree_empty_proof", "authenticated_host_pipe",
        "hard_process_limit", "hard_memory_limit", "hard_cpu_limit"] } }
    #[cfg(not(windows))]
    { Capabilities { capabilities: vec![] } }
}

fn capabilities_digest() -> String {
    let mut values = capabilities().capabilities;
    values.sort();
    let encoded = serde_json::to_vec(&values).unwrap_or_default();
    hex::encode(Sha256::digest(encoded))
}

fn read_secret(request: &Request, input: &mut File) -> Result<Vec<u8>, String> {
    let expected = request.secret_size.ok_or_else(|| "secret_size_missing".to_string())?;
    if expected == 0 || expected > 65_536 { return Err("secret_size_rejected".to_string()); }
    let mut prefix = [0_u8; 4];
    input.read_exact(&mut prefix).map_err(|_| "secret_channel_read_failed".to_string())?;
    let actual = u32::from_be_bytes(prefix) as u64;
    if actual != expected { return Err("secret_size_mismatch".to_string()); }
    let mut secret = vec![0_u8; actual as usize];
    input.read_exact(&mut secret).map_err(|_| "secret_channel_read_failed".to_string())?;
    let observed_digest = hex::encode(Sha256::digest(&secret));
    if request.secret_digest.as_deref() != Some(observed_digest.as_str()) {
        return Err("secret_digest_mismatch".to_string());
    }
    Ok(secret)
}

fn cancellation_host_call(request: &Request) -> bool {
    if request.operation != "host_call" { return false; }
    request.payload_json.as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .map(|value| value.get("operation").and_then(serde_json::Value::as_str) == Some("engine_stream")
            && value.get("payload").and_then(|item| item.get("operation"))
                .and_then(serde_json::Value::as_str) == Some("cancel"))
        .unwrap_or(false)
}

fn handle(request: &Request, sessions: &Sessions, secret_input: &Arc<Mutex<File>>)
    -> Result<serde_json::Value, String> {
    if request.operation == "capabilities" {
        return serde_json::to_value(capabilities()).map_err(|_| "capabilities_encode_failed".to_string());
    }
    if request.operation == "terminate" {
        let session_id = request.session_id.as_deref()
            .ok_or_else(|| "session_id_missing".to_string())?;
        let session_epoch = request.session_epoch
            .ok_or_else(|| "session_epoch_missing".to_string())?;
        let removed = sessions.lock().map_err(|_| "session_store_unavailable".to_string())?
            .remove(session_id);
        let proof_timeout_ms = request.proof_timeout_ms.unwrap_or(10_000).clamp(1_000, 60_000);
        let proof = removed.map(|entry| entry.termination.terminate())
            .unwrap_or_else(|| containment::terminate_or_prove_absent(
                session_id, session_epoch, proof_timeout_ms));
        return serde_json::to_value(proof)
            .map_err(|_| "termination_proof_encode_failed".to_string());
    }
    if request.operation == "host_call" {
        let session_id = request.session_id.as_deref().ok_or_else(|| "session_id_missing".to_string())?;
        if cancellation_host_call(request) {
            let removed = sessions.lock().map_err(|_| "session_store_unavailable".to_string())?
                .remove(session_id).ok_or_else(|| "session_not_found".to_string())?;
            let proof = removed.termination.terminate();
            if !proof.tree_empty { return Err("host_cancel_unproven".to_string()); }
            return Ok(serde_json::json!({"status":"ok","payload_json":
                "{\"ok\":true,\"cancelled\":true}"}));
        }
        let entry = sessions.lock().map_err(|_| "session_store_unavailable".to_string())?
            .get(session_id).cloned().ok_or_else(|| "session_not_found".to_string())?;
        let payload = request.payload_json.as_deref().ok_or_else(|| "payload_missing".to_string())?;
        if payload.len() > 65_536 { return Err("payload_too_large".to_string()); }
        return entry.process.lock().map_err(|_| "session_process_unavailable".to_string())?
            .exchange("invoke", payload);
    }
    if request.operation == "deliver_secret" {
        let session_id = request.session_id.as_deref()
            .ok_or_else(|| "session_id_missing".to_string())?;
        let secret = {
            let mut input = secret_input.lock()
                .map_err(|_| "secret_channel_unavailable".to_string())?;
            read_secret(request, &mut input)?
        };
        let grant_id = request.grant_id.as_deref()
            .ok_or_else(|| "secret_grant_missing".to_string())?;
        let entry = sessions.lock().map_err(|_| "session_store_unavailable".to_string())?
            .get(session_id).cloned().ok_or_else(|| "session_not_found".to_string())?;
        return entry.process.lock().map_err(|_| "session_process_unavailable".to_string())?
            .deliver_secret(grant_id, &secret);
    }
    if request.operation != "start" { return Err("operation_rejected".to_string()); }
    let context: LaunchContext = serde_json::from_str(
        request.launch_context_json.as_deref().ok_or_else(|| "launch_context_missing".to_string())?
    ).map_err(|_| "launch_context_invalid".to_string())?;
    #[cfg(windows)]
    if context.containment_profile != "windows_job_supervised_v1"
        || context.containment_capabilities_digest != capabilities_digest() {
        return Err("launch_context_containment_mismatch".to_string());
    }
    let limits = workload_limits(request, &context)?;
    let path = Path::new(request.executable_path.as_deref().unwrap_or(""));
    identity::open_and_hash(path).map_err(|_| "image_identity_rejected".to_string())
        .and_then(|locked| {
            if Some(locked.digest.as_str()) != request.executable_digest.as_deref() {
                return Err("image_digest_mismatch".to_string());
            }
            let session_id = request.session_id.clone().ok_or_else(|| "session_id_missing".to_string())?;
            let session_epoch = request.session_epoch.ok_or_else(|| "session_epoch_missing".to_string())?;
            let _identity_lock = locked.file;
            let mut process = containment::launch(path, &session_id, session_epoch, limits)?;
            process.initialize(&session_id, session_epoch)?;
            let pid = process.pid;
            let peer_identity_digest = process.peer_identity_digest();
            let process_instance_id = hex::encode(Sha256::new()
                .chain_update(session_id.as_bytes()).chain_update(session_epoch.to_be_bytes())
                .chain_update(pid.to_be_bytes()).chain_update(context.launch_nonce_digest.as_bytes())
                .finalize());
            let receipt_id = hex::encode(Sha256::new().chain_update(process_instance_id.as_bytes())
                .chain_update(locked.digest.as_bytes()).chain_update(context.active_generation_id.as_bytes())
                .chain_update(context.commit_epoch.to_be_bytes()).finalize());
            let termination = process.termination_handle();
            let entry = Arc::new(SessionEntry { process: Mutex::new(process), termination });
            let mut stored = sessions.lock().map_err(|_| "session_store_unavailable".to_string())?;
            if stored.contains_key(&session_id) {
                let _ = entry.termination.terminate();
                return Err("session_already_exists".to_string());
            }
            stored.insert(session_id.clone(), entry);
            serde_json::to_value(LaunchReceipt { attestation_schema_version: 6, receipt_id,
                publisher_id: context.publisher_id, plugin_id: context.plugin_id,
                contribution_id: context.contribution_id, artifact_digest: context.artifact_digest,
                executable_digest: request.executable_digest.clone().unwrap_or_default(),
                observed_executable_digest: locked.digest, registry_revision: context.registry_revision,
                dependency_graph_hash: context.dependency_graph_hash, commit_epoch: context.commit_epoch,
                active_generation_id: context.active_generation_id, process_instance_id, session_id,
                session_epoch, launch_nonce_digest: context.launch_nonce_digest,
                containment_profile: context.containment_profile,
                containment_capabilities_digest: context.containment_capabilities_digest,
                peer_identity_digest, created_at: context.created_at })
                .map_err(|_| "receipt_encode_failed".to_string())
        })
}

fn write_response<T: Serialize>(stdout: &mut impl Write, value: &Response<T>) {
    if let Ok(encoded) = serde_json::to_string(value) {
        let _ = writeln!(stdout, "{encoded}");
        let _ = stdout.flush();
    }
}

#[cfg(windows)]
fn open_secret_input() -> Option<File> {
    use std::os::windows::io::FromRawHandle;
    unsafe extern "C" { fn _get_osfhandle(fd: i32) -> isize; }
    let handle = unsafe { _get_osfhandle(3) };
    (handle > 0).then(|| unsafe { File::from_raw_handle(handle as *mut std::ffi::c_void) })
}

#[cfg(not(windows))]
fn open_secret_input() -> Option<File> {
    use std::os::fd::FromRawFd;
    Some(unsafe { File::from_raw_fd(3) })
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let Some(secret_input) = open_secret_input() else { return; };
    let secret_input = Arc::new(Mutex::new(secret_input));
    let mut transport_key: Option<Vec<u8>> = None;
    let mut expected_sequence = 0_u64;
    for line in stdin.lock().lines().map_while(Result::ok) {
        if line.len() > 65_536 { break; }
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(_) => break,
        };
        if transport_key.is_none() {
            let candidate = request.auth_key.as_deref().and_then(|value| hex::decode(value).ok());
            if request.operation != "handshake" || request.direction != transport::ELECTRON_TO_SUPERVISOR
                || request.sequence != 0 || request.auth_tag != "" || candidate.as_ref().map(Vec::len) != Some(32) {
                break;
            }
            let key = candidate.unwrap();
            if let Ok(mut output) = stdout.lock() {
                write_response(&mut *output, &response(request.request_id, 0,
                    Ok(serde_json::json!({"protocol_version": 1})), &key));
            }
            transport_key = Some(key);
            expected_sequence = 1;
            continue;
        }
        let key = transport_key.as_ref().unwrap();
        if !authenticate_request(&request, key, expected_sequence) { break; }
        expected_sequence += 1;
        let sessions = Arc::clone(&sessions);
        let secret_input = Arc::clone(&secret_input);
        let stdout = Arc::clone(&stdout);
        let key = key.clone();
        std::thread::spawn(move || {
            let result = handle(&request, &sessions, &secret_input);
            if let Ok(mut output) = stdout.lock() {
                write_response(&mut *output,
                    &response(request.request_id, request.sequence, result, &key));
            }
        });
    }
    if let Ok(mut stored) = sessions.lock() {
        for (_, entry) in stored.drain() { let _ = entry.termination.terminate(); }
    }
}
