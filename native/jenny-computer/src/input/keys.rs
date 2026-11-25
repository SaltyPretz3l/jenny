//! Key names to Windows virtual keys, and (on Windows) to the hardware scan codes the injector sends.

#[cfg(windows)]
use super::args::Mods;
use super::held::Ev;
#[cfg(windows)]
use crate::protocol::{ErrorCode, ProtoError};

/// Left Ctrl, left Shift and left Alt.
pub const VK_LCONTROL: u16 = 0xA2;
pub const VK_LSHIFT: u16 = 0xA0;
pub const VK_LMENU: u16 = 0xA4;

/// The virtual key of a name in `check::KEYS`.
pub fn virtual_key(name: &str) -> Option<u16> {
    let bytes = name.as_bytes();
    if let [c] = bytes {
        if c.is_ascii_lowercase() {
            return Some(u16::from(c.to_ascii_uppercase()));
        }
        if c.is_ascii_digit() {
            return Some(u16::from(*c));
        }
    }
    if let Some(n) = name.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
        return (1..=12).contains(&n).then_some(0x70 + n - 1);
    }
    Some(match name {
        "enter" => 0x0D,
        "esc" => 0x1B,
        "tab" => 0x09,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" => 0x2E,
        "insert" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "minus" => 0xBD,
        "equals" => 0xBB,
        "comma" => 0xBC,
        "period" => 0xBE,
        "slash" => 0xBF,
        "semicolon" => 0xBA,
        "quote" => 0xDE,
        "backquote" => 0xC0,
        "bracketleft" => 0xDB,
        "bracketright" => 0xDD,
        "backslash" => 0xDC,
        _ => return None,
    })
}

/// Keys on the extended (0xE0) part of the keyboard, whatever the mapping says.
pub fn always_extended(name: &str) -> bool {
    matches!(
        name,
        "up" | "down"
            | "left"
            | "right"
            | "home"
            | "end"
            | "pageup"
            | "pagedown"
            | "insert"
            | "delete"
    )
}

/// One key as the injector sends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyCode {
    pub scan: u16,
    pub extended: bool,
}

impl KeyCode {
    pub fn ev(self, down: bool) -> Ev {
        Ev::Key {
            scan: self.scan,
            extended: self.extended,
            down,
        }
    }
}

/// The scan code of a virtual key on the keyboard layout in use.
#[cfg(windows)]
pub fn code_of_vk(vk: u16, force_extended: bool) -> Result<KeyCode, ProtoError> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MapVirtualKeyW, MAPVK_VK_TO_VSC_EX};
    // SAFETY: a pure query with a documented mapping type; an unmapped key answers 0.
    let raw = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC_EX) };
    let scan = (raw & 0xFF) as u16;
    if scan == 0 {
        return Err(ProtoError::new(
            ErrorCode::Internal,
            "a key has no scan code on this keyboard",
        ));
    }
    Ok(KeyCode {
        scan,
        extended: force_extended || (raw >> 8) & 0xFF == 0xE0,
    })
}

/// The scan code of a key name.
#[cfg(windows)]
pub fn code_of_key(name: &str) -> Result<KeyCode, ProtoError> {
    let vk = virtual_key(name)
        .ok_or_else(|| ProtoError::bad_request("chord names a key that is not on the list"))?;
    code_of_vk(vk, always_extended(name))
}

/// The modifier keys to press, in the order Ctrl, Shift, Alt.
#[cfg(windows)]
pub fn modifier_codes(mods: Mods) -> Result<Vec<KeyCode>, ProtoError> {
    [
        (mods.ctrl, VK_LCONTROL),
        (mods.shift, VK_LSHIFT),
        (mods.alt, VK_LMENU),
    ]
    .into_iter()
    .filter(|(on, _)| *on)
    .map(|(_, vk)| code_of_vk(vk, false))
    .collect()
}

/// Press `codes`, in order.
pub fn presses(codes: &[KeyCode]) -> Vec<Ev> {
    codes.iter().map(|c| c.ev(true)).collect()
}

/// Let go of `codes` in reverse order.
pub fn releases(codes: &[KeyCode]) -> Vec<Ev> {
    codes.iter().rev().map(|c| c.ev(false)).collect()
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
    use crate::input::check::KEYS;

    #[test]
    fn every_chord_key_has_its_own_virtual_key() {
        let mut vks: Vec<u16> = KEYS
            .iter()
            .map(|k| virtual_key(k).unwrap_or_else(|| panic!("{k}")))
            .collect();
        vks.sort_unstable();
        vks.dedup();
        assert_eq!(vks.len(), KEYS.len());
        assert_eq!(virtual_key("a"), Some(0x41));
        assert_eq!(virtual_key("7"), Some(0x37));
        assert_eq!(virtual_key("f12"), Some(0x7B));
        assert_eq!(virtual_key("f13"), None);
        assert_eq!(virtual_key("win"), None);
    }

    #[test]
    fn releases_come_in_reverse_order() {
        let codes = [
            KeyCode {
                scan: 0x1D,
                extended: false,
            },
            KeyCode {
                scan: 0x4B,
                extended: true,
            },
        ];
        assert_eq!(presses(&codes), vec![codes[0].ev(true), codes[1].ev(true)]);
        assert_eq!(
            releases(&codes),
            vec![codes[1].ev(false), codes[0].ev(false)]
        );
    }

    /// `MapVirtualKeyW` only reads the keyboard layout; it sends nothing.
    #[cfg(windows)]
    #[test]
    fn every_chord_key_has_a_scan_code_and_the_arrows_are_extended() {
        for k in KEYS {
            let code = code_of_key(k).unwrap_or_else(|e| panic!("{k}: {e:?}"));
            assert_ne!(code.scan, 0, "{k}");
            assert_eq!(code.extended, always_extended(k), "{k}");
        }
        assert_eq!(code_of_key("left").unwrap().scan, 0x4B);
        let mods = modifier_codes(Mods {
            ctrl: true,
            shift: true,
            alt: true,
        })
        .unwrap();
        assert_eq!(
            mods.iter().map(|c| c.scan).collect::<Vec<_>>(),
            vec![0x1D, 0x2A, 0x38]
        );
    }
}
