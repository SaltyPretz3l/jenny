use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use interprocess::local_socket::Stream as LocalSocketStream;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::attestation::Bootstrap;
use crate::channel_auth::{AuthenticatedFrame, sign, verify};
use crate::framing::{MAX_CONTROL_FRAME_BYTES, read_frame, write_frame};

pub struct ReceivedFrame {
    pub kind: String,
    pub payload: Value,
}

pub struct BrokerChannel {
    stream: LocalSocketStream,
    key: Vec<u8>,
    channel_id: String,
    incoming_sequence: u64,
    outgoing_sequence: u64,
}

impl BrokerChannel {
    pub fn new(stream: LocalSocketStream, key: Vec<u8>, channel_id: String) -> Self {
        // load_accepted and attestation occupy helper sequences 0 and 1.
        Self {
            stream,
            key,
            channel_id,
            incoming_sequence: 1,
            outgoing_sequence: 2,
        }
    }

    pub fn send(&mut self, kind: &str, payload: &impl Serialize) -> Result<()> {
        let payload_json = serde_json::to_string(payload)?;
        let frame = sign(
            &self.key,
            &self.channel_id,
            self.outgoing_sequence,
            kind,
            payload_json,
        )?;
        self.outgoing_sequence += 1;
        write_frame(&mut self.stream, &serde_json::to_vec(&frame)?)?;
        Ok(())
    }

    pub fn receive(&mut self) -> Result<ReceivedFrame> {
        let frame: AuthenticatedFrame =
            serde_json::from_slice(&read_frame(&mut self.stream, MAX_CONTROL_FRAME_BYTES)?)?;
        let payload_json = verify(&self.key, &self.channel_id, self.incoming_sequence, &frame)?;
        let payload = serde_json::from_str(payload_json)?;
        self.incoming_sequence += 1;
        Ok(ReceivedFrame {
            kind: frame.kind,
            payload,
        })
    }
}

pub type SharedChannel = Arc<Mutex<BrokerChannel>>;
const BACKPRESSURE_ACK_DEADLINE_MS: u64 = 1000;

pub struct InvocationBroker {
    channel: SharedChannel,
    process_instance_id: String,
    channel_id: String,
    invocation_id: String,
    operation_id: String,
    cancellation_id: String,
    token_id: String,
    commit_epoch: u64,
    lifecycle_epoch: u64,
    stream_sequence: Mutex<u64>,
    call_sequence: Mutex<u64>,
}

impl InvocationBroker {
    pub fn new(
        channel: SharedChannel,
        bootstrap: &Bootstrap,
        invocation: &crate::InvokePayload,
    ) -> Self {
        Self {
            channel,
            process_instance_id: bootstrap.process_instance_id.clone(),
            channel_id: bootstrap.channel_id.clone(),
            invocation_id: invocation.invocation_id.clone(),
            operation_id: invocation.operation_id.clone(),
            cancellation_id: invocation.cancellation_id.clone(),
            token_id: invocation.token_id.clone(),
            commit_epoch: bootstrap.commit_epoch,
            lifecycle_epoch: bootstrap.lifecycle_epoch,
            stream_sequence: Mutex::new(0),
            call_sequence: Mutex::new(0),
        }
    }

