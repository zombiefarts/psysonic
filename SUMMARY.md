# DLNA casting: progress summary

Branch: `feature/dlna-cast` (fork of Psysonic, not pushed, no PR opened).

## Status

Steps 1-4 are done. Step 5 (Rust + React integration) has **not** been started. It is gated on your confirming
the spike works on your Eversolo.

## What changed

- `spike/dlna/dlna_spike.py`: standalone, stdlib-only Python tool (SSDP discovery, device description parsing,
  AVTransport/RenderingControl SOAP, DIDL-Lite with XML escaping).
- `spike/dlna/README.md`: usage and the exact commands to run.
- `README.md`: added a note that this is a fork based on Psysonic.
- No changes to telemetry, privacy or license files. No app code touched.

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

## How to run the spike

See `spike/dlna/README.md`. Short version, from the repo root on a machine on the Eversolo's LAN:

```bash
python spike/dlna/dlna_spike.py -v discover
python spike/dlna/dlna_spike.py -v play "<STREAM_URL>" "Test Title" --artist "Test Artist"
python spike/dlna/dlna_spike.py status
```

## What I need you to test on the Eversolo

1. `discover`: does it find the device, and what are its AVTransport/RenderingControl URLs?
2. `play` with a stream URL that works with `curl` from a LAN machine: do you hear audio? Try MP3 and FLAC.
3. `status` twice a few seconds apart: does `RelTime` advance, and does `TransportState` read `PLAYING`?
4. `seek`, `pause`, `resume`, `stop`, `get-volume`, `set-volume`: which succeed?
5. `next`: does the device accept `SetNextAVTransportURI` (decides gapless vs app-driven queue advance)?
6. Paste the output with the stream URL token and host redacted.

## Known limitations (to document in the app)

- A renderer fetches the URL itself, so Subsonic auth must be embedded in the URL (`u/t/s`). Custom HTTP headers
  can't be sent by a renderer.
- AutoDJ, crossfade, loudness normalization and EQ do not apply to renderer playback.
- Queue advance uses `SetNextAVTransportURI` if supported, otherwise the app detects track end and advances itself.

## Open questions about Eversolo behaviour (undocumented, not guessed)

- Which MIME types / `protocolInfo` does it need for FLAC, ALAC and high-res files? Does a wrong value break playback?
- Does it support `SetNextAVTransportURI` (gapless)?
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
