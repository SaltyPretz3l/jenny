//! Window geometry: window rectangle, drawn bounds, client area and the offset between the last two.
//! Built by lane H1 (row 197).

use serde_json::{json, Value};

use crate::protocol::{ProtoError, Request};

#[cfg(windows)]
pub(crate) mod win;

pub const BUILT: bool = true;

/// A rectangle in physical screen pixels. `x` and `y` can be negative on a monitor left of or above
/// the primary one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    /// From the four edges, as `RECT` gives them.
    pub fn from_edges(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            x: left,
            y: top,
            width: right.saturating_sub(left),
            height: bottom.saturating_sub(top),
        }
    }

    pub fn right(&self) -> i32 {
        self.x.saturating_add(self.width)
    }

    pub fn bottom(&self) -> i32 {
        self.y.saturating_add(self.height)
    }

    pub fn to_json(self) -> Value {
        json!({"x": self.x, "y": self.y, "width": self.width, "height": self.height})
    }
}

/// How far each edge of a client area lies inside the drawn bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Offset {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Offset {
    pub fn to_json(self) -> Value {
        json!({"left": self.left, "top": self.top, "right": self.right, "bottom": self.bottom})
    }
}

/// The offset of `client` inside `bounds`, both in screen coordinates. Negative where the client area
/// reaches outside the bounds.
pub fn offset(bounds: Rect, client: Rect) -> Offset {
    Offset {
        left: client.x.saturating_sub(bounds.x),
        top: client.y.saturating_sub(bounds.y),
        right: bounds.right().saturating_sub(client.right()),
        bottom: bounds.bottom().saturating_sub(client.bottom()),
    }
}

/// `window.geometry`.
pub fn geometry(req: &Request) -> Result<Value, ProtoError> {
    #[cfg(windows)]
    {
        win::geometry(req.hwnd_arg()?)
    }
    #[cfg(not(windows))]
    {
        let _ = req;
        Err(ProtoError::not_available())
    }
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

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn the_offset_is_how_far_the_client_lies_inside_the_bounds() {
        let o = offset(rect(100, 50, 816, 639), rect(101, 81, 814, 608));
        assert_eq!(
            o,
            Offset {
                left: 1,
                top: 31,
                right: 1,
                bottom: 0
            }
        );
    }

    #[test]
    fn the_offset_is_right_for_a_second_monitor_left_of_the_first() {
        let o = offset(rect(-1920, -200, 800, 600), rect(-1919, -169, 798, 568));
        assert_eq!(
            o,
            Offset {
                left: 1,
                top: 31,
                right: 1,
                bottom: 1
            }
        );
        // A window that straddles zero on both axes.
        let o = offset(rect(-400, -300, 800, 600), rect(-399, -269, 798, 568));
        assert_eq!(
            o,
            Offset {
                left: 1,
                top: 31,
                right: 1,
                bottom: 1
            }
        );
    }

    #[test]
    fn a_client_area_outside_the_bounds_gives_negative_offsets() {
        let o = offset(rect(0, 0, 100, 100), rect(-5, 0, 110, 100));
        assert_eq!((o.left, o.right), (-5, -5));
    }

    #[test]
    fn rects_are_built_from_edges_and_encoded_as_documented() {
        let r = Rect::from_edges(-10, -20, 30, 40);
        assert_eq!(r, rect(-10, -20, 40, 60));
        assert_eq!(r.right(), 30);
        assert_eq!(r.bottom(), 40);
        assert_eq!(
            r.to_json(),
            json!({"x": -10, "y": -20, "width": 40, "height": 60})
        );
        assert_eq!(
            offset(r, r).to_json(),
            json!({"left": 0, "top": 0, "right": 0, "bottom": 0})
        );
    }
}
