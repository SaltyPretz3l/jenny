# jenny-team-bridge

The team transport bridge as a native binary. It speaks iroh (QUIC, peers dialed by
Ed25519 public key) on the network side and a line-JSON control channel on its standard
input and output on the parent side. One binary, two modes:

- `jenny-team-bridge host`: the team host. Accepts member connections, asks the parent
  whether each remote key may talk at all, and turns every accepted stream into one
  loopback TCP connection to the host's HTTP layer that starts with the 72-byte host
  preamble.
- `jenny-team-bridge member`: a member's Jenny. Dials the host once and offers two loopback
  ports; every TCP connection to either must open with the 40-byte member preamble before it
  becomes a stream to the host. A connection to the second port (`bulk_port`) becomes a bulk
  stream: it starts with the class byte `0x01`, which the host takes off, and both sides send
  its data after every ordinary stream's. At most six bulk streams are open at once
  (`src/bulk.rs`).
- `jenny-team-bridge --version` prints `jenny-team-bridge protocol 1`.

On a LAN by default. With internet joining on, the host asks the router to map its direct port
(`src/portmap.rs`) and counts connections that arrive from outside; with the owner's relay in the
`start` line, both modes use that one relay (`src/relay.rs`). Never a default or third-party relay,
and no address lookup. Secrets arrive only in the first
control line (`start`); nothing is written to standard error, and log lines carry event
names, counts and fixed words only. The binary exits when its standard input ends.

The host closes a connection it turns away with a QUIC application code (`src/pipe.rs`): 0 closed,
1 refused by the host application (a `null` admit answer or a `drop`), 3 the bridge's own refused-key
cooldown, 4 no admit answer in time. The member reports them as `closed`, `host_refused`,
`host_cooldown` and `host_admit_timeout`; a member built before codes 3 and 4 reads them as unreachable
or closed. A member accepts no incoming connection: each is dropped at once.

The control channel, lifecycle, limits and exit codes are specified in the team
membership spec (row 123), section "1d-R slice spec (settled 2026-11-10)".
The preamble codec is checked against `tests/fixtures/team-preamble-vectors.json`, which
the JavaScript codec shares.

## Build and test

```
cargo test
cargo build --release
```

The Windows build links the C runtime statically (`.cargo/config.toml`).

Lint and format, part of the gate. They need the `clippy` and `rustfmt` components on
the toolchain that builds the crate (on Windows the MSVC one: `ring`'s build script
needs its C compiler):

```
cargo clippy --all-targets --locked -- -D warnings
cargo fmt --check
```

The in-process tests bind every socket to loopback (`RunOptions::loopback_only`), so they
open no socket on a real interface.
