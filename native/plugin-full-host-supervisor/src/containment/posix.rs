use std::path::Path;
use crate::process_tree::TerminationProof;
use super::WorkloadLimits;

#[derive(Clone, Copy)]
pub struct TerminationHandle;
impl TerminationHandle {
    pub fn terminate(&self) -> TerminationProof { TerminationProof::unproven() }
}

pub struct ContainedProcess { pub pid: u32 }
impl ContainedProcess {
    pub fn termination_handle(&self) -> TerminationHandle { TerminationHandle }
    pub fn peer_identity_digest(&self) -> String { "0".repeat(64) }
    pub fn initialize(&mut self, _session_id: &str, _session_epoch: u64) -> Result<(), String> {
        Err("equivalent_authenticated_transport_unavailable".to_string())
    }
    pub fn exchange(&mut self, _operation: &str, _payload_json: &str) -> Result<serde_json::Value, String> {
        Err("equivalent_authenticated_transport_unavailable".to_string())
    }
    pub fn deliver_secret(&mut self, _grant_id: &str, _secret: &[u8])
        -> Result<serde_json::Value, String> {
        Err("equivalent_authenticated_secret_transport_unavailable".to_string())
    }
    pub fn terminate(self) -> TerminationProof { TerminationProof::unproven() }
}

pub fn terminate_or_prove_absent(_session_id: &str, _session_epoch: u64,
    _proof_timeout_ms: u64) -> TerminationProof {
    TerminationProof::unproven()
}

pub fn launch(_path: &Path, _session_id: &str, _session_epoch: u64,
    _limits: WorkloadLimits) -> Result<ContainedProcess, String> {
    Err("equivalent_identity_stable_containment_unavailable".to_string())
}
