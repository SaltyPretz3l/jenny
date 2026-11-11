//! The two binary preambles that start every loopback TCP connection in team mode.
//!
//! - host preamble (72 bytes): `JNYT` | version 1 | 3 zero bytes | per-boot secret (32) |
//!   authenticated remote public key (32)
//! - member preamble (40 bytes): `JNYT` | version 1 | 3 zero bytes | per-launch secret (32)

use zeroize::Zeroizing;

pub const SECRET_BYTES: usize = 32;
pub const KEY_BYTES: usize = 32;
pub const HEADER_BYTES: usize = 8;
pub const HOST_PREAMBLE_BYTES: usize = HEADER_BYTES + SECRET_BYTES + KEY_BYTES;
pub const MEMBER_PREAMBLE_BYTES: usize = HEADER_BYTES + SECRET_BYTES;

const MAGIC: [u8; 4] = *b"JNYT";
const VERSION: u8 = 1;

fn header() -> [u8; HEADER_BYTES] {
    let mut bytes = [0u8; HEADER_BYTES];
    bytes[..4].copy_from_slice(&MAGIC);
    bytes[4] = VERSION;
    bytes
}

fn header_is_valid(bytes: &[u8]) -> bool {
    bytes.len() >= HEADER_BYTES && bytes[..HEADER_BYTES] == header()
}

/// Compares two 32-byte values in time that does not depend on where they differ.
fn constant_time_eq(left: &[u8], right: &[u8; SECRET_BYTES]) -> bool {
    if left.len() != SECRET_BYTES {
        return false;
    }
    let difference = left
        .iter()
        .zip(right.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    std::hint::black_box(difference) == 0
}

/// Encodes the 72-byte host preamble.
pub fn encode_host(
    boot_secret: &[u8; SECRET_BYTES],
    remote_key: &[u8; KEY_BYTES],
) -> Zeroizing<[u8; HOST_PREAMBLE_BYTES]> {
    let mut bytes = Zeroizing::new([0u8; HOST_PREAMBLE_BYTES]);
    bytes[..HEADER_BYTES].copy_from_slice(&header());
    bytes[HEADER_BYTES..HEADER_BYTES + SECRET_BYTES].copy_from_slice(boot_secret);
    bytes[HEADER_BYTES + SECRET_BYTES..].copy_from_slice(remote_key);
    bytes
}

/// The parts of a well-formed host preamble.
pub struct HostPreamble {
    pub secret: Zeroizing<[u8; SECRET_BYTES]>,
    pub remote_key: [u8; KEY_BYTES],
}

/// Decodes a well-formed 72-byte host preamble, else `None`.
pub fn decode_host(bytes: &[u8]) -> Option<HostPreamble> {
    if bytes.len() != HOST_PREAMBLE_BYTES || !header_is_valid(bytes) {
        return None;
    }
    let mut secret = Zeroizing::new([0u8; SECRET_BYTES]);
    secret.copy_from_slice(&bytes[HEADER_BYTES..HEADER_BYTES + SECRET_BYTES]);
    let mut remote_key = [0u8; KEY_BYTES];
    remote_key.copy_from_slice(&bytes[HEADER_BYTES + SECRET_BYTES..]);
    Some(HostPreamble { secret, remote_key })
}

/// Encodes the 40-byte member preamble.
pub fn encode_member(launch_secret: &[u8; SECRET_BYTES]) -> Zeroizing<[u8; MEMBER_PREAMBLE_BYTES]> {
    let mut bytes = Zeroizing::new([0u8; MEMBER_PREAMBLE_BYTES]);
    bytes[..HEADER_BYTES].copy_from_slice(&header());
    bytes[HEADER_BYTES..].copy_from_slice(launch_secret);
    bytes
}

/// True when `bytes` is a well-formed member preamble carrying `launch_secret`.
pub fn verify_member(bytes: &[u8], launch_secret: &[u8; SECRET_BYTES]) -> bool {
    if bytes.len() != MEMBER_PREAMBLE_BYTES || !header_is_valid(bytes) {
        return false;
    }
    constant_time_eq(&bytes[HEADER_BYTES..], launch_secret)
}
