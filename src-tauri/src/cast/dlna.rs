//! DLNA / UPnP client for casting to a MediaRenderer: SSDP discovery plus the
//! AVTransport and RenderingControl SOAP calls.
//!
//! Everything that does not touch the network (request builders, DIDL-Lite,
//! response and description parsing) is plain functions so it can be unit tested
//! without hardware. The wire behaviour was proven against an Eversolo with
//! `spike/dlna/dlna_spike.py` first.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, ToSocketAddrs};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;
use url::Url;

const SSDP_ADDR: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 250), 1900);
const ST_MEDIA_RENDERER: &str = "urn:schemas-upnp-org:device:MediaRenderer:1";
// Some renderers (the Eversolo among them) answer only a subset of search targets.
const SEARCH_TARGETS: [&str; 3] = [ST_MEDIA_RENDERER, "upnp:rootdevice", "ssdp:all"];
const AVT_PREFIX: &str = "urn:schemas-upnp-org:service:AVTransport:";
const RC_PREFIX: &str = "urn:schemas-upnp-org:service:RenderingControl:";
const USER_AGENT: &str = "psysonic-cast/0.1 UPnP/1.1";
const SOAP_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug)]
pub(crate) enum CastError {
    Invalid(String),
    Network(String),
    Http(u16),
    Upnp { code: String, description: String },
    Parse(String),
}

impl std::fmt::Display for CastError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CastError::Invalid(m) => write!(f, "{m}"),
            CastError::Network(m) => write!(f, "network error: {m}"),
            CastError::Http(code) => write!(f, "renderer returned HTTP {code}"),
            CastError::Upnp { code, description } => write!(f, "UPnP error {code}: {description}"),
            CastError::Parse(m) => write!(f, "unexpected response: {m}"),
        }
    }
}

/// A renderer as seen on the LAN. Handed back to the frontend and passed in again
/// on every call, so the Rust side keeps no per-device state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CastRenderer {
    /// Device UDN. Stable id for the UI; one device can answer on several ports.
    pub id: String,
    pub name: String,
    pub manufacturer: String,
    pub model: String,
    pub location: String,
    pub av_control_url: String,
    pub av_service_type: String,
    pub rc_control_url: Option<String>,
    pub rc_service_type: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CastTrack {
    pub url: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub art_url: Option<String>,
    /// File suffix or MIME type; used for the DIDL-Lite `protocolInfo`.
    pub mime: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CastStatus {
    /// Raw UPnP transport state: PLAYING, PAUSED_PLAYBACK, STOPPED, TRANSITIONING, NO_MEDIA_PRESENT.
    pub state: String,
    /// Only set while PLAYING or PAUSED_PLAYBACK; other states report stale positions.
    pub position_secs: Option<f64>,
    pub duration_secs: Option<f64>,
    pub track_uri: String,
    /// 0-100, when the renderer exposes RenderingControl.
    pub volume: Option<u32>,
    pub muted: Option<bool>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

pub(crate) fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 forbids most control characters, drop them rather than emit bad XML.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

pub(crate) fn unescape_xml(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    // `&amp;` last so `&amp;lt;` decodes to the text `&lt;`, not `<`.
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// MIME type for a file suffix, or the input unchanged when it already looks like one.
pub(crate) fn mime_for(suffix_or_mime: Option<&str>) -> String {
    let raw = suffix_or_mime.unwrap_or("").trim().to_ascii_lowercase();
    if raw.contains('/') {
        return raw;
    }
    match raw.trim_start_matches('.') {
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "aac" | "m4a" | "mp4" => "audio/mp4",
        "alac" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "aiff" | "aif" => "audio/aiff",
        "wma" => "audio/x-ms-wma",
        _ => "audio/mpeg",
    }
    .to_string()
}

/// DIDL-Lite for one music track. Every value is escaped, because the URL
/// (Subsonic auth query string) routinely contains `&`.
pub(crate) fn build_didl(track: &CastTrack) -> String {
    let mut s = String::from(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" \
         xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
         xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">\
         <item id=\"0\" parentID=\"-1\" restricted=\"1\">",
    );
    s.push_str(&format!("<dc:title>{}</dc:title>", escape_xml(&track.title)));
    if let Some(a) = track.artist.as_deref().filter(|a| !a.is_empty()) {
        s.push_str(&format!("<upnp:artist>{0}</upnp:artist><dc:creator>{0}</dc:creator>", escape_xml(a)));
    }
    if let Some(a) = track.album.as_deref().filter(|a| !a.is_empty()) {
        s.push_str(&format!("<upnp:album>{}</upnp:album>", escape_xml(a)));
    }
    if let Some(a) = track.art_url.as_deref().filter(|a| !a.is_empty()) {
        s.push_str(&format!("<upnp:albumArtURI>{}</upnp:albumArtURI>", escape_xml(a)));
    }
    s.push_str("<upnp:class>object.item.audioItem.musicTrack</upnp:class>");
    s.push_str(&format!(
        "<res protocolInfo=\"http-get:*:{}:*\">{}</res>",
        escape_xml(&mime_for(track.mime.as_deref())),
        escape_xml(&track.url)
    ));
    s.push_str("</item></DIDL-Lite>");
    s
}

pub(crate) fn build_msearch(search_target: &str, mx: u8) -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\nHOST: {}:{}\r\nMAN: \"ssdp:discover\"\r\nMX: {}\r\nST: {}\r\n\
         USER-AGENT: {}\r\n\r\n",
        SSDP_ADDR.ip(),
        SSDP_ADDR.port(),
        mx,
        search_target,
        USER_AGENT
    )
}

/// Lower-cased header map from an SSDP response datagram.
pub(crate) fn parse_ssdp_headers(datagram: &str) -> HashMap<String, String> {
    datagram
        .split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect()
}

pub(crate) fn build_soap_envelope(service: &str, action: &str, args: &[(&str, String)]) -> String {
    let body: String = args
        .iter()
        .map(|(k, v)| format!("<{k}>{}</{k}>", escape_xml(v)))
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
         <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
         <s:Body><u:{action} xmlns:u=\"{service}\">{body}</u:{action}></s:Body></s:Envelope>"
    )
}