    fn stream(&self, frame: Value, terminal: bool) -> Result<(), String> {
        let mut sequence = self
            .stream_sequence
            .lock()
            .map_err(|_| "stream_state_unavailable".to_string())?;
        if (!terminal && *sequence >= 255) || (terminal && *sequence >= 256) {
            return Err("stream_budget_exceeded".into());
        }
        let payload = serde_json::json!({
            "frame_schema_version": 1,
            "invocation_id": self.invocation_id,
            "commit_epoch": self.commit_epoch,
            "lifecycle_epoch": self.lifecycle_epoch,
            "sequence": *sequence,
            "frame": frame,
        });
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| "channel_state_unavailable".to_string())?;
        channel
            .send("stream", &payload)
            .map_err(|_| "stream_send_failed".to_string())?;
        let (cancel_watchdog, watchdog_wait) = mpsc::channel();
        let watchdog = thread::Builder::new()
            .name("restricted-stream-ack".to_owned())
            .spawn(move || {
                if watchdog_wait
                    .recv_timeout(Duration::from_millis(BACKPRESSURE_ACK_DEADLINE_MS))
                    .is_err()
                {
                    std::process::exit(72);
                }
            })
            .map_err(|_| "stream_ack_watchdog_unavailable".to_string())?;
        let received = channel.receive();
        let _ = cancel_watchdog.send(());
        let _ = watchdog.join();
        let ack = received.map_err(|_| "stream_ack_failed".to_string())?;
        if ack.kind != "stream_ack"
            || ack.payload.get("invocation_id").and_then(Value::as_str) != Some(&self.invocation_id)
            || ack.payload.get("sequence").and_then(Value::as_u64) != Some(*sequence)
        {
            return Err("stream_ack_rejected".into());
        }
        *sequence += 1;
        Ok(())
    }

    pub fn emit_progress(&self, value: &str) -> Result<(), String> {
        self.stream(
            serde_json::json!({"kind": "progress", "payload": value}),
            false,
        )
    }

    pub fn emit_data(&self, value: &[u8]) -> Result<(), String> {
        self.stream(
            serde_json::json!({"kind": "data", "payload": BASE64.encode(value)}),
            false,
        )
    }

    pub fn emit_terminal(&self, result: &Result<String>) -> Result<(), String> {
        let frame = match result {
            Ok(value) => serde_json::json!({
                "kind": "terminal",
                "status": "succeeded",
                "retryable": false,
                "result_digest": hex::encode(Sha256::digest(value.as_bytes())),
            }),
            Err(_) => serde_json::json!({
                "kind": "terminal",
                "status": "failed",
                "retryable": false,
                "reason_code": "guest_invocation_failed",
            }),
        };
        self.stream(frame, true)
    }

    pub fn capability_call(&self, capability: &str, payload: Value) -> Result<Value, String> {
        let payload_json = serde_json::to_string(&payload)
            .map_err(|_| "capability_payload_rejected".to_string())?;
        let mut call_sequence = self
            .call_sequence
            .lock()
            .map_err(|_| "capability_state_unavailable".to_string())?;
        let call_id = format!("call_{}", *call_sequence);
        *call_sequence += 1;
        let call = serde_json::json!({
            "call_schema_version": 4,
            "call_id": call_id,
            "invocation_id": self.invocation_id,
            "operation_id": self.operation_id,
            "cancellation_id": self.cancellation_id,
            "process_instance_id": self.process_instance_id,
            "channel_id": self.channel_id,
            "commit_epoch": self.commit_epoch,
            "lifecycle_epoch": self.lifecycle_epoch,
            "capability": capability,
            "token_id": self.token_id,
            "argument_digest": hex::encode(Sha256::digest(payload_json.as_bytes())),
            "payload_json": payload_json,
        });
        let mut channel = self
            .channel
            .lock()
            .map_err(|_| "channel_state_unavailable".to_string())?;
        channel
            .send("capability_call", &call)
            .map_err(|_| "capability_call_send_failed".to_string())?;
        let response = channel
            .receive()
            .map_err(|_| "capability_result_receive_failed".to_string())?;
        if response.kind != "capability_result"
            || response.payload.get("call_id").and_then(Value::as_str) != Some(&call_id)
        {
            return Err("capability_result_rejected".into());
        }
        if response.payload.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(response
                .payload
                .get("reason_code")
                .and_then(Value::as_str)
                .unwrap_or("capability_call_failed")
                .to_string());
        }
        let response_json = response
            .payload
            .get("payload_json")
            .and_then(Value::as_str)
            .ok_or_else(|| "capability_result_payload_rejected".to_string())?;
        serde_json::from_str(response_json)
            .map_err(|_| "capability_result_payload_rejected".to_string())
    }
}
