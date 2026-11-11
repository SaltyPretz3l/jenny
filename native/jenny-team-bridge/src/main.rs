//! `jenny-team-bridge host | member | --version`. Standard input and output carry the
//! control channel; nothing is written to standard error.

use std::time::Duration;

use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

enum Mode {
    Host,
    Member,
}

/// The one task that writes standard output: one line per message, flushed each time.
async fn write_lines(mut lines: mpsc::Receiver<String>) {
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.recv().await {
        let written = async {
            stdout.write_all(line.as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await
        };
        if written.await.is_err() {
            // The parent is gone; keep draining so senders never block.
            while lines.recv().await.is_some() {}
            return;
        }
    }
}

fn main() {
    let args: Vec<Option<String>> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.into_string().ok())
        .collect();
    let mode = match args.as_slice() {
        [Some(only)] if only == "--version" => {
            println!("{}", jenny_team_bridge::VERSION_LINE);
            std::process::exit(0);
        }
        [Some(only)] if only == "host" => Mode::Host,
        [Some(only)] if only == "member" => Mode::Member,
        _ => std::process::exit(2),
    };
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    else {
        std::process::exit(2);
    };
    let code = runtime.block_on(async move {
        let (tx, rx) = mpsc::channel(256);
        let writer = tokio::spawn(write_lines(rx));
        let input = BufReader::new(tokio::io::stdin());
        let code = match mode {
            Mode::Host => jenny_team_bridge::run_host(input, tx).await,
            Mode::Member => jenny_team_bridge::run_member(input, tx).await,
        };
        // Every sender is gone once the run returns; the writer drains and ends.
        let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
        code
    });
    // Exit without dropping the runtime: the blocking standard-input reader never returns.
    std::process::exit(code);
}
