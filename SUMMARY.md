# DLNA casting: progress summary

Branch: `feature/dlna-cast` (fork of Psysonic, not pushed, no PR opened).

## Status

Steps 1-4 are done and the spike works on your Eversolo. Step 5 (Rust + React integration) is implemented and
passes the automated checks, but it has **not been run in the real app against the Eversolo** (see "Step 5: what to
test").

## What changed

- `spike/dlna/dlna_spike.py`: standalone, stdlib-only Python tool (SSDP discovery, device description parsing,
  AVTransport/RenderingControl SOAP, DIDL-Lite with XML escaping).
- `spike/dlna/README.md`: usage and the exact commands to run.
- `README.md`: added a note that this is a fork based on Psysonic.
- Step 5, backend: `src-tauri/src/cast/` (`dlna.rs` + `mod.rs`) and eight Tauri commands: `list_renderers`,
  `cast_play`, `cast_set_next`, `cast_pause`, `cast_stop`, `cast_seek`, `cast_set_volume`, `cast_status`
  (additive; `src/generated/bindings.ts` regenerated, diff is 67 added lines, nothing existing changed). Adds
  `socket2` (already in the lockfile) and tokio's `net` feature.
- Step 5, frontend: `src/features/cast/` (store, `CastButton` device picker), `src/lib/api/cast.ts` (typed facade),
  `src/app/castSession.ts` (session controller), `src/store/castGate.ts`, `src/locales/en/cast.ts`,
  `src/styles/components/cast.css`. `CastButton` added to `PlayerBar` and the three fullscreen players.
- Existing code touched: `playTrackAction.ts` (one line: `audio_play` now goes through `castGate`), `MainApp.tsx`
  (imports the controller), `PlayerBar.tsx` and the fullscreen players (one button each), `locales/en/index.ts`,
  `styles/components/index.css`, `lib.rs` (module + command registration), `Cargo.toml/lock`, `README.md`.
- No changes to telemetry, privacy or license files.

Verified here only against a local mock renderer (discover, play with an `&`/`<`/`>` title, status, volume, UPnP fault
handling). It has **not** been run against real hardware.

## Existing discussion

- [Psysonic/psysonic#1715](https://github.com/Psysonic/psysonic/issues/1715) (open, "Chromecast Support"): a maintainer
  replied that there is no official Chromecast route for licensing reasons and that **DLNA is on the roadmap**.
- No dedicated DLNA/UPnP issue exists, and no other casting issues turned up. I did not wait on a maintainer reply.

## Build baseline (unmodified fork)

- Toolchain installed this session: GitHub CLI 2.103.3, Rust 1.99.1 (meets 1.98+), Node 24.15, Python 3.14.
- `npm install`: succeeded.
- `cargo build` (debug) of the unmodified fork: **succeeds** once CMake 4.4.4 is installed and `CMAKE` points at it
  (`C:\Program Files\CMake\bin\cmake.exe`). A plain `cargo build` in a fresh shell still failed with "cmake program
  not found" even though `cmake` was on PATH; setting `CMAKE` explicitly fixed it. Cause not diagnosed.
- Note: `cargo build -p <single crate>` fails on missing `specta` features (feature unification); build the whole
  workspace instead.
- `npm run tauri:dev` / `tauri:build` has not been run.
- Baseline tests (no changes of mine in the tree):
  - `npx vitest run`: 6532 passed, 1 failed (`Login.test.tsx` timed out at 5s while `cargo test` ran in parallel;
    passes alone, 4/4).
  - `cargo test --workspace --all-targets --no-fail-fast`: everything passes except **6 failures in
    `psysonic-library` `repos::play_session`** (`insert_completion` x4, `summaries` x2). One shows
    `left: "2020-12-31"` vs `right: "2021-01-01"`, which looks like a local-timezone vs UTC day-boundary
    assumption. Pre-existing on this machine, unrelated to casting.

## Spike findings so far (real network, read-only)

Run from this PC (192.168.1.164) after fixing discovery:

- The first `discover` found nothing: it sent one `MediaRenderer` M-SEARCH from the default adapter only. The spike now
  sends from every local IPv4 address and tries several search targets (`MediaRenderer:1`, `upnp:rootdevice`,
  `ssdp:all`, `AVTransport:1`); that found the device.
- The Eversolo is at `192.168.1.247`, friendly name **`PLAY`**, manufacturer string "EVERSOLO", model "AV Renderer
  Device", server header `UPnP/1.0 DLNADOC/1.50 Platinum/1.0.5.13`. It has AVTransport and RenderingControl.
- **Its description/control port changes between runs** (seen 1748 and 1670, same UDN). Do not cache the URL; the app
  must rediscover via SSDP (or re-resolve) and handle a stale port.
- Read-only calls work: `GetTransportInfo` -> `STOPPED/OK`, `GetPositionInfo`, `GetMediaInfo` (`NextURI` field
  present, empty), `GetVolume` -> 67, `GetMute` -> 0. Volume uses the `Master` channel.
- **Playback works end to end** using a generated 30 s 440 Hz WAV served from this PC with range support
  (`audio/wav`, 16-bit stereo 44.1 kHz): `SetAVTransportURI` (with DIDL-Lite) + `Play`, `Pause`, `Play` (resume),
  `Seek` (`REL_TIME`, also while paused), `Stop` all succeed, the tone was audible, and `SetNextAVTransportURI`
  is accepted and stored (`NextURI` readable via `GetMediaInfo`), so gapless queue advance looks feasible.
  Not tested: `SetVolume` (only `GetVolume`, which returned 67, then 34 after volume was changed elsewhere),
  MP3/FLAC, a Subsonic `rest/stream` URL, and what happens at natural end of track with a next URI queued.
- **Two endpoints, same device.** The Eversolo answers on two description ports at once (seen as 1670 and 1748,
  same UDN, same service paths). They do **not** behave the same:
  - Sending commands to either one starts audio, but only **port 1670** reported coherent state in testing:
    `PLAYING` -> `PAUSED_PLAYBACK` -> seek (position updates) -> `PLAYING` -> `STOPPED`, with correct `RelTime` and
    `TrackDuration`.
  - **Port 1748** kept reporting a stale previous session (`STOPPED`/`TRANSITIONING`, old track, `RelTime 1:20`,
    `Duration 3:50`) while 1670 was playing.
  - SSDP reply order varies between runs, so a client that takes the "first" endpoint gets flaky status. The first
    spike version did exactly that (state flipped between live and stale). The spike now sorts endpoints and uses
    1670-first-by-sort; use `--location` to pin one.
  - Unknown whether the port numbers are stable across reboots/firmware and which endpoint is meant for which
    purpose. A previous Feishin session appears to have used 1748. See open questions.
- State quirks to handle in the app: during `TRANSITIONING` (just after `Play`/`SetAVTransportURI`) position and
  duration can be stale from the previous track; treat position as valid only in `PLAYING`/`PAUSED_PLAYBACK`.
  At natural end of track the device briefly reported `NO_MEDIA_PRESENT` (position == duration) before `STOPPED`,
  which is usable as an end-of-track signal.
- Metadata observed from another client (Feishin) on the device: it sends `res protocolInfo="http-get:*:audio/mpeg:*"`
  and Subsonic `rest/stream.view` URLs with `u/s/t` query auth, and the Eversolo fetched them fine, so embedding
  Subsonic auth in the URL works. (The URLs contain a token; not reproduced here.)
- The network also has Sonos (Ray, Sub Mini, 2x Era 100), a Yamaha RX-A4A and an NVIDIA SHIELD. The spike lists them
  but only the Eversolo was queried.

## How to run the spike

See `spike/dlna/README.md`. Short version, from the repo root on a machine on the Eversolo's LAN:

```bash
python spike/dlna/dlna_spike.py -v discover
python spike/dlna/dlna_spike.py -v play "<STREAM_URL>" "Test Title" --artist "Test Artist"
python spike/dlna/dlna_spike.py status
```

## What I still need you to test on the Eversolo

Done already: discovery, WAV `play`, `seek`, `pause`, `resume`, `stop`, `get-volume`, and `next` acceptance (above).

1. `play` a real **MP3** and a **FLAC** (Subsonic `rest/stream` URL or any LAN URL; use `--mime audio/flac` for FLAC).
   Any error, silence or wrong duration?
2. `set-volume 20` then `get-volume` (not yet tried).
3. Natural end of track with `next` queued: does it advance gaplessly to the next URI, and what state sequence do you
   see? (Poll `status` once a second across the boundary.)
4. Reboot the Eversolo and re-run `discover`: are the two description ports (1670/1748) stable, or do they change?
5. Does one endpoint show up in the Eversolo's own UI as the active player when casting? Which one should the app use?

## Step 5: how it works

- **Rust is stateless.** `list_renderers` does SSDP from every local IPv4 interface (a single default-interface
  search found nothing on this multi-adapter PC) and returns `CastRenderer` structs; the webview passes one back on
  every command. Renderer control URLs must be http on a private/loopback/link-local IP, so a compromised webview
  cannot use the commands as a generic HTTP client.
- **The player stays the source of truth for queue and track.** `castSession.ts` wraps the player store's
  `togglePlay/pause/resume/stop/seek/setVolume/playTrack` while a session is active, so the player bar, fullscreen
  players, mini player, media keys and shortcuts all drive the renderer with no per-component changes. Advancing
  still goes through the real `next()` (shuffle, repeat and infinite queue untouched), which ends in `playTrack`,
  which the controller turns into a renderer load.
- **Local engine stays silent.** `castGate` makes `playTrackAction` skip its `audio_play` while casting; starting a
  session pauses the engine first.
- **Polling:** `cast_status` once per second mirrors position, play state and volume into the player store and the
  high-frequency progress channel. A track finishing is detected when the renderer leaves PLAYING for
  STOPPED/NO_MEDIA_PRESENT within 4 s of the track's end, and not when the app itself paused or stopped it.
  Six failed polls in a row end the session.
- **Stream URL:** the plain server `stream.view` URL (never a `psysonic-local://` or cache URL), MIME from the track
  suffix. Cover art URL is sent as `albumArtURI`.

## Step 5: what to test

Automated: Rust unit tests (19, builders/parsers/escaping/LAN guard), frontend tests (18: controller, end-of-track
detection, picker). **Not done:** launching the app and casting to the Eversolo. Please try:

1. `npm run tauri:dev`, play something, click the cast icon, pick `PLAY`. Does the current track continue on the
   Eversolo at the same position, and does the PC go silent?
2. Pause/resume, seek on the seekbar, volume slider, next/previous, clicking another track in a list.
3. Let a track finish: does the next queue track start on the Eversolo? (This is the app-driven path.)
4. Stop casting from the menu; then press play: does local playback resume sensibly? (Not verified; the engine may
   need a cold reload of the current track.)
5. Does the Eversolo pick the wrong one of its two endpoints? (`list_renderers` keeps the first location in sorted
   order, as the spike does.)

## Known limitations (to document in the app)

- Gapless via `SetNextAVTransportURI`: the backend command exists and the device accepts it, but the UI does not use
  it yet. Every track change is a fresh `SetAVTransportURI` + `Play`, so expect a short gap.
- Preloads (`audio_preload` / chain preload) still run for the next track while casting, wasting a little bandwidth.
- Scrobbling and play statistics rely on local engine events and are probably not recorded for cast tracks.
- Radio stations are not cast. Offline/local tracks are cast from the server, not from the local file.
- AutoDJ, crossfade, loudness normalization and EQ do not apply to renderer playback (as intended).
- Only English strings were added (`locales/en/cast.ts`); other locales fall back to English.
- No UI to pick a specific endpoint when a device exposes two.

- A renderer fetches the URL itself, so Subsonic auth must be embedded in the URL (`u/t/s`). Custom HTTP headers
  can't be sent by a renderer.
- Queue advance today is always app-driven (the app sees the renderer finish and moves on). Using
  `SetNextAVTransportURI` when the renderer supports it is the intended upgrade; see the first bullet above.

## Open questions about Eversolo behaviour (undocumented, not guessed)

- Why does it expose two renderer endpoints (1670 and 1748) under one UDN, and which should a client use? Only
  1670 gave coherent transport state in testing.
- Are those ports stable across reboots, or dynamic per boot?
- Which MIME types / `protocolInfo` does it need for FLAC, ALAC and high-res files? Does a wrong value break playback?
- Does `SetNextAVTransportURI` actually give a gapless hand-off at end of track? (It is accepted and stored; the
  actual transition was not observed.)
- Does `Seek` with `REL_TIME` work on HTTP streams, and does it need range requests from the server?
- Is the volume range 0-100, and does it use `Master` or a different channel?
- Does it follow redirects and accept long URLs with query strings?
- Does it report `STOPPED` vs `NO_MEDIA_PRESENT` at end of track in a way usable for auto-advance?
- Upstream has an existing Eversolo/Navidrome setup note about IP-based URLs vs `.home` hostnames; does the same DNS
  limit apply to the renderer's fetch?

## Notes

- Git author for these commits is set repo-locally to your GitHub noreply address. Change with `git config` if you
  prefer another identity.
- Commit messages carry no assistant attribution, following CONTRIBUTING.md rule 4.
