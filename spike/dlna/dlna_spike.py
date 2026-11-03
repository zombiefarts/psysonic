#!/usr/bin/env python3
"""Standalone DLNA/UPnP AVTransport spike for Psysonic.

Pure standard library (no pip installs). Discovers UPnP MediaRenderers over
SSDP, reads their device description, and drives AVTransport / RenderingControl
with plain SOAP. Meant to prove the protocol flow against an Eversolo before
any of it is ported to Rust.

Run `python dlna_spike.py --help` or see README.md.
"""
from __future__ import annotations

import argparse
import json
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

SSDP_ADDR = ("239.255.255.250", 1900)
MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1"
AVT = "urn:schemas-upnp-org:service:AVTransport:1"
RC = "urn:schemas-upnp-org:service:RenderingControl:1"
DEFAULT_HINTS = ("eversolo",)

_verbose = False


def vlog(*a):
    if _verbose:
        print("[debug]", *a, file=sys.stderr)


# --------------------------------------------------------------------------
# Pure builders / parsers (no network; unit-testable)
# --------------------------------------------------------------------------

def build_msearch(st: str = MEDIA_RENDERER, mx: int = 2) -> bytes:
    return (
        "M-SEARCH * HTTP/1.1\r\n"
        f"HOST: {SSDP_ADDR[0]}:{SSDP_ADDR[1]}\r\n"
        'MAN: "ssdp:discover"\r\n'
        f"MX: {mx}\r\n"
        f"ST: {st}\r\n"
        "USER-AGENT: psysonic-dlna-spike/0.1 UPnP/1.1\r\n\r\n"
    ).encode()


def parse_ssdp_response(data: bytes) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in data.decode("utf-8", "replace").split("\r\n")[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return headers


def build_didl(title: str, url: str, mime: str = "audio/mpeg",
               artist: str = "", album: str = "", art: str = "") -> str:
    """DIDL-Lite for one music track. Every text/attribute value is XML-escaped."""
    def q(s: str) -> str:
        return escape(s, {'"': "&quot;"})

    parts = [
        '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
        '<item id="0" parentID="-1" restricted="1">',
        f"<dc:title>{escape(title)}</dc:title>",
    ]
    if artist:
        parts.append(f"<upnp:artist>{escape(artist)}</upnp:artist>")
        parts.append(f"<dc:creator>{escape(artist)}</dc:creator>")
    if album:
        parts.append(f"<upnp:album>{escape(album)}</upnp:album>")
    if art:
        parts.append(f"<upnp:albumArtURI>{escape(art)}</upnp:albumArtURI>")
    parts.append("<upnp:class>object.item.audioItem.musicTrack</upnp:class>")
    parts.append(f'<res protocolInfo="http-get:*:{q(mime)}:*">{escape(url)}</res>')
    parts.append("</item></DIDL-Lite>")
    return "".join(parts)


def build_soap_envelope(service: str, action: str, args: list[tuple[str, str]]) -> bytes:
    body = "".join(f"<{k}>{escape(str(v))}</{k}>" for k, v in args)
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        f'<s:Body><u:{action} xmlns:u="{service}">{body}</u:{action}></s:Body>'
        "</s:Envelope>"
    ).encode("utf-8")


def parse_soap_response(xml_bytes: bytes) -> dict[str, str]:
    """Return {argName: value} from a SOAP response, or raise UpnpFault."""
    root = ET.fromstring(xml_bytes)
    for el in root.iter():
        if el.tag.endswith("}Fault") or el.tag == "Fault":
            code = desc = ""
            for sub in el.iter():
                tag = sub.tag.rsplit("}", 1)[-1]
                if tag == "errorCode":
                    code = (sub.text or "").strip()
                elif tag == "errorDescription":
                    desc = (sub.text or "").strip()
            raise UpnpFault(code, desc)
    out: dict[str, str] = {}
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1].endswith("Response"):
            for child in el:
                out[child.tag.rsplit("}", 1)[-1]] = (child.text or "")
            break
    return out


