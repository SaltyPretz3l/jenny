use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
pub struct Bootstrap {
    pub bootstrap_schema_version: u32,
    pub process_key: String,
    pub process_instance_id: String,
    pub launch_nonce: String,
    pub host_digest: String,
    pub protocol_digest: String,
    pub abi_digest: String,
    pub publisher_id: String,
    pub plugin_id: String,
    pub contribution_id: String,
    pub artifact_digest: String,
    pub component_digest: String,
    pub generation_id: String,
    pub commit_epoch: u64,
    pub lifecycle_epoch: u64,
    pub channel_id: String,
}

#[derive(Debug, Serialize)]
pub struct Attestation<'a> {
    pub attestation_schema_version: u32,
    pub process_instance_id: &'a str,
    pub launch_nonce: &'a str,
    pub host_digest: &'a str,
    pub backend_version: &'static str,
    pub protocol_digest: &'a str,
    pub abi_digest: &'a str,
    pub publisher_id: &'a str,
    pub plugin_id: &'a str,
    pub contribution_id: &'a str,
    pub artifact_digest: &'a str,
    pub component_digest: &'a str,
    pub generation_id: &'a str,
    pub commit_epoch: u64,
    pub lifecycle_epoch: u64,
    pub channel_id: &'a str,
}

impl Bootstrap {
    pub fn attest(&self) -> Attestation<'_> {
        Attestation {
            attestation_schema_version: 4,
            process_instance_id: &self.process_instance_id,
            launch_nonce: &self.launch_nonce,
            host_digest: &self.host_digest,
            backend_version: "47.0.3",
            protocol_digest: &self.protocol_digest,
            abi_digest: &self.abi_digest,
            publisher_id: &self.publisher_id,
            plugin_id: &self.plugin_id,
            contribution_id: &self.contribution_id,
            artifact_digest: &self.artifact_digest,
            component_digest: &self.component_digest,
            generation_id: &self.generation_id,
            commit_epoch: self.commit_epoch,
            lifecycle_epoch: self.lifecycle_epoch,
            channel_id: &self.channel_id,
        }
    }
}
