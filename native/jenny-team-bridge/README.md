# jenny-team-bridge

The team transport bridge as a native binary. It speaks iroh (QUIC, peers dialed by
Ed25519 public key) on the network side and a line-JSON control channel on its standard
input and output on the parent side. One binary, two modes:

- `jenny-team-bridge host`: the team host. Accepts member connections, asks the parent
  whether each remote key may talk at all, and turns every accepted stream into one
  loopback TCP connection to the host's HTTP layer that starts with the 72-byte host
  preamble.
- `jenny-team-bridge member`: a member's Jenny. Dials the host once and offers a loopback
  port; every TCP connection to it must open with the 40-byte member preamble before it
  becomes a stream to the host.
- `jenny-team-bridge --version` prints `jenny-team-bridge protocol 1`.

LAN only: no relays, no address lookup, no port mapping. Secrets arrive only in the first
control line (`start`); nothing is written to standard error, and log lines carry event
names, counts and fixed words only. The binary exits when its standard input ends.

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

Lint on this PC (clippy exists only on the gnu toolchain, and `ring`'s build script needs
a C compiler that only the MSVC setup provides, so the gnu clippy checks the MSVC target
against the MSVC standard library):

```
RUSTFLAGS="--sysroot <msvc toolchain dir>" cargo +stable-x86_64-pc-windows-gnu clippy \
  --all-targets --target x86_64-pc-windows-msvc --target-dir <scratch dir> -- -D warnings
```

`cargo fmt --check` is part of the gate; rustfmt is not installed on this PC yet.

The in-process tests bind every socket to loopback (`RunOptions::loopback_only`), so they
open no socket on a real interface.