pub(crate) fn format_upnp_time(secs: f64) -> String {
    let t = secs.max(0.0).round() as u64;
    format!("{}:{:02}:{:02}", t / 3600, (t % 3600) / 60, t % 60)
}

/// `H:MM:SS[.fff]` -> seconds. `None` for `NOT_IMPLEMENTED` and anything malformed.
pub(crate) fn parse_upnp_time(s: &str) -> Option<f64> {
    let mut parts = s.trim().split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || h < 0.0 || !(0.0..60.0).contains(&m) || !(0.0..60.0).contains(&sec) {
        return None;
    }
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// First element named `local` (namespace prefix ignored): `(start-tag text, inner xml, rest after it)`.
fn find_element<'a>(xml: &'a str, local: &str) -> Option<(&'a str, &'a str, &'a str)> {
    let mut from = 0;
    while let Some(rel) = xml[from..].find('<') {
        let lt = from + rel;
        let after = &xml[lt + 1..];
        from = lt + 1;
        if after.starts_with('/') || after.starts_with('!') || after.starts_with('?') {
            continue;
        }
        let name_end = after.find(|c: char| c.is_whitespace() || c == '>' || c == '/')?;
        let raw = &after[..name_end];
        if raw.rsplit(':').next() != Some(local) {
            continue;
        }
        let gt = after.find('>')?;
        let start_tag = &after[..gt];
        let body_start = lt + 1 + gt + 1;
        if start_tag.ends_with('/') {
            return Some((start_tag, "", &xml[body_start..]));
        }
        let close = format!("</{raw}>");
        let end = xml[body_start..].find(&close)?;
        return Some((
            start_tag,
            &xml[body_start..body_start + end],
            &xml[body_start + end + close.len()..],
        ));
    }
    None
}

fn element_text(xml: &str, local: &str) -> Option<String> {
    find_element(xml, local).map(|(_, inner, _)| unescape_xml(inner.trim()))
}

fn elements<'a>(xml: &'a str, local: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some((_, inner, after)) = find_element(rest, local) {
        out.push(inner);
        rest = after;
    }
    out
}

/// Flat children of a SOAP response element as `name -> unescaped text`.
fn flat_children(inner: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = inner;
    while let Some(lt) = rest.find('<') {
        let after = &rest[lt + 1..];
        let Some(name_end) = after.find(|c: char| c.is_whitespace() || c == '>' || c == '/') else { break };
        let raw = &after[..name_end];
        let Some(gt) = after.find('>') else { break };
        let local = raw.rsplit(':').next().unwrap_or(raw).to_string();
        if after[..gt].ends_with('/') {
            out.insert(local, String::new());
            rest = &after[gt + 1..];
            continue;
        }
        let close = format!("</{raw}>");
        let Some(end) = after[gt + 1..].find(&close) else { break };
        out.insert(local, unescape_xml(&after[gt + 1..gt + 1 + end]));
        rest = &after[gt + 1 + end + close.len()..];
    }
    out
}

