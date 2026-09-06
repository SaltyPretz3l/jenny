use std::sync::Arc;
use std::time::Instant;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

use crate::broker_channel::InvocationBroker;

wasmtime::component::bindgen!({
    world: "restricted-host",
    path: "../config/plugins/capability-abi/v1/jenny-restricted-host.wit",
});

#[derive(Default)]
pub struct InvocationState {
    pub limits: crate::limits::HostLimits,
    pub cancelled: bool,
    pub deadline: Option<Instant>,
    pub stream_frames: usize,
    pub stream_total_bytes: usize,
    pub broker: Option<Arc<InvocationBroker>>,
}

impl jenny::plugin::stream::Host for InvocationState {
    fn emit_progress(&mut self, value: String) -> Result<(), String> {
        // One of the 256 stable protocol frames is reserved for the required
        // terminal frame emitted by the helper after guest settlement.
        if value.len() > 8 * 1024
            || self.stream_frames >= 255
            || self.stream_total_bytes + value.len() > 64 * 1024
        {
            return Err("stream_budget_exceeded".into());
        }
        self.broker
            .as_ref()
            .ok_or_else(|| "stream_broker_unavailable".to_string())?
            .emit_progress(&value)?;
        self.stream_frames += 1;
        self.stream_total_bytes += value.len();
        Ok(())
    }

    fn emit_data(&mut self, value: Vec<u8>) -> Result<(), String> {
        let encoded_bytes = value.len().div_ceil(3) * 4;
        if value.len() > 6 * 1024
            || self.stream_total_bytes + encoded_bytes > 64 * 1024
            || self.stream_frames >= 255
        {
            return Err("stream_budget_exceeded".into());
        }
        self.broker
            .as_ref()
            .ok_or_else(|| "stream_broker_unavailable".to_string())?
            .emit_data(&value)?;
        self.stream_frames += 1;
        self.stream_total_bytes += encoded_bytes;
        Ok(())
    }
}

impl jenny::plugin::control::Host for InvocationState {
    fn cancelled(&mut self) -> bool {
        self.cancelled
    }
}

impl jenny::plugin::network::Host for InvocationState {
    fn request(
        &mut self,
        value: jenny::plugin::network::NetworkRequest,
    ) -> Result<jenny::plugin::network::NetworkResponse, String> {
        let result = self
            .broker
            .as_ref()
            .ok_or_else(|| "network_broker_unavailable".to_string())?
            .capability_call(
                "network.request",
                serde_json::json!({
                    "method": value.method,
                    "url": value.url,
                    "body_b64": BASE64.encode(value.body),
                }),
            )?;
        let status = result
            .get("status")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .ok_or_else(|| "network_response_status_rejected".to_string())?;
        let body = result
            .get("body_b64")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "network_response_body_rejected".to_string())?;
        let body = BASE64
            .decode(body)
            .map_err(|_| "network_response_body_rejected".to_string())?;
        Ok(jenny::plugin::network::NetworkResponse { status, body })
    }
}

impl jenny::plugin::secret::Host for InvocationState {
    fn use_handle(&mut self, handle: String, request_digest: String) -> Result<(), String> {
        self.broker
            .as_ref()
            .ok_or_else(|| "secret_broker_unavailable".to_string())?
            .capability_call(
                "secret.use_handle",
                serde_json::json!({
                    "handle": handle,
                    "request_digest": request_digest,
                }),
            )?;
        Ok(())
    }
}

impl jenny::plugin::clock::Host for InvocationState {
    fn monotonic_deadline_remaining(&mut self) -> u64 {
        self.deadline
            .map(|deadline| {
                deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis() as u64
            })
            .unwrap_or(0)
    }
}
