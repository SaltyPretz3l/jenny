mod attestation;
mod broker_channel;
mod capability_abi;
mod channel_auth;
mod framing;
mod limits;
mod process_limits;
mod runtime;

use std::env;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use interprocess::local_socket::{GenericNamespaced, ListenerOptions, prelude::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use attestation::Bootstrap;
use broker_channel::{BrokerChannel, InvocationBroker};
use channel_auth::{AuthenticatedFrame, sign, verify};
use framing::{MAX_CONTROL_FRAME_BYTES, MAX_LOAD_FRAME_BYTES, read_frame, write_frame};
use runtime::RestrictedRuntime;

#[derive(Deserialize)]
struct LoadPayload {
    component_b64: String,
}

#[derive(Deserialize)]
struct InvokePayload {
    input_json: String,
    timeout_ms: u64,
    invocation_id: String,
    operation_id: String,
    cancellation_id: String,
    token_id: String,
}

#[derive(Serialize)]
struct ResultPayload<'a> {
    ok: bool,
    status: &'static str,
    result_json: Option<&'a str>,
    reason_code: Option<&'static str>,
}

fn endpoint_arg() -> Result<String> {
    let mut args = env::args_os();
    let _binary = args.next();
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--endpoint")) {
        bail!("endpoint_argument_rejected");
    }
    let endpoint = args.next().context("endpoint_argument_missing")?;
    if args.next().is_some() {
        bail!("unexpected_argument_rejected");
    }
    let endpoint = endpoint
        .into_string()
        .map_err(|_| anyhow::anyhow!("endpoint_encoding_rejected"))?;
    if endpoint.len() < 16
        || endpoint.len() > 96
        || !endpoint
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        bail!("endpoint_shape_rejected");
    }
    Ok(endpoint)
}

fn authenticated_write(
    stream: &mut impl std::io::Write,
    key: &[u8],
    channel_id: &str,
    sequence: u64,
    kind: &str,
    payload: &impl Serialize,
) -> Result<()> {
    let payload_json = serde_json::to_string(payload)?;
    let frame = sign(key, channel_id, sequence, kind, payload_json)?;
    write_frame(stream, &serde_json::to_vec(&frame)?)?;
    Ok(())
}

fn run() -> Result<()> {
    process_limits::apply_process_memory_limit()?;
    let endpoint = endpoint_arg()?;
    let name = endpoint.to_ns_name::<GenericNamespaced>()?;
    let listener = ListenerOptions::new().name(name).create_sync()?;
    let mut stream = listener.accept()?;

    let bootstrap_bytes = read_frame(&mut stream, MAX_CONTROL_FRAME_BYTES)?;
    let bootstrap: Bootstrap =
        serde_json::from_slice(&bootstrap_bytes).context("bootstrap_shape_rejected")?;
    if bootstrap.bootstrap_schema_version != 1 {
        bail!("bootstrap_version_rejected");
    }
    let key = hex::decode(&bootstrap.process_key).context("bootstrap_key_encoding_rejected")?;
    if key.len() != 32 {
        bail!("bootstrap_key_size_rejected");
    }

    let load_frame: AuthenticatedFrame =
        serde_json::from_slice(&read_frame(&mut stream, MAX_LOAD_FRAME_BYTES)?)?;
    let load_json = verify(&key, &bootstrap.channel_id, 0, &load_frame)?;
    if load_frame.kind != "load" {
        bail!("load_frame_kind_rejected");
    }
    let load: LoadPayload = serde_json::from_str(load_json)?;
    let component = BASE64
        .decode(load.component_b64)
        .context("component_encoding_rejected")?;
    if hex::encode(Sha256::digest(&component)) != bootstrap.component_digest {
        bail!("component_digest_rejected");
    }
    authenticated_write(
        &mut stream,
        &key,
        &bootstrap.channel_id,
        0,
        "load_accepted",
        &serde_json::json!({"ok": true}),
    )?;
    let runtime = RestrictedRuntime::load(&component)?;
    let description = runtime
        .describe()
        .context("component_description_rejected")?;
    if description.len() > 64 * 1024 {
        bail!("component_description_budget_exceeded");
    }
    authenticated_write(
        &mut stream,
        &key,
        &bootstrap.channel_id,
        1,
        "attestation",
        &bootstrap.attest(),
    )?;

    let channel = Arc::new(Mutex::new(BrokerChannel::new(
        stream,
        key,
        bootstrap.channel_id.clone(),
    )));
    loop {
        let frame = channel
            .lock()
            .map_err(|_| anyhow::anyhow!("channel_state_unavailable"))?
            .receive()?;
        match frame.kind.as_str() {
            "invoke" => {
                let payload: InvokePayload = serde_json::from_value(frame.payload)?;
                let broker = Arc::new(InvocationBroker::new(channel.clone(), &bootstrap, &payload));
                let result =
                    runtime.invoke(&payload.input_json, payload.timeout_ms, broker.clone());
                let response = match result.as_ref() {
                    Ok(outcome) => ResultPayload {
                        ok: true,
                        status: "succeeded",
                        result_json: Some(&outcome.result),
                        reason_code: None,
                    },
                    Err(_) => ResultPayload {
                        ok: false,
                        status: "failed",
                        result_json: None,
                        reason_code: Some("guest_invocation_failed"),
                    },
                };
                let terminal_result = result
                    .as_ref()
                    .map(|outcome| outcome.result.clone())
                    .map_err(|_| anyhow::anyhow!("guest_invocation_failed"));
                broker
                    .emit_terminal(&terminal_result)
                    .map_err(anyhow::Error::msg)?;
                channel
                    .lock()
                    .map_err(|_| anyhow::anyhow!("channel_state_unavailable"))?
                    .send("terminal", &response)?;
            }
            "shutdown" => {
                channel
                    .lock()
                    .map_err(|_| anyhow::anyhow!("channel_state_unavailable"))?
                    .send("shutdown_complete", &serde_json::json!({"ok": true}))?;
                return Ok(());
            }
            _ => bail!("control_frame_kind_rejected"),
        }
    }
}

fn main() {
    if run().is_err() {
        // Deliberately fixed, bounded, and payload-free. Electron owns detailed
        // correlated diagnostics; the helper never writes guest or host data.
        eprintln!("restricted_host_failed");
        std::process::exit(70);
    }
}
