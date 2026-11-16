//! The owner's relay: the `relay` start field, the endpoint's one custom relay, the host's
//! `relay` state line, and which path each connection uses.
//!
//! Never a default or staging relay, a second URL, a proxy from the environment or an address
//! lookup. The token and the URL never reach a line, a log, an error, `Debug` or a panic.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::{Builder, Connection, RelayStatus};
use iroh::tls::CaTlsConfig;
use iroh::{Endpoint, RelayConfig, RelayMap, RelayMode, RelayUrl, TransportAddr, Watcher};
use serde_json::{json, Map, Value};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::control::Out;
use crate::host::{stopping, Shared};

/// In characters.
const MAX_URL_CHARS: usize = 100;
/// In bytes, each printable ASCII.
const MAX_TOKEN_BYTES: usize = 256;
/// The default of `RunOptions::relay_unreachable_after`: how long the host waits for its relay
/// before it says `unreachable`. Under the supervisor's ten-second start and stop budgets; it
/// never holds `ready` or `stop`.
pub(crate) const UNREACHABLE_AFTER: Duration = Duration::from_secs(10);
pub(crate) const PATH_POLL: Duration = Duration::from_millis(500);

/// The `relay` start field when on. No `Debug` and no `Clone`: it carries the token.
pub struct RelayStart {
    url: RelayUrl,
    token: Option<Zeroizing<String>>,
}

impl RelayStart {
    pub fn url(&self) -> &RelayUrl {
        &self.url
    }

    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }
}

/// `relay`: absent or null is off; otherwise exactly `{ url, token }`. Any other shape, a URL
/// that is not plain `https://host[:port]` of at most 100 characters, or a token that is not
/// 1 to 256 printable ASCII characters is `Err`, which the caller reports as `start_invalid`.
pub(crate) fn parse(fields: &mut Map<String, Value>) -> Result<Option<RelayStart>, ()> {
    // Read in place, so the message's drop wipes the URL with the other strings.
    let Some(field) = fields.get_mut("relay") else {
        return Ok(None);
    };
    if field.is_null() {
        return Ok(None);
    }
    let Value::Object(relay) = field else {
        return Err(());
    };
    if relay.len() != 2 {
        return Err(());
    }
    let url = match relay.get("url") {
        Some(Value::String(url)) => parse_url(url)?,
        _ => return Err(()),
    };
    let token = match relay.get_mut("token") {
        Some(Value::Null) => None,
        Some(Value::String(token)) if is_token(token) => {
            Some(Zeroizing::new(std::mem::take(token)))
        }
        _ => return Err(()),
    };
    Ok(Some(RelayStart { url, token }))
}

/// The bridge's own check, before the URL parser sees it: `https://`, then a host and an
/// optional port, nothing else.
fn parse_url(text: &str) -> Result<RelayUrl, ()> {
    if text.chars().count() > MAX_URL_CHARS {
        return Err(());
    }
    let rest = text.strip_prefix("https://").ok_or(())?;
    let plain = |c: char| !c.is_control() && !c.is_whitespace() && !"/?#@\\".contains(c);
    if rest.is_empty() || !rest.chars().all(plain) {
        return Err(());
    }
    let url: RelayUrl = text.parse().map_err(|_| ())?;
    let ok = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host().is_some()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();
    if ok {
        Ok(url)
    } else {
        Err(())
    }
}

fn is_token(token: &str) -> bool {
    (1..=MAX_TOKEN_BYTES).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_graphic())
}

/// The endpoint's relay: none (iroh's Minimal preset has no relay transport), or exactly the
/// owner's one. `tls` is the test seam (`RunOptions::relay_tls`); `None` keeps the embedded
/// roots.
pub(crate) fn configure(
    builder: Builder,
    relay: Option<&RelayStart>,
    tls: Option<&CaTlsConfig>,
) -> Builder {
    let Some(relay) = relay else {
        return builder;
    };
    let mut config = RelayConfig::from(relay.url.clone());
    if let Some(token) = &relay.token {
        // iroh keeps its own copy as a plain `String` (a known limit in the spec).
        config = config.with_auth_token(token.as_str());
    }
    let builder = builder.relay_mode(RelayMode::Custom(RelayMap::from(config)));
    match tls {
        Some(tls) => builder.ca_tls_config(tls.clone()),
        None => builder,
    }
}

