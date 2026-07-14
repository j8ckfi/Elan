//! Drop the macOS window controls onto the tab row's center line.
//!
//! macOS parks the traffic lights near the top of the title bar, sized for a
//! ~28pt one. Elan's tab row is taller (App.tsx's TITLE_BAR_H), so the stock
//! lights float above the tabs and the sidebar toggle instead of sharing their
//! center line.
//!
//! We nudge each button DOWN by rewriting its frame ORIGIN only — never its
//! size, and never the title-bar container's frame. That restraint is the
//! whole point: tauri.conf's `trafficLightPosition` (tao's inset, which also
//! resizes the container view) aligned them but rendered the buttons visibly
//! wrong, so this does the minimum that can't distort them.
//!
//! AppKit re-lays the title bar out whenever the window resizes, which undoes
//! the nudge — so this is idempotent (it re-measures every time and no-ops
//! when already in place) and runs again from the window's Resized event.

use std::ffi::c_void;
use std::sync::OnceLock;

use objc2_app_kit::{NSWindow, NSWindowButton};
use objc2_foundation::MainThreadMarker;

/// Where the lights' centers sit, in points from the window's top edge.
///
/// The tab row's own center is TITLE_BAR_H / 2 in src/App.tsx (`h-11` → 22),
/// but the buttons' frames carry a little dead padding under the visible
/// circle, so centering the *frame* there lands the *circle* a couple of
/// points low. This is that target minus the correction — it's the one number
/// to nudge if the lights don't sit dead-on the sidebar toggle.
const TRAFFIC_CENTER_Y: f64 = 20.0;

/// Points to shift the group right of macOS's stock left inset. Paired with
/// `trafficInset()` in src/App.tsx, which reserves the room to their right —
/// raise that by the same amount if the toggle ends up crowding them.
const X_NUDGE: f64 = 5.0;

/// Sub-pixel slop: below this the buttons are already where we want them, so
/// leave the frames alone rather than churn layout on every resize tick.
const EPSILON: f64 = 0.5;

/// The close button's factory x inset, captured before the first nudge.
///
/// Load-bearing: the horizontal target has to be absolute. Reading the live x
/// back and adding `X_NUDGE` would compound on every resize and march the
/// lights off the window. (Single-window app, so one global is enough.)
static STOCK_X: OnceLock<f64> = OnceLock::new();

/// Align the three window controls to the tab row. Safe no-op off the main
/// thread, on a null handle, or when the buttons are already in place.
pub fn align_to_tab_row(ns_window: *mut c_void) {
    // AppKit view mutation is main-thread only (Tauri's setup and window
    // events both run there).
    if MainThreadMarker::new().is_none() || ns_window.is_null() {
        return;
    }
    // SAFETY: Tauri hands back the window's live NSWindow for the lifetime of
    // the window, and we've just confirmed we're on the main thread.
    let window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };

    // `frame` is the whole window (title bar included), so measuring down from
    // its top edge is the same origin the CSS tab row measures from.
    let window_height = window.frame().size.height;

    let buttons: Vec<_> = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .filter_map(|b| window.standardWindowButton(b))
    .collect();
    if buttons.len() != 3 {
        return;
    }

    // Gap between the buttons, measured live. A uniform shift leaves it
    // unchanged, so this reads the same before and after a nudge — unlike the
    // inset itself, which is why that one is captured once (see STOCK_X).
    let spacing = buttons[1].frame().origin.x - buttons[0].frame().origin.x;
    let first_x = *STOCK_X.get_or_init(|| buttons[0].frame().origin.x) + X_NUDGE;

    for (i, button) in buttons.iter().enumerate() {
        // Where the button's center sits now, in the window's base coordinates
        // (y grows upward from the window's bottom edge). Converting via the
        // window rather than reading the raw frame keeps us honest about
        // whatever view AppKit has parented the buttons into.
        let in_window = button.convertRect_toView(button.bounds(), None);
        let center_y = in_window.origin.y + in_window.size.height / 2.0;
        let dy = (window_height - TRAFFIC_CENTER_Y) - center_y;

        let mut origin = button.frame().origin;
        let x = first_x + i as f64 * spacing;
        if dy.abs() < EPSILON && (origin.x - x).abs() < EPSILON {
            continue;
        }

        // Origin only — the size stays AppKit's business, which is what keeps
        // the buttons from rendering wrong the way the conf-level inset did.
        origin.y += dy;
        origin.x = x;
        button.setFrameOrigin(origin);
    }
}
