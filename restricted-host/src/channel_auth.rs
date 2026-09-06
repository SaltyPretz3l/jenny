use anyhow::{Context, Result, bail};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthenticatedFrame {
    pub channel_id: String,
    pub sequence: u64,
    pub kind: String,
    pub payload_json: String,
    pub payload_digest: String,
    pub mac: String,
}

fn digest(payload: &str) -> String {
    hex::encode(Sha256::digest(payload.as_bytes()))
}

fn mac_input(channel_id: &str, sequence: u64, kind: &str, payload_digest: &str) -> Vec<u8> {
    format!("{channel_id}\0{sequence}\0{kind}\0{payload_digest}").into_bytes()
}

pub fn sign(
    key: &[u8],
    channel_id: &str,
    sequence: u64,
    kind: &str,
    payload_json: String,
) -> Result<AuthenticatedFrame> {
    let payload_digest = digest(&payload_json);
    let mut signer = HmacSha256::new_from_slice(key).context("invalid channel key")?;
    signer.update(&mac_input(channel_id, sequence, kind, &payload_digest));
    let mac = hex::encode(signer.finalize().into_bytes());
    Ok(AuthenticatedFrame {
        channel_id: channel_id.into(),
        sequence,
        kind: kind.into(),
        payload_json,
        payload_digest,
        mac,
    })
}

pub fn verify<'a>(
    key: &[u8],
    expected_channel: &str,
    expected_sequence: u64,
    frame: &'a AuthenticatedFrame,
) -> Result<&'a str> {
    if frame.channel_id != expected_channel || frame.sequence != expected_sequence {
        bail!("channel identity or sequence rejected");
    }
    if digest(&frame.payload_json) != frame.payload_digest {
        bail!("payload digest rejected");
    }
    let mut verifier = HmacSha256::new_from_slice(key).context("invalid channel key")?;
    verifier.update(&mac_input(
        &frame.channel_id,
        frame.sequence,
        &frame.kind,
        &frame.payload_digest,
    ));
    verifier
        .verify_slice(&hex::decode(&frame.mac).context("invalid frame mac")?)
        .context("frame authentication rejected")?;
    Ok(&frame.payload_json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_replay_and_tamper() {
        let key = [7_u8; 32];
        let frame = sign(&key, "channel_1", 0, "invoke", "{}".into()).unwrap();
        assert_eq!(verify(&key, "channel_1", 0, &frame).unwrap(), "{}");
        assert!(verify(&key, "channel_1", 1, &frame).is_err());
        let mut changed = frame;
        changed.payload_json = "[]".into();
        assert!(verify(&key, "channel_1", 0, &changed).is_err());
    }
}