/// What the host says about its relay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RelayState {
    Connecting,
    Connected,
    Denied,
    Unreachable,
}

impl RelayState {
    fn as_str(self) -> &'static str {
        match self {
            RelayState::Connecting => "connecting",
            RelayState::Connected => "connected",
            RelayState::Denied => "denied",
            RelayState::Unreachable => "unreachable",
        }
    }
}

/// The state after one look at the relay: `connected` wins, then a refused token. `denied`
/// holds until the relay connects: iroh retries a refused relay and each retry first reads as
/// neither. Down after `connected` starts a new wait; down while waiting or unreachable keeps
/// the state (the deadline moves a wait to unreachable).
fn next_state(current: RelayState, connected: bool, denied: bool) -> RelayState {
    if connected {
        RelayState::Connected
    } else if denied {
        RelayState::Denied
    } else {
        match current {
            RelayState::Connected => RelayState::Connecting,
            other => other,
        }
    }
}

/// One look at the home relay statuses: whether one is connected, and whether the relay refused
/// the token.
pub(crate) fn look(statuses: &[RelayStatus]) -> (bool, bool) {
    let connected = statuses.iter().any(RelayStatus::is_connected);
    let denied = statuses
        .iter()
        .any(|status| status.auth_denied_reason().is_some());
    (connected, denied)
}

/// What a member saw of its relay over one dial, by the host's rule: connected at any time is
/// `host_unreachable`, refused at any time and never connected is `relay_denied`, neither is
/// `relay_unreachable`.
pub(crate) struct DialLook {
    state: RelayState,
    connected: bool,
    denied: bool,
}

impl Default for DialLook {
    fn default() -> Self {
        Self {
            state: RelayState::Connecting,
            connected: false,
            denied: false,
        }
    }
}

impl DialLook {
    pub(crate) fn see(&mut self, (connected, denied): (bool, bool)) {
        self.state = next_state(self.state, connected, denied);
        self.connected |= self.state == RelayState::Connected;
        self.denied |= self.state == RelayState::Denied;
    }

    pub(crate) fn reason(&self) -> &'static str {
        if self.connected {
            "host_unreachable"
        } else if self.denied {
            "relay_denied"
        } else {
            "relay_unreachable"
        }
    }
}

async fn send_state(out: &Out, state: &str) {
    out.send(json!({ "t": "relay", "state": state })).await;
}

/// The host's `relay` lines: on change only, and `off` last when the bridge stops.
async fn report(
    out: Out,
    endpoint: Endpoint,
    unreachable_after: Duration,
    mut stop: watch::Receiver<bool>,
) {
    let mut watcher = endpoint.home_relay_status();
    drop(endpoint);
    let (connected, denied) = look(&watcher.get());
    let mut state = next_state(RelayState::Connecting, connected, denied);
    let mut deadline = Instant::now() + unreachable_after;
    send_state(&out, state.as_str()).await;
    let mut watching = true;
    loop {
        let waiting = state == RelayState::Connecting;
        let next = tokio::select! {
            biased;
            _ = stopping(&mut stop) => break,
            _ = tokio::time::sleep_until(deadline), if waiting => RelayState::Unreachable,
            update = watcher.updated(), if watching => match update {
                Ok(statuses) => {
                    let (connected, denied) = look(&statuses);
                    next_state(state, connected, denied)
                }
                Err(_) => {
                    watching = false;
                    state
                }
            },
        };
        if next != state {
            if next == RelayState::Connecting {
                deadline = Instant::now() + unreachable_after;
            }
            state = next;
            send_state(&out, state.as_str()).await;
        }
    }
    send_state(&out, "off").await;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathKind {
    Relay,
    Direct { public: bool },
}

impl PathKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            PathKind::Relay => "relay",
            PathKind::Direct { .. } => "direct",
        }
    }
}