def fmt_time(seconds: int) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 3600}:{(seconds % 3600) // 60:02d}:{seconds % 60:02d}"


def parse_description(xml_bytes: bytes, location: str) -> dict:
    """Extract friendly name + AVTransport/RenderingControl control URLs."""
    root = ET.fromstring(xml_bytes)
    ns = {"d": "urn:schemas-upnp-org:device-1-0"}
    base = location
    ub = root.find("d:URLBase", ns)
    if ub is not None and ub.text:
        base = ub.text.strip()

    def txt(node, tag):
        e = node.find(f"d:{tag}", ns) if node is not None else None
        return (e.text or "").strip() if e is not None else ""

    dev = root.find("d:device", ns)
    info = {
        "friendlyName": txt(dev, "friendlyName"),
        "manufacturer": txt(dev, "manufacturer"),
        "modelName": txt(dev, "modelName"),
        "deviceType": txt(dev, "deviceType"),
        "udn": txt(dev, "UDN"),
        "location": location,
        "avTransport": None,
        "renderingControl": None,
        "services": [],
    }
    for svc in root.iter("{urn:schemas-upnp-org:device-1-0}service"):
        stype = txt(svc, "serviceType")
        ctrl = urllib.parse.urljoin(base, txt(svc, "controlURL"))
        info["services"].append({"type": stype, "control": ctrl})
        if stype.startswith("urn:schemas-upnp-org:service:AVTransport:"):
            info["avTransport"] = {"type": stype, "control": ctrl}
        elif stype.startswith("urn:schemas-upnp-org:service:RenderingControl:"):
            info["renderingControl"] = {"type": stype, "control": ctrl}
    return info


class UpnpFault(Exception):
    def __init__(self, code: str, desc: str):
        super().__init__(f"UPnP error {code}: {desc}")
        self.code, self.desc = code, desc


# --------------------------------------------------------------------------
# Network
# --------------------------------------------------------------------------

SEARCH_TARGETS = (MEDIA_RENDERER, "upnp:rootdevice", "ssdp:all", AVT)


def local_ipv4s() -> list[str]:
    """Best-effort list of this machine's IPv4 addresses (skips loopback/link-local)."""
    ips: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("239.255.255.250", 1900))  # no packet sent; picks the default-route NIC
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(i for i in ips if not i.startswith(("127.", "169.254.")))


def ssdp_search(timeout: float, bind_ip: str | None, unicast_ip: str | None = None) -> list[str]:
    """Return unique LOCATION urls of UPnP devices (any search target; filtered later).

    Sends from every local IPv4 address (or just `bind_ip`) so multi-NIC Windows machines
    do not lose the packet on the wrong adapter. With `unicast_ip` it also queries that
    device directly on UDP 1900.
    """
    sources = [bind_ip] if bind_ip else (local_ipv4s() or [None])
    socks = []
    for src in sources:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
            if src:
                sock.bind((src, 0))
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(src))
            sock.settimeout(0.2)
            socks.append((src, sock))
            print(f"[ssdp] sending from {src or 'default interface'}", file=sys.stderr) if _verbose else None
        except OSError as e:
            vlog("could not use source", src, e)
    if not socks:
        raise SystemExit("Could not open any UDP socket for SSDP.")
    for src, sock in socks:
        for st in SEARCH_TARGETS:
            msg = build_msearch(st)
            for _ in range(2):
                try:
                    sock.sendto(msg, SSDP_ADDR)
                    if unicast_ip:
                        sock.sendto(msg, (unicast_ip, 1900))
                except OSError as e:
                    vlog("send failed from", src, e)
    seen: dict[str, str] = {}
    end = time.time() + timeout
    while time.time() < end:
        for _, sock in socks:
            try:
                data, addr = sock.recvfrom(65507)
            except (socket.timeout, OSError):
                continue
            h = parse_ssdp_response(data)
            loc = h.get("location")
            if loc and loc not in seen:
                vlog("SSDP new device", addr[0], {k: h.get(k) for k in ("st", "server", "location")})
                seen[loc] = addr[0]
    for _, sock in socks:
        sock.close()
    return list(seen)


