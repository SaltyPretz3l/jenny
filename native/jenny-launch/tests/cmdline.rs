//! Command line and environment block construction. The vectors in
//! `cmdline_vectors/mod.rs` were produced by running CPython's
//! `subprocess.list2cmdline`.

mod cmdline_vectors;

use jenny_launch::cmdline::{env_block, list2cmdline, target_command_line};

#[test]
fn list2cmdline_matches_python_vectors() {
    assert!(cmdline_vectors::VECTORS.len() >= 25);
    for (argv, expected) in cmdline_vectors::VECTORS {
        assert_eq!(&list2cmdline(argv), expected, "argv {argv:?}");
    }
}

#[test]
fn list2cmdline_of_nothing_is_empty() {
    let none: [&str; 0] = [];
    assert_eq!(list2cmdline(&none), "");
}

#[test]
fn target_command_line_is_list2cmdline_for_ordinary_argv() {
    for (argv, expected) in cmdline_vectors::VECTORS {
        if argv.len() == 5 {
            continue;
        }
        assert_eq!(&target_command_line(argv), expected, "argv {argv:?}");
    }
}

#[test]
fn cmd_special_case_keeps_the_command_string_verbatim() {
    let argv = ["cmd.exe", "/d", "/s", "/c", "echo \"hi\" & dir \"a b\\\""];
    assert_eq!(
        target_command_line(&argv),
        "cmd.exe /d /s /c \"echo \"hi\" & dir \"a b\\\"\""
    );
    // The same argv through plain list2cmdline would have been rewritten.
    assert_ne!(target_command_line(&argv), list2cmdline(&argv));
}

#[test]
fn cmd_special_case_matches_the_python_child_for_many_spellings() {
    let cases: [(&str, &str, &str, &str); 6] = [
        ("cmd", "/d", "/s", "/c"),
        ("CMD.EXE", "/D", "/S", "/C"),
        ("C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c"),
        ("C:/Windows/System32/Cmd.Exe", "/d", "/S", "/c"),
        ("C:\\Program Files\\x\\cmd", "/d", "/s", "/c"),
        ("c:\\a b/cmd.exe", "/D", "/s", "/C"),
    ];
    for (program, d, s, c) in cases {
        let argv = [program, d, s, c, "dir \"x y\""];
        let expected = format!("{} \"dir \"x y\"\"", list2cmdline(&argv[..4]));
        assert_eq!(target_command_line(&argv), expected, "{program}");
    }
    // Quoting of a program path with spaces comes from list2cmdline.
    let argv = ["C:\\Program Files\\x\\cmd", "/d", "/s", "/c", "echo"];
    assert_eq!(
        target_command_line(&argv),
        "\"C:\\Program Files\\x\\cmd\" /d /s /c \"echo\""
    );
}

#[test]
fn near_misses_do_not_take_the_cmd_special_case() {
    let near_misses: [&[&str]; 8] = [
        &["cmd.exe", "/d", "/s", "/c"],
        &["cmd.exe", "/d", "/s", "/c", "echo hi", "extra"],
        &["cmd.exe", "/d", "/s", "/k", "echo hi"],
        &["cmd.exe", "/s", "/d", "/c", "echo hi"],
        &["cmdx.exe", "/d", "/s", "/c", "echo hi"],
        &["C:\\cmd.exe\\prog", "/d", "/s", "/c", "echo hi"],
        &["xcmd", "/d", "/s", "/c", "echo hi"],
        &["cmd.exe", "d", "/s", "/c", "echo hi"],
    ];
    for argv in near_misses {
        assert_eq!(target_command_line(argv), list2cmdline(argv), "{argv:?}");
    }
    // One of them is observably different from the special case.
    let argv = ["cmd.exe", "/d", "/s", "/k", "echo hi"];
    assert_eq!(target_command_line(&argv), "cmd.exe /d /s /k \"echo hi\"");
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

#[test]
fn env_block_is_nul_separated_in_order_and_double_nul_terminated() {
    let block = env_block(&pairs(&[("B", "2"), ("A", "1")])).unwrap();
    assert_eq!(block, units("B=2\0A=1\0\0"));
}

#[test]
fn env_block_of_nothing_is_two_nuls() {
    assert_eq!(env_block(&[]).unwrap(), vec![0u16, 0u16]);
}

#[test]
fn env_block_allows_a_leading_equals_and_empty_values() {
    let block = env_block(&pairs(&[("=C:", "C:\\x"), ("E", "")])).unwrap();
    assert_eq!(block, units("=C:=C:\\x\0E=\0\0"));
}

#[test]
fn env_block_encodes_non_bmp_as_utf16() {
    let block = env_block(&pairs(&[("K", "\u{1F600}")])).unwrap();
    assert_eq!(block, units("K=\u{1F600}\0\0"));
}

#[test]
fn env_block_refuses_empty_keys_and_equals_after_the_first_position() {
    assert_eq!(env_block(&pairs(&[("", "x")])), None);
    assert_eq!(env_block(&pairs(&[("A=B", "x")])), None);
    assert_eq!(env_block(&pairs(&[("A=", "x")])), None);
    assert_eq!(env_block(&pairs(&[("==", "x")])), None);
    assert_eq!(env_block(&pairs(&[("OK", "1"), ("A=B", "x")])), None);
    // "=" alone is a key starting with "=": allowed, like the Python child.
    assert!(env_block(&pairs(&[("=", "x")])).is_some());
}
