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

use objc2_app_kit::{NSWindow, NSWindowButton};
use objc2_foundation::MainThreadMarker;

/// The tab row's center line, in points from the window's top edge. Mirrors
/// TITLE_BAR_H / 2 in src/App.tsx (`h-11` → 44 / 2). Keep the two in sync.
const TAB_ROW_CENTER_Y: f64 = 22.0;

/// Sub-pixel slop: below this the buttons are already where we want them, so
/// leave the frames alone rather than churn layout on every resize tick.
const EPSILON: f64 = 0.5;

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

    for button in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let Some(button) = window.standardWindowButton(button) else {
            continue;
        };

        // Where the button's center sits now, in the window's base coordinates
        // (y grows upward from the window's bottom edge). Converting via the
        // window rather than reading the raw frame keeps us honest about
        // whatever view AppKit has parented the buttons into.
        let in_window = unsafe { button.convertRect_toView(button.bounds(), None) };
        let center_y = in_window.origin.y + in_window.size.height / 2.0;
        let wanted_center_y = window_height - TAB_ROW_CENTER_Y;

        let delta = wanted_center_y - center_y;
        if delta.abs() < EPSILON {
            continue;
        }

        // Origin only — the size is AppKit's business, and x keeps macOS's
        // stock inset and spacing.
        let mut origin = button.frame().origin;
        origin.y += delta;
        unsafe { button.setFrameOrigin(origin) };
    }
}
