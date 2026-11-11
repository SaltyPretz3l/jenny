#![deny(unsafe_op_in_unsafe_fn)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

fn main() {
    std::process::exit(jenny_launch::run_cli(std::env::args_os()));
}
