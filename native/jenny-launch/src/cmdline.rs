//! Command line and environment block construction for `CreateProcessW`.
//!
//! Pure and platform independent. Ported from CPython 3.11
//! `subprocess.list2cmdline` and from `_windows_target_launch_args` in
//! `sidecar/_owned_process_bootstrap.py`.

/// Quote one argument vector exactly as CPython's `subprocess.list2cmdline`
/// does, including its habit of doubling trailing backslashes in a quoted
/// argument.
pub fn list2cmdline<S: AsRef<str>>(args: &[S]) -> String {
    let mut result = String::new();
    for (index, arg) in args.iter().enumerate() {
        let arg = arg.as_ref();
        if index > 0 {
            result.push(' ');
        }
        let need_quote = arg.contains(' ') || arg.contains('\t') || arg.is_empty();
        if need_quote {
            result.push('"');
        }
        let mut backslashes = 0usize;
        for c in arg.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    push_backslashes(&mut result, backslashes * 2);
                    backslashes = 0;
                    result.push_str("\\\"");
                }
                _ => {
                    push_backslashes(&mut result, backslashes);
                    backslashes = 0;
                    result.push(c);
                }
            }
        }
        push_backslashes(&mut result, backslashes);
        if need_quote {
            // CPython appends the pending backslashes a second time here.
            push_backslashes(&mut result, backslashes);
            result.push('"');
        }
    }
    result
}

fn push_backslashes(out: &mut String, count: usize) {
    out.extend(std::iter::repeat_n('\\', count));
}

/// The command line handed to `CreateProcessW`: `list2cmdline`, except for
/// `cmd /d /s /c <string>`, whose command string is passed through verbatim
/// inside one pair of quotes, as the Python child does.
pub fn target_command_line<S: AsRef<str>>(argv: &[S]) -> String {
    if let [program, d, s, c, command] = argv {
        let program_name = program
            .as_ref()
            .replace('\\', "/")
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_lowercase();
        let switches = [d, s, c].map(|flag| flag.as_ref().to_lowercase());
        if (program_name == "cmd" || program_name == "cmd.exe")
            && switches.iter().map(String::as_str).eq(["/d", "/s", "/c"])
        {
            let head = list2cmdline(&[program.as_ref(), d.as_ref(), s.as_ref(), c.as_ref()]);
            return format!("{head} \"{}\"", command.as_ref());
        }
    }
    list2cmdline(argv)
}

/// Build a Unicode environment block: `KEY=value` entries separated by NUL,
/// ending with an extra NUL. Pair order is kept. Returns `None` for a key
/// `CreateProcess` would refuse: empty, or with `=` anywhere after the first
/// character (a leading `=` is legal, for entries such as `=C:`).
pub fn env_block(pairs: &[(String, String)]) -> Option<Vec<u16>> {
    let mut block: Vec<u16> = Vec::new();
    for (key, value) in pairs {
        if key.is_empty() || key.chars().skip(1).any(|c| c == '=') {
            return None;
        }
        block.extend(key.encode_utf16());
        block.push(u16::from(b'='));
        block.extend(value.encode_utf16());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Some(block)
}
