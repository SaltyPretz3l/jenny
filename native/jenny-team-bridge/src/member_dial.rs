//! The member's endpoint: bound as narrowly as its dial allows, turning away every connection
//! that arrives (a member accepts none), and the offline reason a host's close means.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use iroh::endpoint::{
    presets, BindOpts, ConnectError, ConnectingError, ConnectionError, TransportErrorCode,
};
use iroh::tls::CaTlsConfig;
use iroh::{Endpoint, SecretKey};
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use crate::pipe::{CODE_ADMIT_TIMEOUT, CODE_COOLDOWN, CODE_REFUSED};
use crate::relay::{self, RelayStart};

/// The member's offline reason for a connection the host closed with one of its codes, or
/// `None` for an ordinary close (or an error that is no close at all).
pub(crate) fn offline_reason(error: &ConnectionError) -> Option<&'static str> {
    match error {
        ConnectionError::ApplicationClosed(close) => {
            match u32::try_from(close.error_code.into_inner()) {
                Ok(CODE_REFUSED) => Some("host_refused"),
                Ok(CODE_COOLDOWN) => Some("host_cooldown"),
                Ok(CODE_ADMIT_TIMEOUT) => Some("host_admit_timeout"),
                _ => None,
            }
        }
        ConnectionError::ConnectionClosed(close)
            if close.error_code == TransportErrorCode::CONNECTION_REFUSED =>
        {
            Some("host_refused")
        }
        _ => None,
    }
}

/// [`offline_reason`] for a dial that failed.
pub(crate) fn connect_reason(error: &ConnectError) -> Option<&'static str> {
    match error {
        ConnectError::Connecting {
            source: ConnectingError::ConnectionError { source, .. },
            ..
        } => offline_reason(source),
        ConnectError::Connection { source, .. } => offline_reason(source),
        _ => None,
    }
}

/// Which IP families the member binds a socket for: only those its dial list names, unless a
/// relay is configured (iroh may then move the connection to a direct path of either family).
/// An IPv4-mapped IPv6 address counts as both; an empty list without a relay binds IPv4 only.
pub(crate) fn ip_families(addresses: &[SocketAddr], relay: bool) -> (bool, bool) {
    if relay {
        return (true, true);
    }
    let v4 = addresses
        .iter()
        .any(|address| address.ip().to_canonical().is_ipv4());
    let v6 = addresses.iter().any(SocketAddr::is_ipv6);
    (v4 || !v6, v6)
}

pub(crate) struct BindPlan<'a> {
    pub loopback_only: bool,
    pub addresses: &'a [SocketAddr],
    pub relay: Option<&'a RelayStart>,
    pub relay_tls: Option<&'a CaTlsConfig>,
}

pub(crate) async fn bind(
    secret_key: Zeroizing<[u8; 32]>,
    plan: BindPlan<'_>,
) -> Result<Endpoint, ()> {
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(&secret_key))
        .transport_config(crate::pipe::bounded_transport().build());
    drop(secret_key);
    let (v4, v6) = ip_families(plan.addresses, plan.relay.is_some());
    let narrow = plan.loopback_only || !(v4 && v6);
    if narrow {
        let (v4_ip, v6_ip): (IpAddr, IpAddr) = if plan.loopback_only {
            (Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into())
        } else {
            (Ipv4Addr::UNSPECIFIED.into(), Ipv6Addr::UNSPECIFIED.into())
        };
        builder = builder.clear_ip_transports();
        // Loopback keeps both families, IPv6 optional, as before.
        if v4 || plan.loopback_only {
            builder = builder
                .bind_addr(SocketAddr::new(v4_ip, 0))
                .map_err(|_| ())?;
        }
        if v6 || plan.loopback_only {
            let required = !(v4 || plan.loopback_only);
            builder = builder
                .bind_addr_with_opts(
                    SocketAddr::new(v6_ip, 0),
                    BindOpts::default().set_is_required(required),
                )
                .map_err(|_| ())?;
        }
    }
    relay::configure(builder, plan.relay, plan.relay_tls)
        .bind()
        .await
        .map_err(|_| ())
}

/// Turns away every incoming connection at once, without a packet back, so nothing a stranger
/// sends to the member's socket is parked in the library's queue. Ends when the endpoint closes.
pub(crate) fn turn_away(endpoint: &Endpoint) -> JoinHandle<()> {
    let endpoint = endpoint.clone();
    tokio::spawn(async move {
        while let Some(incoming) = endpoint.accept().await {
            incoming.ignore();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addresses(list: &[&str]) -> Vec<SocketAddr> {
        list.iter().filter_map(|text| text.parse().ok()).collect()
    }

    #[test]
    fn the_member_binds_only_the_families_it_dials() {
        assert_eq!(
            ip_families(&addresses(&["192.0.2.1:4433"]), false),
            (true, false)
        );
        assert_eq!(
            ip_families(&addresses(&["[2001:db8::1]:4433"]), false),
            (false, true)
        );
        let both = addresses(&["192.0.2.1:4433", "[2001:db8::1]:4433"]);
        assert_eq!(ip_families(&both, false), (true, true));
        let mapped = addresses(&["[::ffff:192.0.2.1]:4433"]);
        assert_eq!(ip_families(&mapped, false), (true, true));
        assert_eq!(ip_families(&[], false), (true, false));
        assert_eq!(
            ip_families(&addresses(&["192.0.2.1:4433"]), true),
            (true, true)
        );
        assert_eq!(ip_families(&[], true), (true, true));
    }
}