pub(crate) fn parse_soap_response(xml: &str) -> Result<HashMap<String, String>, CastError> {
    if let Some((_, fault, _)) = find_element(xml, "UPnPError") {
        return Err(CastError::Upnp {
            code: element_text(fault, "errorCode").unwrap_or_default(),
            description: element_text(fault, "errorDescription").unwrap_or_default(),
        });
    }
    let body = find_element(xml, "Body").map(|(_, inner, _)| inner).unwrap_or(xml);
    // First element under <Body> is `<u:ActionResponse>`.
    let lt = body.find('<').ok_or_else(|| CastError::Parse("empty SOAP body".into()))?;
    let after = &body[lt + 1..];
    let name_end = after
        .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
        .ok_or_else(|| CastError::Parse("malformed SOAP body".into()))?;
    let raw = &after[..name_end];
    if !raw.rsplit(':').next().unwrap_or(raw).ends_with("Response") {
        return Err(CastError::Parse(format!("unexpected element <{raw}>")));
    }
    let local = raw.rsplit(':').next().unwrap_or(raw);
    let (_, inner, _) = find_element(body, local).ok_or_else(|| CastError::Parse("no response element".into()))?;
    Ok(flat_children(inner))
}

/// Pull a renderer out of a device description. `None` when it has no AVTransport.
pub(crate) fn parse_description(xml: &str, location: &str) -> Result<Option<CastRenderer>, CastError> {
    let base = element_text(xml, "URLBase")
        .and_then(|b| Url::parse(&b).ok())
        .or_else(|| Url::parse(location).ok())
        .ok_or_else(|| CastError::Parse(format!("bad location {location}")))?;
    let (mut av, mut rc) = (None, None);
    for svc in elements(xml, "service") {
        let (Some(stype), Some(ctrl)) = (element_text(svc, "serviceType"), element_text(svc, "controlURL")) else {
            continue;
        };
        let Ok(url) = base.join(&ctrl) else { continue };
        if stype.starts_with(AVT_PREFIX) && av.is_none() {
            av = Some((url.to_string(), stype));
        } else if stype.starts_with(RC_PREFIX) && rc.is_none() {
            rc = Some((url.to_string(), stype));
        }
    }
    let Some((av_control_url, av_service_type)) = av else { return Ok(None) };
    let device = find_element(xml, "device").map(|(_, inner, _)| inner).unwrap_or(xml);
    Ok(Some(CastRenderer {
        id: element_text(device, "UDN").unwrap_or_else(|| location.to_string()),
        name: element_text(device, "friendlyName").unwrap_or_else(|| "Unknown renderer".into()),
        manufacturer: element_text(device, "manufacturer").unwrap_or_default(),
        model: element_text(device, "modelName").unwrap_or_default(),
        location: location.to_string(),
        av_control_url,
        av_service_type,
        rc_control_url: rc.as_ref().map(|r| r.0.clone()),
        rc_service_type: rc.map(|r| r.1),
    }))
}

fn is_lan_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            v6.is_loopback() || (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Control URLs come back from the webview, so only talk to http devices on the local network.
pub(crate) fn ensure_lan_http_url(raw: &str) -> Result<Url, CastError> {
    let url = Url::parse(raw).map_err(|e| CastError::Invalid(format!("bad renderer URL: {e}")))?;
    if url.scheme() != "http" {
        return Err(CastError::Invalid("renderer URL must be http".into()));
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) if is_lan_ip(IpAddr::V4(ip)) => Ok(url),
        Some(url::Host::Ipv6(ip)) if is_lan_ip(IpAddr::V6(ip)) => Ok(url),
        _ => Err(CastError::Invalid("renderer must be a local-network IP address".into())),
    }
}

fn ensure_http_media_url(raw: &str) -> Result<(), CastError> {
    match Url::parse(raw) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => Ok(()),
        _ => Err(CastError::Invalid("stream URL must be http(s)".into())),
    }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

fn local_ipv4s() -> Vec<Ipv4Addr> {
    let mut ips: Vec<Ipv4Addr> = Vec::new();
    if let Some(host) = sysinfo::System::host_name() {
        if let Ok(addrs) = (host.as_str(), 0).to_socket_addrs() {
            ips.extend(addrs.filter_map(|a| match a.ip() {
                IpAddr::V4(v4) => Some(v4),
                IpAddr::V6(_) => None,
            }));
        }
    }
    // Default-route interface; connect() on UDP sends nothing.
    if let Ok(s) = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
        if s.connect(SSDP_ADDR).is_ok() {
            if let Ok(SocketAddr::V4(a)) = s.local_addr() {
                ips.push(*a.ip());
            }
        }
    }
    ips.retain(|ip| !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified());
    ips.sort();
    ips.dedup();
    ips
}

