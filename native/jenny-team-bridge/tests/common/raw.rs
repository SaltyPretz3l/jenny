//! Raw iroh clients for the admission tests: a client endpoint the test drives itself
//! (for 0-RTT and floods), and a UDP proxy that stalls every handshake it carries.
#![allow(dead_code)]

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey, TransportAddr};
use serde_json::Value;
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

pub const ALPN: &[u8] = b"jenny-team/1";

/// A client endpoint bound to `ip` on an ephemeral port.
pub async fn client_endpoint(secret: &[u8; 32], ip: IpAddr) -> Endpoint {
    Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(secret))
        .clear_ip_transports()
        .bind_addr(SocketAddr::new(ip, 0))
        .expect("bind address")
        .bind()
        .await
        .expect("bind client endpoint")
}

/// A bare host on loopback for a real member bridge to dial: it admits whoever connects,
/// and the test reads each stream exactly as the member bridge wrote it.
pub async fn host_endpoint(secret: &[u8; 32]) -> Endpoint {
    Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(secret))
        .alpns(vec![ALPN.to_vec()])
        .clear_ip_transports()
        .bind_addr(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .expect("bind address")
        .bind()
        .await
        .expect("bind host endpoint")
}

/// The endpoint's addresses as a `ready` line gives them.
pub fn addresses_of(endpoint: &Endpoint) -> Value {
    let all: Vec<String> = endpoint
        .addr()
        .ip_addrs()
        .map(|ip| ip.to_string())
        .collect();
    Value::from(all)
}

pub fn public_key(text: &str) -> PublicKey {
    let bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(text)
        .expect("base64url key")
        .try_into()
        .expect("32 bytes");
    PublicKey::from_bytes(&bytes).expect("valid key")
}

/// The host's IPv4 loopback address from its `ready` addresses.
pub fn ipv4_address(addresses: &Value) -> SocketAddr {
    addresses
        .as_array()
        .expect("addresses array")
        .iter()
        .filter_map(|item| item.as_str()?.parse::<SocketAddr>().ok())
        .find(SocketAddr::is_ipv4)
        .expect("an IPv4 address")
}

pub fn dial_addr(host_public: &str, at: SocketAddr) -> EndpointAddr {
    EndpointAddr::from_parts(public_key(host_public), [TransportAddr::Ip(at)])
}

/// A second loopback source address: `127.0.0.2` where the OS routes it, else `::1`.
pub async fn other_loopback_source() -> IpAddr {
    let candidate = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2));
    if UdpSocket::bind((candidate, 0)).await.is_ok() {
        candidate
    } else {
        IpAddr::V6(Ipv6Addr::LOCALHOST)
    }
}

/// The length of the first QUIC packet in `datagram` when it is a long-header Initial.
fn first_initial_len(datagram: &[u8]) -> Option<usize> {
    let first = *datagram.first()?;
    // Long header with packet type 0 (Initial, QUIC v1).
    if first & 0x80 == 0 || (first & 0x30) != 0 {
        return None;
    }
    let mut at = 5;
    let dcid = usize::from(*datagram.get(at)?);
    at += 1 + dcid;
    let scid = usize::from(*datagram.get(at)?);
    at += 1 + scid;
    let (token, used) = varint(datagram.get(at..)?)?;
    at += used + token;
    let (length, used) = varint(datagram.get(at..)?)?;
    let end = at + used + length;
    (end <= datagram.len()).then_some(end)
}

fn varint(bytes: &[u8]) -> Option<(usize, usize)> {
    let first = *bytes.first()?;
    let used = 1usize << (first >> 6);
    let mut value = u64::from(first & 0x3f);
    for byte in bytes.get(1..used)? {
        value = (value << 8) | u64::from(*byte);
    }
    Some((usize::try_from(value).ok()?, used))
}

/// Carries a client's datagrams to `target` from a socket bound to `source`, but only the
/// first packet of each datagram and only when it is an Initial. The host therefore sees a
/// validated ClientHello (the retry round trip passes) and never the client's Finished: each
/// connection holds a handshake slot until the host's handshake timeout.
pub struct StallProxy {
    pub front: SocketAddr,
    task: JoinHandle<()>,
}

impl StallProxy {
    pub async fn start(target: SocketAddr, source: IpAddr) -> Self {
        let front = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind proxy front");
        let back = UdpSocket::bind((source, 0)).await.expect("bind proxy back");
        let front_addr = front.local_addr().expect("front address");
        let task = tokio::spawn(async move {
            let mut client: Option<SocketAddr> = None;
            let mut up = vec![0u8; 65536];
            let mut down = vec![0u8; 65536];
            loop {
                tokio::select! {
                    received = front.recv_from(&mut up) => {
                        let Ok((length, from)) = received else { return };
                        client = Some(from);
                        if let Some(end) = first_initial_len(&up[..length]) {
                            let _ = back.send_to(&up[..end], target).await;
                        }
                    }
                    received = back.recv_from(&mut down) => {
                        let Ok((length, _)) = received else { return };
                        if let Some(to) = client {
                            let _ = front.send_to(&down[..length], to).await;
                        }
                    }
                }
            }
        });
        Self {
            front: front_addr,
            task,
        }
    }
}

impl Drop for StallProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}
