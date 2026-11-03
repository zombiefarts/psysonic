use super::*;

fn track() -> CastTrack {
    CastTrack {
        url: "http://192.168.1.10:4533/rest/stream.view?id=abc&u=me&t=tok&s=salt".into(),
        title: "Tom & Jerry <live> \"quoted\"".into(),
        artist: Some("A&B".into()),
        album: Some("Album's".into()),
        art_url: Some("http://192.168.1.10:4533/rest/getCoverArt.view?id=1&size=600".into()),
        mime: Some("flac".into()),
    }
}

#[test]
fn escape_covers_the_five_xml_entities() {
    assert_eq!(escape_xml("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
}

#[test]
fn escape_drops_control_characters_but_keeps_whitespace() {
    assert_eq!(escape_xml("a\u{0}b\u{7}c\td\ne"), "abc\td\ne");
}

#[test]
fn unescape_round_trips_and_does_not_double_decode() {
    let original = "x & <y> \"z\" 'w' &lt; &amp;";
    assert_eq!(unescape_xml(&escape_xml(original)), original);
    assert_eq!(unescape_xml("&amp;lt;"), "&lt;");
}

#[test]
fn didl_escapes_every_value_and_never_leaks_raw_markup() {
    let didl = build_didl(&track());
    assert!(didl.contains("<dc:title>Tom &amp; Jerry &lt;live&gt; &quot;quoted&quot;</dc:title>"));
    assert!(didl.contains("<upnp:artist>A&amp;B</upnp:artist>"));
    assert!(didl.contains("<dc:creator>A&amp;B</dc:creator>"));
    assert!(didl.contains("<upnp:album>Album&apos;s</upnp:album>"));
    assert!(didl.contains("id=abc&amp;u=me&amp;t=tok&amp;s=salt</res>"));
    assert!(didl.contains("getCoverArt.view?id=1&amp;size=600</upnp:albumArtURI>"));
    assert!(didl.contains("protocolInfo=\"http-get:*:audio/flac:*\""));
    assert!(!didl.contains("Tom & Jerry"));
    assert!(didl.starts_with("<DIDL-Lite ") && didl.ends_with("</item></DIDL-Lite>"));
}

#[test]
fn didl_omits_empty_optional_fields() {
    let t = CastTrack { artist: Some(String::new()), album: None, art_url: None, mime: None, ..track() };
    let didl = build_didl(&t);
    assert!(!didl.contains("upnp:artist") && !didl.contains("upnp:album") && !didl.contains("albumArtURI"));
    assert!(didl.contains("audio/mpeg"));
}

#[test]
fn mime_from_suffix_or_passthrough() {
    assert_eq!(mime_for(Some("FLAC")), "audio/flac");
    assert_eq!(mime_for(Some(".m4a")), "audio/mp4");
    assert_eq!(mime_for(Some("audio/ogg")), "audio/ogg");
    assert_eq!(mime_for(Some("mp3")), "audio/mpeg");
    assert_eq!(mime_for(Some("???")), "audio/mpeg");
    assert_eq!(mime_for(None), "audio/mpeg");
}

#[test]
fn soap_envelope_wraps_the_action_and_escapes_arguments() {
    let xml = build_soap_envelope(
        "urn:schemas-upnp-org:service:AVTransport:1",
        "SetAVTransportURI",
        &[("InstanceID", "0".into()), ("CurrentURIMetaData", build_didl(&track()))],
    );
    assert!(xml.contains("<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">"));
    assert!(xml.contains("<InstanceID>0</InstanceID>"));
    assert!(xml.ends_with("</u:SetAVTransportURI></s:Body></s:Envelope>"));
    // The DIDL travels as escaped text, so it must not add elements to the envelope.
    assert!(xml.contains("&lt;DIDL-Lite "));
    assert!(!xml.contains("<DIDL-Lite"));
    // Escaped twice end to end: the `&amp;` in the DIDL's own URL becomes `&amp;amp;`.
    assert!(xml.contains("id=abc&amp;amp;u=me"));
}

#[test]
fn soap_response_parses_arguments() {
    let xml = "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\">\
        <s:Body><u:GetTransportInfoResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
        <CurrentTransportState>PLAYING</CurrentTransportState>\
        <CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>\
        </u:GetTransportInfoResponse></s:Body></s:Envelope>";
    let map = parse_soap_response(xml).unwrap();
    assert_eq!(map["CurrentTransportState"], "PLAYING");
    assert_eq!(map["CurrentSpeed"], "1");
}

#[test]
fn soap_response_unescapes_embedded_didl_and_handles_empty_elements() {
    let xml = "<s:Envelope xmlns:s=\"x\"><s:Body><u:GetPositionInfoResponse xmlns:u=\"y\">\
        <TrackMetaData>&lt;DIDL-Lite&gt;a &amp;amp; b&lt;/DIDL-Lite&gt;</TrackMetaData>\
        <TrackURI/><RelTime>0:00:05</RelTime></u:GetPositionInfoResponse></s:Body></s:Envelope>";
    let map = parse_soap_response(xml).unwrap();
    assert_eq!(map["TrackMetaData"], "<DIDL-Lite>a &amp; b</DIDL-Lite>");
    assert_eq!(map["TrackURI"], "");
    assert_eq!(map["RelTime"], "0:00:05");
}

#[test]
fn soap_fault_becomes_a_upnp_error_with_code_and_description() {
    let xml = "<s:Envelope xmlns:s=\"x\"><s:Body><s:Fault><faultcode>s:Client</faultcode>\
        <detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>710</errorCode>\
        <errorDescription>Seek mode not supported</errorDescription></UPnPError></detail>\
        </s:Fault></s:Body></s:Envelope>";
    match parse_soap_response(xml) {
        Err(CastError::Upnp { code, description }) => {
            assert_eq!(code, "710");
            assert_eq!(description, "Seek mode not supported");
        }
        other => panic!("expected a UPnP error, got {other:?}"),
    }
}

#[test]
fn soap_response_rejects_garbage() {
    assert!(parse_soap_response("").is_err());
    assert!(parse_soap_response("<html><body>nope</body></html>").is_err());
}

#[test]
fn time_formatting_and_parsing() {
    assert_eq!(format_upnp_time(0.0), "0:00:00");
    assert_eq!(format_upnp_time(80.4), "0:01:20");
    assert_eq!(format_upnp_time(3725.0), "1:02:05");
    assert_eq!(format_upnp_time(-5.0), "0:00:00");
    assert_eq!(parse_upnp_time("0:01:20"), Some(80.0));
    assert_eq!(parse_upnp_time("01:02:05"), Some(3725.0));
    assert_eq!(parse_upnp_time("0:00:01.500"), Some(1.5));
    assert_eq!(parse_upnp_time("NOT_IMPLEMENTED"), None);
    assert_eq!(parse_upnp_time("0:61:00"), None);
    assert_eq!(parse_upnp_time("1:2"), None);
    assert_eq!(parse_upnp_time("1:2:3:4"), None);
}

#[test]
fn msearch_is_a_valid_ssdp_request() {
    let m = build_msearch(ST_MEDIA_RENDERER, 2);
    assert!(m.starts_with("M-SEARCH * HTTP/1.1\r\n"));
    assert!(m.contains("HOST: 239.255.255.250:1900\r\n"));
    assert!(m.contains("MAN: \"ssdp:discover\"\r\n"));
    assert!(m.contains("ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n"));
    assert!(m.ends_with("\r\n\r\n"));
}

#[test]
fn ssdp_headers_are_lowercased() {
    let h = parse_ssdp_headers(
        "HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.247:1670/description.xml\r\nST: upnp:rootdevice\r\nUSN: uuid:1\r\n\r\n",
    );
    assert_eq!(h["location"], "http://192.168.1.247:1670/description.xml");
    assert_eq!(h["st"], "upnp:rootdevice");
}

const DESCRIPTION: &str = "<?xml version=\"1.0\"?>\
<root xmlns=\"urn:schemas-upnp-org:device-1-0\"><specVersion><major>1</major><minor>0</minor></specVersion>\
<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>\
<friendlyName>PLAY &amp; Co</friendlyName><manufacturer>EVERSOLO</manufacturer>\
<modelName>AV Renderer Device</modelName><UDN>uuid:0311878C-0000</UDN><serviceList>\
<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>\
<serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>\
<controlURL>/RenderingControl/x/control.xml</controlURL><eventSubURL>/e</eventSubURL><SCPDURL>/s</SCPDURL></service>\
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>\
<controlURL>/ConnectionManager/x/control.xml</controlURL></service>\
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\
<controlURL>/AVTransport/x/control.xml</controlURL></service>\
</serviceList></device></root>";

#[test]
fn description_yields_renderer_with_absolute_control_urls() {
    let r = parse_description(DESCRIPTION, "http://192.168.1.247:1670/description.xml").unwrap().unwrap();
    assert_eq!(r.id, "uuid:0311878C-0000");
    assert_eq!(r.name, "PLAY & Co");
    assert_eq!(r.manufacturer, "EVERSOLO");
    assert_eq!(r.model, "AV Renderer Device");
    assert_eq!(r.av_control_url, "http://192.168.1.247:1670/AVTransport/x/control.xml");
    assert_eq!(r.av_service_type, "urn:schemas-upnp-org:service:AVTransport:1");
    assert_eq!(r.rc_control_url.as_deref(), Some("http://192.168.1.247:1670/RenderingControl/x/control.xml"));
}

#[test]
fn description_honours_url_base() {
    let xml = DESCRIPTION.replace("<specVersion>", "<URLBase>http://192.168.1.5:9000/</URLBase><specVersion>");
    let r = parse_description(&xml, "http://192.168.1.247:1670/description.xml").unwrap().unwrap();
    assert_eq!(r.av_control_url, "http://192.168.1.5:9000/AVTransport/x/control.xml");
}

#[test]
fn description_without_avtransport_is_not_a_renderer() {
    let xml = "<root xmlns=\"urn:schemas-upnp-org:device-1-0\"><device><friendlyName>Sub</friendlyName>\
        <serviceList><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>\
        <controlURL>/rc</controlURL></service></serviceList></device></root>";
    assert!(parse_description(xml, "http://192.168.1.2:1400/d.xml").unwrap().is_none());
}

#[test]
fn only_local_network_http_urls_are_accepted() {
    for ok in ["http://192.168.1.247:1670/x", "http://10.0.0.5/x", "http://172.16.3.4/x", "http://127.0.0.1:8000/x",
               "http://169.254.1.1/x", "http://[fd00::1]/x", "http://[fe80::1]/x"] {
        assert!(ensure_lan_http_url(ok).is_ok(), "{ok} should be allowed");
    }
    for bad in ["http://8.8.8.8/x", "http://192.168.1.247.evil.example/x", "http://localhost/x", "https://192.168.1.1/x",
                "file:///etc/passwd", "ftp://192.168.1.1/", "not a url", "http://[2001:db8::1]/x", "http://172.32.0.1/x"] {
        assert!(ensure_lan_http_url(bad).is_err(), "{bad} should be rejected");
    }
}

#[test]
fn media_urls_must_be_http() {
    assert!(ensure_http_media_url("https://music.example.com/rest/stream.view?id=1").is_ok());
    assert!(ensure_http_media_url("http://192.168.1.10/a").is_ok());
    assert!(ensure_http_media_url("file:///C:/a.mp3").is_err());
    assert!(ensure_http_media_url("STREAM_URL").is_err());
}
