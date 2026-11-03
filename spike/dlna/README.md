# DLNA / UPnP spike

Standalone proof-of-protocol for casting to a UPnP MediaRenderer (target: Eversolo DMP-A6/A8/A10).
It is **not** part of the app. It uses only the Python 3.9+ standard library, so there is nothing to install.

It does SSDP discovery, reads the device description, finds the AVTransport and RenderingControl control URLs,
then sends `SetAVTransportURI` (with DIDL-Lite metadata) and `Play`.

## Run it (from the repo root, on a machine on the same LAN/VLAN as the Eversolo)

### 1. Discover

```bash
python spike/dlna/dlna_spike.py -v discover
```

Expect a line like `* Eversolo A6 [...] <-- looks like Eversolo` plus `AVTransport` and `RenderingControl` URLs.
If nothing is found: try `--bind <your-LAN-IP>` (needed on multi-NIC or VPN machines), or `--timeout 8`.
On Windows, allow Python through the firewall for private networks.

### 2. Check the stream URL from a LAN machine first

The Eversolo fetches the URL itself, so it must be reachable from the LAN. Test it before blaming the device:

```bash
curl -I -r 0-1023 "http://<subsonic-host>:<port>/rest/stream?id=<song-id>&u=<user>&t=<token>&s=<salt>&v=1.16.1&c=spike&f=json"
```

Psysonic builds URLs like `rest/stream` with `u/t/s/v/c/f` query params. You want `200`/`206` and an `audio/*`
Content-Type, not JSON/XML. The `play` command repeats this check from your machine automatically.
Use a hostname/IP the Eversolo can resolve (not `localhost`; a name like `navidrome.home` only works if the
Eversolo uses your DNS). Known limitation: if the server needs custom HTTP headers, a renderer cannot send them.
Only URL-embedded auth works.

### 3. Play

```bash
python spike/dlna/dlna_spike.py -v play "<STREAM_URL>" "Test Title" --artist "Test Artist" --album "Test Album" --mime audio/mpeg
```

Use `--mime audio/flac` for FLAC, etc. Add `--name Eversolo` or `--ip <eversolo-ip>` to pick a device.
If you already know the description URL, use `--location http://<ip>:<port>/<path>.xml` and skip SSDP.

### 4. Other subcommands

```bash
python spike/dlna/dlna_spike.py status          # GetTransportInfo, GetPositionInfo, GetMediaInfo
python spike/dlna/dlna_spike.py pause
python spike/dlna/dlna_spike.py resume
python spike/dlna/dlna_spike.py stop
python spike/dlna/dlna_spike.py seek 60         # REL_TIME, seconds
python spike/dlna/dlna_spike.py get-volume
python spike/dlna/dlna_spike.py set-volume 25   # 0-100
python spike/dlna/dlna_spike.py next "<URL2>" "Title 2"   # probes SetNextAVTransportURI (gapless)
```

Global flags (`-v`, `--ip`, `--name`, `--location`, `--bind`, `--timeout`) go **before** the subcommand.

## What to send back

Run these and paste the full output (redact the stream URL token/host and any credentials):

```bash
python spike/dlna/dlna_spike.py -v discover
python spike/dlna/dlna_spike.py -v play "<STREAM_URL>" "Test Title" --artist "Test Artist"
python spike/dlna/dlna_spike.py status
python spike/dlna/dlna_spike.py seek 30
python spike/dlna/dlna_spike.py status
python spike/dlna/dlna_spike.py set-volume 20
python spike/dlna/dlna_spike.py get-volume
python spike/dlna/dlna_spike.py pause
python spike/dlna/dlna_spike.py stop
python spike/dlna/dlna_spike.py next "<URL2>" "Title 2"
```

Also tell me: did you hear audio, which format (MP3/FLAC/other) you tried, and the Eversolo model/firmware.
`-v` prints raw SSDP/SOAP traffic to stderr; tokens in URLs will appear there, so redact them.
