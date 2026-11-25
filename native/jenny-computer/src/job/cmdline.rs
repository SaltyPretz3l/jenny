//! Command line and environment block for `CreateProcessW`. Pure, so it is tested on any platform.

/// Append one argument quoted by the rules the Microsoft C runtime parses back into the same argument:
/// quotes only when the argument is empty or holds a space, tab, line break or quote; backslashes are
/// doubled only where they precede a quote (or the closing quote).
pub fn push_quoted(out: &mut String, arg: &str) {
    let plain = !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']);
    if plain {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
}

/// The command line: the program first, then each argument, space separated.
pub fn command_line(program: &str, args: &[String]) -> String {
    let mut line = String::new();
    push_quoted(&mut line, program);
    for arg in args {
        line.push(' ');
        push_quoted(&mut line, arg);
    }
    line
}

/// A UTF-16 environment block: `KEY=value` entries each ended by NUL, sorted by key without regard to case
/// as `CreateProcessW` expects, ended by one more NUL. `None` when a key is one `CreateProcessW` would
/// refuse (empty, or holding `=` after its first character), any text holds a NUL, or two keys differ
/// only in case (which one the program would see is up to the program). Case is compared by
/// upper-casing, which can differ from the system's own table for some non-ASCII names.
pub fn env_block(pairs: &[(String, String)]) -> Option<Vec<u16>> {
    let mut sorted: Vec<(Vec<u16>, &(String, String))> = Vec::with_capacity(pairs.len());
    for pair in pairs {
        let (key, value) = pair;
        let key_ok = !key.is_empty() && !key.get(1..).unwrap_or_default().contains('=');
        if !key_ok || key.contains('\0') || value.contains('\0') {
            return None;
        }
        sorted.push((key.to_uppercase().encode_utf16().collect(), pair));
    }
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    if sorted
        .windows(2)
        .any(|pair| matches!(pair, [first, second] if first.0 == second.0))
    {
        return None;
    }
    let mut block: Vec<u16> = Vec::new();
    for (_, (key, value)) in sorted {
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

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;

    fn line(program: &str, args: &[&str]) -> String {
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        command_line(program, &args)
    }

    #[test]
    fn plain_arguments_are_left_alone() {
        assert_eq!(
            line(r"C:\g\game.exe", &["--fast", "a=b", r"C:\x\y"]),
            r"C:\g\game.exe --fast a=b C:\x\y"
        );
    }

    #[test]
    fn spaces_and_empty_arguments_are_quoted() {
        assert_eq!(
            line(r"C:\Program Files\g.exe", &["two words", "", "tab\there"]),
            "\"C:\\Program Files\\g.exe\" \"two words\" \"\" \"tab\there\""
        );
    }

    #[test]
    fn quotes_are_escaped_and_the_backslashes_before_them_doubled() {
        assert_eq!(line("p", &[r#"say "hi""#]), r#"p "say \"hi\"""#);
        assert_eq!(line("p", &[r#"a\"b"#]), r#"p "a\\\"b""#);
        assert_eq!(line("p", &[r#"\\"x"#]), r#"p "\\\\\"x""#);
    }

    #[test]
    fn trailing_backslashes_are_doubled_only_inside_quotes() {
        assert_eq!(line("p", &[r"C:\dir\"]), r"p C:\dir\");
        assert_eq!(line("p", &[r"C:\my dir\"]), r#"p "C:\my dir\\""#);
        assert_eq!(line("p", &[r"\\"]), r"p \\");
        assert_eq!(line("p", &["a b\\\\"]), "p \"a b\\\\\\\\\"");
    }

    #[test]
    fn the_environment_block_is_sorted_without_case_and_double_nul_ended() {
        let pairs = vec![
            ("zeta".to_owned(), "1".to_owned()),
            ("Alpha".to_owned(), "two".to_owned()),
            ("beta".to_owned(), "".to_owned()),
            ("ALPHA2".to_owned(), "x=y".to_owned()),
        ];
        let block = env_block(&pairs).unwrap();
        let text = String::from_utf16(&block).unwrap();
        assert_eq!(text, "Alpha=two\0ALPHA2=x=y\0beta=\0zeta=1\0\0");
    }

    #[test]
    fn an_empty_environment_is_two_nuls() {
        assert_eq!(env_block(&[]).unwrap(), vec![0, 0]);
    }

    #[test]
    fn keys_the_system_would_refuse_are_refused() {
        let one = |k: &str, v: &str| env_block(&[(k.to_owned(), v.to_owned())]);
        assert!(one("", "v").is_none());
        assert!(one("A=B", "v").is_none());
        assert!(one("A\0B", "v").is_none());
        assert!(one("A", "v\0w").is_none());
        // A leading `=` is legal: it is how a per-drive working directory is stored.
        assert!(one("=C:", r"C:\x").is_some());
    }

    #[test]
    fn names_that_differ_only_in_case_are_refused() {
        let pair = |k: &str, v: &str| (k.to_owned(), v.to_owned());
        assert!(env_block(&[pair("Path", "a"), pair("PATH", "b")]).is_none());
        assert!(env_block(&[pair("zeta", "1"), pair("path", "a"), pair("Path", "b")]).is_none());
        // Distinct names (and the same name in two different spellings of a prefix) still pass.
        assert!(env_block(&[pair("Path", "a"), pair("PATHEXT", "b")]).is_some());
    }

    #[test]
    fn non_ascii_text_is_encoded_as_utf16() {
        let block = env_block(&[("Pfad".to_owned(), "gr\u{fc}n \u{1f600}".to_owned())]).unwrap();
        assert_eq!(
            String::from_utf16(&block).unwrap(),
            "Pfad=gr\u{fc}n \u{1f600}\0\0"
        );
    }
}
