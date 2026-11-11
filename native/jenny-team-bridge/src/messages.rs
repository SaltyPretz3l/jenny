//! The typed control messages and their validation.

use std::net::SocketAddr;

use serde_json::Value;
use zeroize::Zeroizing;

use crate::control::{field, parse_message, Message, Reason};

/// The most addresses a member `start` may carry.
pub const MAX_ADDRESSES: usize = 16;

pub struct HostLimits {
    pub max_connections: u32,
    pub max_streams_per_connection: u32,
    pub max_streams_total: u32,
    pub max_handshakes: u32,
    pub admit_timeout_ms: u32,
    pub drop_grace_ms: u32,
}

/// `start` in host mode. No `Debug`: it carries secrets.
pub struct HostStart {
    pub secret_key: Zeroizing<[u8; 32]>,
    pub boot_secret: Zeroizing<[u8; 32]>,
    pub alpn: Vec<u8>,
    pub loopback_port: u16,
    pub direct_port: Option<u16>,
    pub limits: HostLimits,
    /// Optional `loopback_only` (default false): bind loopback sockets only. Used by
    /// the real-binary tests so no socket listens on a real interface.
    pub loopback_only: bool,
}

pub struct MemberLimits {
    pub max_preamble_sockets: u32,
    pub max_streams: u32,
    pub preamble_timeout_ms: u32,
    pub connect_timeout_ms: u32,
}

/// `start` in member mode. No `Debug`: it carries secrets.
pub struct MemberStart {
    pub secret_key: Zeroizing<[u8; 32]>,
    pub host_key: [u8; 32],
    pub addresses: Vec<SocketAddr>,
    pub alpn: Vec<u8>,
    pub launch_secret: Zeroizing<[u8; 32]>,
    pub limits: MemberLimits,
    /// Optional `loopback_only` (default false), as for the host.
    pub loopback_only: bool,
}

/// What an `admit_answer` says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmitKind {
    Device,
    Invite,
}

impl AdmitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AdmitKind::Device => "device",
            AdmitKind::Invite => "invite",
        }
    }
}

/// Host input after `start`.
#[derive(Debug, PartialEq, Eq)]
pub enum HostCommand {
    /// `kind` is `None` for `null` or any value other than `device` or `invite`.
    AdmitAnswer {
        conn: u64,
        kind: Option<AdmitKind>,
    },
    Drop {
        key: [u8; 32],
    },
    Stop,
}

/// Member input after `start`.
#[derive(Debug, PartialEq, Eq)]
pub enum MemberCommand {
    Stop,
}

/// Reads the first line as a `start` message. A line that is not a message at all, or a
/// message other than `start`, is `protocol_invalid`; a bad `start` is `start_invalid`.
fn start_message(line: &[u8]) -> Result<Message, Reason> {
    let message = parse_message(line)?;
    if message.t != "start" {
        return Err(Reason::ProtocolInvalid);
    }
    Ok(message)
}

/// An optional boolean field: absent is false, anything but a boolean is invalid.
fn optional_bool(fields: &serde_json::Map<String, Value>, name: &str) -> Result<bool, ()> {
    match fields.get(name) {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(()),
    }
}

pub fn parse_host_start(line: &[u8]) -> Result<HostStart, Reason> {
    let mut message = start_message(line)?;
    host_start_fields(&mut message).map_err(|_| Reason::StartInvalid)
}