fn ssdp_socket(source: Ipv4Addr) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_multicast_ttl_v4(2)?;
    socket.bind(&SocketAddr::V4(SocketAddrV4::new(source, 0)).into())?;
    if !source.is_unspecified() {
        socket.set_multicast_if_v4(&source)?;
    }
    socket.set_nonblocking(true)?;
    UdpSocket::from_std(socket.into())
}

/// SSDP search from every local IPv4 interface (a single default-interface search
/// misses devices on multi-adapter hosts), then read each unique device description.
pub(crate) async fn discover(client: &reqwest::Client, listen: Duration) -> Vec<CastRenderer> {
    let mut sources = local_ipv4s();
    if sources.is_empty() {
        sources.push(Ipv4Addr::UNSPECIFIED);
    }
    let mut sockets = Vec::new();
    for src in sources {
        let Ok(sock) = ssdp_socket(src) else { continue };
        for st in SEARCH_TARGETS {
            let msg = build_msearch(st, 2);
            for _ in 0..2 {
                let _ = sock.send_to(msg.as_bytes(), SSDP_ADDR).await;
            }
        }
        sockets.push(sock);
    }

    let mut locations: Vec<String> = Vec::new();
    let deadline = Instant::now() + listen;
    let mut buf = vec![0u8; 8192];
    while Instant::now() < deadline {
        let mut idle = true;
        for sock in &sockets {
            if let Ok(Ok((n, _))) = tokio::time::timeout(Duration::from_millis(15), sock.recv_from(&mut buf)).await {
                idle = false;
                let headers = parse_ssdp_headers(&String::from_utf8_lossy(&buf[..n]));
                if let Some(loc) = headers.get("location") {
                    if !locations.contains(loc) {
                        locations.push(loc.clone());
                    }
                }
            }
        }
        if idle {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
    locations.sort();

    let mut found: Vec<CastRenderer> = Vec::new();
    for loc in locations {
        // A malicious LAN host could advertise any LOCATION; stay on the local network.
        if ensure_lan_http_url(&loc).is_err() {
            continue;
        }
        let Ok(resp) = client.get(&loc).timeout(Duration::from_secs(4)).send().await else { continue };
        let Ok(text) = resp.text().await else { continue };
        // One device (same UDN) can answer on several ports; keep the first location in
        // sorted order so the choice is stable. See SUMMARY.md for why that matters.
        if let Ok(Some(r)) = parse_description(&text, &loc) {
            if !found.iter().any(|f| f.id == r.id) {
                found.push(r);
            }
        }
    }
    found.sort_by_key(|r| r.name.to_lowercase());
    found
}

async fn soap_call(
    client: &reqwest::Client,
    control_url: &str,
    service: &str,
    action: &str,
    args: &[(&str, String)],
) -> Result<HashMap<String, String>, CastError> {
    let url = ensure_lan_http_url(control_url)?;
    let resp = client
        .post(url)
        .timeout(SOAP_TIMEOUT)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPACTION", format!("\"{service}#{action}\""))
        .body(build_soap_envelope(service, action, args))
        .send()
        .await
        .map_err(|e| CastError::Network(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| CastError::Network(e.to_string()))?;
    match parse_soap_response(&text) {
        Ok(map) if status.is_success() => Ok(map),
        Err(e @ CastError::Upnp { .. }) => Err(e),
        _ if !status.is_success() => Err(CastError::Http(status.as_u16())),
        Err(e) => Err(e),
        Ok(_) => unreachable!("success handled above"),
    }
}

fn av_args<'a>(extra: &[(&'a str, String)]) -> Vec<(&'a str, String)> {
    let mut v = vec![("InstanceID", "0".to_string())];
    v.extend_from_slice(extra);
    v
}

async fn av(
    client: &reqwest::Client,
    r: &CastRenderer,
    action: &str,
    extra: &[(&str, String)],
) -> Result<HashMap<String, String>, CastError> {
    soap_call(client, &r.av_control_url, &r.av_service_type, action, &av_args(extra)).await
}

fn rc_endpoint(r: &CastRenderer) -> Result<(&str, &str), CastError> {
    match (&r.rc_control_url, &r.rc_service_type) {
        (Some(u), Some(s)) => Ok((u, s)),
        _ => Err(CastError::Invalid("renderer has no RenderingControl service".into())),
    }
}

