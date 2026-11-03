//! Cast-to-device Tauri commands (DLNA / UPnP AVTransport).
//!
//! Stateless on the Rust side: the webview hands the `CastRenderer` it got from
//! `list_renderers` back on every call. Local playback is not touched; the
//! frontend decides when a session is a cast session.

pub(crate) mod dlna;

use std::sync::OnceLock;
use std::time::Duration;

use dlna::{CastError, CastRenderer, CastStatus, CastTrack};

const DISCOVER_DEFAULT_MS: u32 = 3_000;
const DISCOVER_MAX_MS: u32 = 10_000;

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("psysonic-cast/0.1")
            .connect_timeout(Duration::from_secs(4))
            // Renderers are LAN devices; never follow a redirect off the local network.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    })
}

fn err(e: CastError) -> String {
    e.to_string()
}

/// Find UPnP MediaRenderers on the local network (SSDP). One entry per device.
#[tauri::command]
#[specta::specta]
pub(crate) async fn list_renderers(timeout_ms: Option<u32>) -> Result<Vec<CastRenderer>, String> {
    let ms = timeout_ms.unwrap_or(DISCOVER_DEFAULT_MS).clamp(500, DISCOVER_MAX_MS);
    Ok(dlna::discover(client(), Duration::from_millis(u64::from(ms))).await)
}

/// Start `track` on the renderer, optionally resuming at `start_seconds`. With no
/// `track` this resumes whatever is loaded (a plain AVTransport `Play`).
#[tauri::command]
#[specta::specta]
pub(crate) async fn cast_play(
    renderer: CastRenderer,
    track: Option<CastTrack>,
    start_seconds: Option<f64>,
) -> Result<(), String> {
    match track {
        Some(t) => dlna::play_track(client(), &renderer, &t, start_seconds).await,
        None => dlna::play(client(), &renderer).await,
    }
    .map_err(err)
}

/// Queue the next track so a renderer that supports it can advance gaplessly.
/// Errors when the renderer rejects `SetNextAVTransportURI`; callers then fall back
/// to advancing themselves when the current track ends.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cast_set_next(renderer: CastRenderer, track: CastTrack) -> Result<(), String> {
    dlna::set_next_transport_uri(client(), &renderer, &track).await.map_err(err)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cast_pause(renderer: CastRenderer) -> Result<(), String> {
    dlna::pause(client(), &renderer).await.map_err(err)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cast_stop(renderer: CastRenderer) -> Result<(), String> {
    dlna::stop(client(), &renderer).await.map_err(err)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn cast_seek(renderer: CastRenderer, seconds: f64) -> Result<(), String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("seek position must be a non-negative number".into());
    }
    dlna::seek(client(), &renderer, seconds).await.map_err(err)
}

/// Volume 0-100 on the renderer's `Master` channel.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cast_set_volume(renderer: CastRenderer, volume: u32) -> Result<(), String> {
    dlna::set_volume(client(), &renderer, volume).await.map_err(err)
}

/// Transport state, position, duration and volume. Meant to be polled about once a second.
#[tauri::command]
#[specta::specta]
pub(crate) async fn cast_status(renderer: CastRenderer) -> Result<CastStatus, String> {
    dlna::status(client(), &renderer).await.map_err(err)
}