fn host_start_fields(message: &mut Message) -> Result<HostStart, ()> {
    let fields = &mut message.fields;
    field::mode(fields, "host")?;
    let alpn = field::alpn(fields)?;
    let loopback_port = field::port(fields, "loopback_port")?;
    let direct_port = field::optional_port(fields, "direct_port")?;
    let loopback_only = optional_bool(fields, "loopback_only")?;
    let limits = field::object(fields, "limits")?;
    let limits = HostLimits {
        max_connections: field::limit(&limits, "max_connections")?,
        max_streams_per_connection: field::limit(&limits, "max_streams_per_connection")?,
        max_streams_total: field::limit(&limits, "max_streams_total")?,
        max_handshakes: field::limit(&limits, "max_handshakes")?,
        admit_timeout_ms: field::limit(&limits, "admit_timeout_ms")?,
        drop_grace_ms: field::limit(&limits, "drop_grace_ms")?,
    };
    let secret_key = field::take_b64_32(fields, "secret_key")?;
    let boot_secret = field::take_b64_32(fields, "boot_secret")?;
    Ok(HostStart {
        secret_key,
        boot_secret,
        alpn,
        loopback_port,
        direct_port,
        limits,
        loopback_only,
    })
}

pub fn parse_member_start(line: &[u8]) -> Result<MemberStart, Reason> {
    let mut message = start_message(line)?;
    member_start_fields(&mut message).map_err(|_| Reason::StartInvalid)
}

fn member_start_fields(message: &mut Message) -> Result<MemberStart, ()> {
    let fields = &mut message.fields;
    field::mode(fields, "member")?;
    let alpn = field::alpn(fields)?;
    let loopback_only = optional_bool(fields, "loopback_only")?;
    let addresses = match fields.get("addresses") {
        Some(Value::Array(items)) if items.len() <= MAX_ADDRESSES => items
            .iter()
            .map(|item| {
                item.as_str()
                    .and_then(|text| text.parse::<SocketAddr>().ok())
            })
            .collect::<Option<Vec<_>>>()
            .ok_or(())?,
        _ => return Err(()),
    };
    let limits = field::object(fields, "limits")?;
    let limits = MemberLimits {
        max_preamble_sockets: field::limit(&limits, "max_preamble_sockets")?,
        max_streams: field::limit(&limits, "max_streams")?,
        preamble_timeout_ms: field::limit(&limits, "preamble_timeout_ms")?,
        connect_timeout_ms: field::limit(&limits, "connect_timeout_ms")?,
    };
    let host_key = *field::take_b64_32(fields, "host_key")?;
    // The host key must be a valid Ed25519 point, or no dial could ever authenticate it.
    iroh::PublicKey::from_bytes(&host_key).map_err(|_| ())?;
    let secret_key = field::take_b64_32(fields, "secret_key")?;
    let launch_secret = field::take_b64_32(fields, "launch_secret")?;
    Ok(MemberStart {
        secret_key,
        host_key,
        addresses,
        alpn,
        launch_secret,
        limits,
        loopback_only,
    })
}

pub fn parse_host_command(line: &[u8]) -> Result<HostCommand, Reason> {
    let mut message = parse_message(line)?;
    let fields = &mut message.fields;
    let invalid = |_| Reason::ProtocolInvalid;
    match message.t.as_str() {
        "admit_answer" => {
            let conn = field::u64_of(fields, "conn").map_err(invalid)?;
            let kind = match fields.get("kind") {
                Some(Value::String(kind)) if kind == "device" => Some(AdmitKind::Device),
                Some(Value::String(kind)) if kind == "invite" => Some(AdmitKind::Invite),
                // Fail closed: null or any other value refuses.
                Some(_) => None,
                None => return Err(Reason::ProtocolInvalid),
            };
            Ok(HostCommand::AdmitAnswer { conn, kind })
        }
        "drop" => {
            let key = *field::take_b64_32(fields, "key").map_err(invalid)?;
            Ok(HostCommand::Drop { key })
        }
        "stop" => Ok(HostCommand::Stop),
        _ => Err(Reason::ProtocolInvalid),
    }
}

pub fn parse_member_command(line: &[u8]) -> Result<MemberCommand, Reason> {
    let message = parse_message(line)?;
    match message.t.as_str() {
        "stop" => Ok(MemberCommand::Stop),
        _ => Err(Reason::ProtocolInvalid),
    }
}