def http_get(url: str, timeout: float = 5.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "psysonic-dlna-spike/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def describe(location: str) -> dict:
    return parse_description(http_get(location), location)


def soap_call(control_url: str, service: str, action: str,
              args: list[tuple[str, str]], timeout: float = 8.0) -> dict[str, str]:
    body = build_soap_envelope(service, action, args)
    req = urllib.request.Request(control_url, data=body, method="POST", headers={
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPACTION": f'"{service}#{action}"',
        "User-Agent": "psysonic-dlna-spike/0.1",
    })
    vlog("SOAP ->", control_url, action, body.decode())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        vlog("SOAP HTTP error", e.code, raw.decode("utf-8", "replace"))
        try:
            parse_soap_response(raw)  # raises UpnpFault if it is a fault body
        except UpnpFault:
            raise
        except ET.ParseError:
            pass
        raise RuntimeError(f"HTTP {e.code} from renderer: {raw[:300]!r}") from e
    vlog("SOAP <-", raw.decode("utf-8", "replace"))
    return parse_soap_response(raw)


def check_stream_url(url: str) -> None:
    """Sanity-check the URL from THIS machine (not the renderer's view)."""
    req = urllib.request.Request(url, headers={"Range": "bytes=0-1023",
                                               "User-Agent": "psysonic-dlna-spike/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            ctype = r.headers.get("Content-Type", "?")
            n = len(r.read(1024))
            print(f"[stream check] HTTP {r.status}, Content-Type={ctype}, got {n} bytes, "
                  f"Accept-Ranges={r.headers.get('Accept-Ranges', 'none')}")
            if ctype.startswith("text/") or "json" in ctype or "xml" in ctype:
                print("[stream check] WARNING: this looks like an error body, not audio. "
                      "Check credentials/params.")
    except Exception as e:  # noqa: BLE001
        print(f"[stream check] FAILED from this machine: {e}")
        print("[stream check] The renderer will almost certainly fail too. Fix the URL first.")


# --------------------------------------------------------------------------
# Device selection
# --------------------------------------------------------------------------

def find_devices(args) -> list[dict]:
    if args.location:
        return [describe(args.location)]
    if args.ip:
        # Eversolo UPnP description port varies by firmware; fall back to SSDP filtered by IP.
        locs = [l for l in ssdp_search(args.timeout, args.bind, args.ip) if args.ip in l]
        if not locs:
            raise SystemExit(f"No UPnP device at {args.ip} answered SSDP. "
                             "Check the IP, that the device is awake, and try `-v`; "
                             "or pass --location with the description URL.")
    else:
        locs = ssdp_search(args.timeout, args.bind)
    devs = []
    for loc in locs:
        try:
            devs.append(describe(loc))
        except Exception as e:  # noqa: BLE001
            print(f"  (could not read {loc}: {e})", file=sys.stderr)
    return devs


def pick_device(args) -> dict:
    devs = []
    seen_udn: set[str] = set()
    for d in find_devices(args):
        # Some renderers (Eversolo) advertise the same UDN on several, changing ports.
        if d["avTransport"] and (not d["udn"] or d["udn"] not in seen_udn):
            seen_udn.add(d["udn"])
            devs.append(d)
    if not devs:
        raise SystemExit("No renderer with an AVTransport service found. Run `discover -v`.")
    if args.name:
        devs = [d for d in devs if args.name.lower() in d["friendlyName"].lower()] or devs
    else:
        pref = [d for d in devs if any(h in (d["friendlyName"] + d["manufacturer"] + d["modelName"]).lower()
                                       for h in DEFAULT_HINTS)]
        devs = pref or devs
    if len(devs) > 1:
        print("Multiple renderers found, using the first. Use --name or --location to choose:",
              file=sys.stderr)
        for d in devs:
            print(f"  - {d['friendlyName']} ({d['location']})", file=sys.stderr)
    return devs[0]


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def cmd_discover(args):
    devs = find_devices(args)
    if not devs:
        print("No MediaRenderers answered. Check: same subnet/VLAN, multicast allowed, "
              "try --bind <your LAN IP> on multi-NIC machines/VPNs.")
        return 1
    for d in devs:
        flag = " <-- looks like Eversolo" if any(
            h in (d["friendlyName"] + d["manufacturer"] + d["modelName"]).lower() for h in DEFAULT_HINTS) else ""
        print(f"* {d['friendlyName']}  [{d['manufacturer']} {d['modelName']}]{flag}")
        print(f"    location : {d['location']}")
        print(f"    AVTransport      : {d['avTransport']['control'] if d['avTransport'] else '-'}")
        print(f"    RenderingControl : {d['renderingControl']['control'] if d['renderingControl'] else '-'}")
        if args.json:
            print(json.dumps(d, indent=2))
    return 0


def av(dev, action, extra=()):
    s = dev["avTransport"]
    return soap_call(s["control"], s["type"], action, [("InstanceID", "0"), *extra])


def rc(dev, action, extra=()):
    s = dev["renderingControl"]
    if not s:
        raise SystemExit("Renderer exposes no RenderingControl service.")
    return soap_call(s["control"], s["type"], action, [("InstanceID", "0"), *extra])


def require_http_url(url: str) -> None:
    if not url.lower().startswith(("http://", "https://")):
        raise SystemExit(f"ERROR: {url!r} is not an http(s) URL. Replace the placeholder with a real, "
                         "LAN-reachable stream URL (in quotes).")


def cmd_play(args):
    require_http_url(args.url)
    dev = pick_device(args)
    print(f"Renderer: {dev['friendlyName']}")
    if not args.skip_check:
        check_stream_url(args.url)
    didl = build_didl(args.title, args.url, args.mime, args.artist, args.album, args.art)
    print("SetAVTransportURI ...")
    av(dev, "SetAVTransportURI", [("CurrentURI", args.url), ("CurrentURIMetaData", didl)])
    print("Play ...")
    av(dev, "Play", [("Speed", "1")])
    print("OK. Run `status` to confirm it is PLAYING and the position advances.")
    return 0


def cmd_simple(action):
    def run(args):
        dev = pick_device(args)
        av(dev, action, [("Speed", "1")] if action == "Play" else [])
        print(f"{action}: OK")
        return 0
    return run


def cmd_status(args):
    dev = pick_device(args)
    print("GetTransportInfo:", json.dumps(av(dev, "GetTransportInfo")))
    print("GetPositionInfo :", json.dumps(av(dev, "GetPositionInfo")))
    try:
        print("GetMediaInfo    :", json.dumps(av(dev, "GetMediaInfo")))
    except Exception as e:  # noqa: BLE001
        print("GetMediaInfo    : failed:", e)
    return 0


def cmd_seek(args):
    dev = pick_device(args)
    av(dev, "Seek", [("Unit", "REL_TIME"), ("Target", fmt_time(args.seconds))])
    print(f"Seek to {fmt_time(args.seconds)}: OK")
    return 0


def cmd_get_volume(args):
    dev = pick_device(args)
    print("GetVolume:", json.dumps(rc(dev, "GetVolume", [("Channel", "Master")])))
    try:
        print("GetMute  :", json.dumps(rc(dev, "GetMute", [("Channel", "Master")])))
    except Exception as e:  # noqa: BLE001
        print("GetMute  : failed:", e)
    return 0


def cmd_set_volume(args):
    dev = pick_device(args)
    rc(dev, "SetVolume", [("Channel", "Master"), ("DesiredVolume", str(args.level))])
    print(f"SetVolume {args.level}: OK")
    return 0


def cmd_next(args):
    """Probe gapless support: SetNextAVTransportURI."""
    require_http_url(args.url)
    dev = pick_device(args)
    didl = build_didl(args.title, args.url, args.mime)
    av(dev, "SetNextAVTransportURI", [("NextURI", args.url), ("NextURIMetaData", didl)])
    print("SetNextAVTransportURI: OK (renderer accepts it)")
    return 0


def main(argv=None):
    global _verbose
    p = argparse.ArgumentParser(description="DLNA/UPnP AVTransport spike for Psysonic")
    p.add_argument("-v", "--verbose", action="store_true", help="print SSDP/SOAP traffic to stderr")
    p.add_argument("--timeout", type=float, default=4.0, help="SSDP listen seconds (default 4)")
    p.add_argument("--bind", help="local IPv4 to send SSDP from (multi-NIC / VPN machines)")
    p.add_argument("--ip", help="only use the renderer at this IP")
    p.add_argument("--name", help="substring of friendly name to select")
    p.add_argument("--location", help="device description URL (skips SSDP)")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("discover", help="find renderers and print service URLs")
    d.add_argument("--json", action="store_true")
    d.set_defaults(fn=cmd_discover)

    def track_args(sp):
        sp.add_argument("url", help="stream URL the renderer will fetch (must be LAN-reachable)")
        sp.add_argument("title", help="track title for DIDL-Lite")
        sp.add_argument("--artist", default="")
        sp.add_argument("--album", default="")
        sp.add_argument("--art", default="", help="album art URL")
        sp.add_argument("--mime", default="audio/mpeg", help="e.g. audio/mpeg, audio/flac")

    pl = sub.add_parser("play", help="SetAVTransportURI + Play")
    track_args(pl)
    pl.add_argument("--skip-check", action="store_true", help="skip local stream URL check")
    pl.set_defaults(fn=cmd_play)

    for name, action in (("resume", "Play"), ("pause", "Pause"), ("stop", "Stop")):
        sp = sub.add_parser(name)
        sp.set_defaults(fn=cmd_simple(action))

    sub.add_parser("status", help="GetTransportInfo + GetPositionInfo + GetMediaInfo").set_defaults(fn=cmd_status)

    sk = sub.add_parser("seek")
    sk.add_argument("seconds", type=int)
    sk.set_defaults(fn=cmd_seek)

    sub.add_parser("get-volume").set_defaults(fn=cmd_get_volume)
    sv = sub.add_parser("set-volume")
    sv.add_argument("level", type=int, help="0-100")
    sv.set_defaults(fn=cmd_set_volume)

    nx = sub.add_parser("next", help="probe SetNextAVTransportURI (gapless queue advance)")
    track_args(nx)
    nx.set_defaults(fn=cmd_next)

    args = p.parse_args(argv)
    _verbose = args.verbose
    try:
        return args.fn(args) or 0
    except UpnpFault as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    except (urllib.error.URLError, socket.timeout, RuntimeError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