/// The selected path only: `None` until iroh has selected one of a known kind.
pub(crate) fn path_of(conn: &Connection) -> Option<PathKind> {
    let paths = conn.paths();
    let chosen = paths.iter().find(|path| path.is_selected())?;
    match chosen.remote_addr() {
        TransportAddr::Relay(_) => Some(PathKind::Relay),
        // Only an IPv4 peer counts as outside: a global IPv6 peer may sit on the host's own LAN,
        // and would read as proof that the router lets the internet in.
        TransportAddr::Ip(address) => Some(PathKind::Direct {
            public: address.ip().to_canonical().is_ipv4() && is_public(address.ip()),
        }),
        _ => None,
    }
}

/// An address on the internet: not private, loopback, link-local, shared (100.64/10),
/// unspecified, multicast, broadcast or documentation, and not an IPv6 unique-local.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_documentation()
                || (a == 100 && (64..128).contains(&b)))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || first == 0x2001 && v6.segments()[1] == 0x0db8)
        }
    }
}

/// With a relay configured: the `relay` line task (joined at stop, it owes `off`). With a relay
/// or internet joining (`follow`): the path follower (aborted at stop).
pub(crate) fn spawn_tasks(
    relay: bool,
    follow: bool,
    shared: &Arc<Shared>,
    endpoint: &Endpoint,
    unreachable_after: Duration,
    stop: &watch::Receiver<bool>,
) -> [Option<JoinHandle<()>>; 2] {
    [
        relay.then(|| {
            tokio::spawn(report(
                shared.out.clone(),
                endpoint.clone(),
                unreachable_after,
                stop.clone(),
            ))
        }),
        follow.then(|| tokio::spawn(follow_paths(shared.clone()))),
    ]
}

/// Keeps each live connection's path current, so the stats line counts direct-external and
/// relayed connections. Runs until aborted at stop.
async fn follow_paths(shared: Arc<Shared>) {
    let mut tick = tokio::time::interval(PATH_POLL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let mut state = shared.lock();
        let mut changed = false;
        for (conn, path) in state.paths.values_mut() {
            let now = path_of(conn);
            if now.is_some() && now != *path {
                *path = now;
                changed = true;
            }
        }
        if changed {
            shared.publish(&state);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_moves_on_each_look() {
        use RelayState::*;
        assert_eq!(next_state(Connecting, true, false), Connected);
        assert_eq!(next_state(Connecting, false, true), Denied);
        assert_eq!(next_state(Connecting, false, false), Connecting);
        assert_eq!(next_state(Connected, false, false), Connecting);
        assert_eq!(next_state(Denied, false, false), Denied, "denied holds");
        assert_eq!(next_state(Denied, true, true), Connected);
        assert_eq!(next_state(Unreachable, false, false), Unreachable);
        assert_eq!(next_state(Unreachable, false, true), Denied);
        assert_eq!(next_state(Unreachable, true, false), Connected);
    }

    #[test]
    fn a_dial_names_what_it_saw_of_the_relay_over_the_whole_dial() {
        let reason = |looks: &[(bool, bool)]| {
            let mut dial = DialLook::default();
            for &look in looks {
                dial.see(look);
            }
            dial.reason()
        };
        // Refused, a retry in between, refused again.
        assert_eq!(
            reason(&[(false, true), (false, false), (false, true)]),
            "relay_denied"
        );
        // Refused, then caught between two retries at the end.
        assert_eq!(reason(&[(false, true), (false, false)]), "relay_denied");
        assert_eq!(reason(&[(true, false), (false, false)]), "host_unreachable");
        assert_eq!(reason(&[(false, true), (true, false)]), "host_unreachable");
        assert_eq!(reason(&[(false, false)]), "relay_unreachable");
        assert_eq!(reason(&[]), "relay_unreachable");
    }

    #[test]
    fn public_addresses() {
        for public in [
            "8.8.8.8",
            "100.128.0.1",
            "2606:4700::1111",
            "::ffff:1.1.1.1",
        ] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
        for private in [
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.0.1",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "192.0.2.1",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:192.168.0.1",
        ] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }
    }
}
