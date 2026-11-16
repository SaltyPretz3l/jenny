//! The loopback test relay (`iroh::test_utils`, a dev-dependency only), raw relay clients and a
//! TCP forwarder that stands in for a relay coming up later. Nothing here leaves loopback.
#![allow(dead_code)]

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use iroh::endpoint::presets;
use iroh::tls::CaTlsConfig;
use iroh::{Endpoint, EndpointAddr, RelayMode, RelayUrl, SecretKey, TransportAddr};
use iroh_relay::server::{Access, AccessControl, ClientRequest};
use jenny_team_bridge::RunOptions;
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use super::raw::public_key;
use super::{free_udp_port, options};

/// A running test relay: its URL as the parent would send it (no trailing slash) and the
/// server, which stops when dropped.
pub struct TestRelay {
    pub url: String,
    pub https: SocketAddr,
    _server: iroh_relay::server::Server,
}

pub async fn test_relay() -> TestRelay {
    let (_map, url, server) = iroh::test_utils::run_relay_server()
        .await
        .expect("start the loopback test relay");
    relay_of(url, server)
}

fn relay_of(url: RelayUrl, server: iroh_relay::server::Server) -> TestRelay {
    let https = server.https_addr().expect("the relay serves https");
    TestRelay {
        url: url.to_string().trim_end_matches('/').to_string(),
        https,
        _server: server,
    }
}

/// Admits a client only with this bearer token, as the owner's relay with `shared_token` does.
#[derive(Debug)]
struct TokenAccess(String);

impl AccessControl for TokenAccess {
    async fn on_connect(&self, request: &ClientRequest) -> Access {
        if request.auth_token().as_deref() == Some(self.0.as_str()) {
            Access::Allow
        } else {
            Access::Deny {
                reason: Some("token refused".to_string()),
            }
        }
    }
}

/// A loopback test relay that admits only `token`.
pub async fn test_relay_with_token(token: &str) -> TestRelay {
    let access = Arc::new(TokenAccess(token.to_string()));
    let (_map, url, server) = iroh::test_utils::run_relay_server_with_access(true, access)
        .await
        .expect("start the token-checking test relay");
    relay_of(url, server)
}

/// Options that trust the test relay's self-signed certificate: the test-only seam.
pub fn relay_options() -> RunOptions {
    RunOptions {
        relay_tls: Some(CaTlsConfig::insecure_skip_verify()),
        ..options()
    }
}

pub fn relay_field(url: &str, token: Option<&str>) -> Value {
    json!({ "url": url, "token": token })
}

/// A relay URL on a loopback port nothing listens on, and that port.
pub fn absent_relay() -> (String, u16) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a probe port");
    let port = listener.local_addr().expect("probe addr").port();
    drop(listener);
    (format!("https://127.0.0.1:{port}"), port)
}

/// An `https://` URL of exactly `len` characters whose host is made of valid labels.
pub fn url_of_length(len: usize) -> String {
    let want = len - "https://".len();
    let mut host = String::new();
    while host.len() < want {
        if !host.is_empty() && want - host.len() >= 2 {
            host.push('.');
        }
        let room = want - host.len();
        host.push_str(&"a".repeat(room.min(40)));
    }
    format!("https://{host}")
}

/// A loopback address nothing answers on, for a member's dial list.
pub fn dead_address() -> Value {
    json!([format!("127.0.0.1:{}", free_udp_port())])
}

/// Forwards every TCP connection on `127.0.0.1:port` to `to`: the relay "comes up".
pub async fn forward(port: u16, to: SocketAddr) -> JoinHandle<()> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .expect("bind the forwarder");
    tokio::spawn(async move {
        while let Ok((mut inbound, _)) = listener.accept().await {
            tokio::spawn(async move {
                if let Ok(mut outbound) = TcpStream::connect(to).await {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
            });
        }
    })
}

/// A raw client endpoint with the relay as its only transport: no IP socket, so no hole
/// punching moves its connections off the relay.
pub async fn relay_client(secret: &[u8; 32], url: &str) -> Endpoint {
    let url: RelayUrl = url.parse().expect("relay url");
    Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(secret))
        .clear_ip_transports()
        .relay_mode(RelayMode::custom([url]))
        .ca_tls_config(CaTlsConfig::insecure_skip_verify())
        .bind()
        .await
        .expect("bind relay client")
}

/// The host reached through the relay only.
pub fn relay_dial(host_public: &str, url: &str) -> EndpointAddr {
    let url: RelayUrl = url.parse().expect("relay url");
    EndpointAddr::from_parts(public_key(host_public), [TransportAddr::Relay(url)])
}