pub(crate) async fn set_transport_uri(client: &reqwest::Client, r: &CastRenderer, t: &CastTrack) -> Result<(), CastError> {
    ensure_http_media_url(&t.url)?;
    av(client, r, "SetAVTransportURI", &[("CurrentURI", t.url.clone()), ("CurrentURIMetaData", build_didl(t))]).await?;
    Ok(())
}

pub(crate) async fn set_next_transport_uri(client: &reqwest::Client, r: &CastRenderer, t: &CastTrack) -> Result<(), CastError> {
    ensure_http_media_url(&t.url)?;
    av(client, r, "SetNextAVTransportURI", &[("NextURI", t.url.clone()), ("NextURIMetaData", build_didl(t))]).await?;
    Ok(())
}

pub(crate) async fn play(client: &reqwest::Client, r: &CastRenderer) -> Result<(), CastError> {
    av(client, r, "Play", &[("Speed", "1".into())]).await?;
    Ok(())
}

pub(crate) async fn pause(client: &reqwest::Client, r: &CastRenderer) -> Result<(), CastError> {
    av(client, r, "Pause", &[]).await?;
    Ok(())
}

pub(crate) async fn stop(client: &reqwest::Client, r: &CastRenderer) -> Result<(), CastError> {
    av(client, r, "Stop", &[]).await?;
    Ok(())
}

pub(crate) async fn seek(client: &reqwest::Client, r: &CastRenderer, secs: f64) -> Result<(), CastError> {
    av(client, r, "Seek", &[("Unit", "REL_TIME".into()), ("Target", format_upnp_time(secs))]).await?;
    Ok(())
}

pub(crate) async fn set_volume(client: &reqwest::Client, r: &CastRenderer, volume: u32) -> Result<(), CastError> {
    let (url, svc) = rc_endpoint(r)?;
    let args = [
        ("InstanceID", "0".to_string()),
        ("Channel", "Master".to_string()),
        ("DesiredVolume", volume.min(100).to_string()),
    ];
    soap_call(client, url, svc, "SetVolume", &args).await?;
    Ok(())
}

/// Start a track, optionally resuming at an offset. A renderer needs a moment after
/// `Play` before it accepts `Seek` (it reports TRANSITIONING), so wait for PLAYING.
pub(crate) async fn play_track(
    client: &reqwest::Client,
    r: &CastRenderer,
    track: &CastTrack,
    start_secs: Option<f64>,
) -> Result<(), CastError> {
    set_transport_uri(client, r, track).await?;
    play(client, r).await?;
    if let Some(start) = start_secs.filter(|s| *s >= 1.0) {
        for _ in 0..24 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if let Ok(info) = av(client, r, "GetTransportInfo", &[]).await {
                if info.get("CurrentTransportState").map(String::as_str) == Some("PLAYING") {
                    return seek(client, r, start).await;
                }
            }
        }
    }
    Ok(())
}

pub(crate) async fn status(client: &reqwest::Client, r: &CastRenderer) -> Result<CastStatus, CastError> {
    let (info, pos) = futures_util::future::join(
        av(client, r, "GetTransportInfo", &[]),
        av(client, r, "GetPositionInfo", &[]),
    )
    .await;
    let info = info?;
    let pos = pos?;
    let state = info.get("CurrentTransportState").cloned().unwrap_or_default();
    let live = matches!(state.as_str(), "PLAYING" | "PAUSED_PLAYBACK");
    let (volume, muted) = match rc_endpoint(r) {
        Ok((url, svc)) => {
            let args = [("InstanceID", "0".to_string()), ("Channel", "Master".to_string())];
            let (v, m) = futures_util::future::join(
                soap_call(client, url, svc, "GetVolume", &args),
                soap_call(client, url, svc, "GetMute", &args),
            )
            .await;
            (
                v.ok().and_then(|m| m.get("CurrentVolume").and_then(|s| s.trim().parse().ok())),
                m.ok().and_then(|m| m.get("CurrentMute").map(|s| s.trim() == "1")),
            )
        }
        Err(_) => (None, None),
    };
    Ok(CastStatus {
        position_secs: live.then(|| pos.get("RelTime").and_then(|s| parse_upnp_time(s))).flatten(),
        duration_secs: live.then(|| pos.get("TrackDuration").and_then(|s| parse_upnp_time(s))).flatten(),
        track_uri: pos.get("TrackURI").cloned().unwrap_or_default(),
        state,
        volume,
        muted,
    })
}

#[cfg(test)]
mod tests;
