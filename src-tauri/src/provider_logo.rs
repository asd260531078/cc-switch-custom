//! Untrusted website logos: public HTTPS only, bounded raster decoding, local PNG cache.
//! This client is deliberately independent of all provider/model/usage HTTP clients.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageFormat, ImageReader, Limits};
use reqwest::{header, redirect::Policy, Client, Response, StatusCode};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tokio::sync::Semaphore;
use url::{Host, Url};

const MAX_URL_CHARS: usize = 2048;
const MAX_DOWNLOAD_BYTES: usize = 2 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 512 * 1024;
const MAX_DIMENSION: u32 = 2048;
const THUMBNAIL_SIZE: u32 = 256;
const MAX_REDIRECTS: usize = 3;
const LOAD_TIMEOUT: Duration = Duration::from_secs(12);
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_CACHE_FILES: usize = 128;
static LOAD_SLOTS: Semaphore = Semaphore::const_new(4);

// Do not attach underlying errors: network errors can contain signed URL queries.
type LogoResult<T> = Result<T, &'static str>;

pub(crate) fn validate_icon_url(raw: &str) -> LogoResult<Url> {
    if raw.is_empty()
        || raw.chars().count() > MAX_URL_CHARS
        || raw
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err("Invalid logo URL");
    }
    let url = Url::parse(raw).map_err(|_| "Invalid logo URL")?;
    let authority = raw
        .split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default());
    if url.scheme() != "https"
        || authority.is_none_or(|value| value.contains('@'))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default().is_none_or(|port| port == 0)
    {
        return Err("Logo URL must use HTTPS without credentials");
    }
    match url.host().ok_or("Logo URL has no host")? {
        Host::Ipv4(ip) if !is_public_ip(ip.into()) => return Err("Non-public logo host"),
        Host::Ipv6(ip) if !is_public_ip(ip.into()) => return Err("Non-public logo host"),
        Host::Domain(host) => {
            let host = host.trim_end_matches('.');
            if !host.contains('.')
                || ["localhost", "local", "internal", "home", "lan", "invalid"]
                    .iter()
                    .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
            {
                return Err("Non-public logo host");
            }
        }
        _ => {}
    }
    Ok(url)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Only global unicast. Exclude special-use, documentation and tunnelling
            // ranges as well (including IPv4-mapped/compatible and NAT64 addresses).
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

fn validate_addresses(addresses: &[SocketAddr]) -> LogoResult<()> {
    if addresses.is_empty() || addresses.iter().any(|addr| !is_public_ip(addr.ip())) {
        return Err("Logo DNS returned a non-public address");
    }
    Ok(())
}

fn logo_client(url: &Url, addresses: &[SocketAddr]) -> LogoResult<Client> {
    validate_addresses(addresses)?;
    Client::builder()
        .use_rustls_tls()
        .https_only(true)
        // Never inherit app/system proxy credentials or let a proxy re-resolve the host.
        // This is per client and does not change any OS/VPN/proxy settings.
        .no_proxy()
        .redirect(Policy::none())
        .referer(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .resolve_to_addrs(url.host_str().ok_or("Logo URL has no host")?, addresses)
        .build()
        .map_err(|_| "Could not create logo client")
}

fn logo_request(client: &Client, url: &Url) -> reqwest::RequestBuilder {
    // No API key, Authorization, Cookie, Referer or provider state enters this path.
    client
        .get(url.clone())
        .header(
            header::ACCEPT,
            "image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon",
        )
        .header(header::ACCEPT_ENCODING, "identity")
}

// This small transport seam lets tests exercise the entire redirect/DNS/body policy
// without granting any test-only exception to the production public-IP checks.
trait LogoTransport {
    async fn resolve(&self, url: &Url) -> LogoResult<Vec<SocketAddr>>;
    async fn get(&self, url: &Url, addresses: &[SocketAddr]) -> LogoResult<Response>;
}

struct HttpsTransport;

impl LogoTransport for HttpsTransport {
    async fn resolve(&self, url: &Url) -> LogoResult<Vec<SocketAddr>> {
        let port = url.port_or_known_default().ok_or("Invalid logo port")?;
        match url.host().ok_or("Logo URL has no host")? {
            Host::Ipv4(ip) => Ok(vec![SocketAddr::new(ip.into(), port)]),
            Host::Ipv6(ip) => Ok(vec![SocketAddr::new(ip.into(), port)]),
            Host::Domain(host) => tokio::net::lookup_host((host, port))
                .await
                .map(|addresses| addresses.collect())
                .map_err(|_| "Logo DNS lookup failed"),
        }
    }

    async fn get(&self, url: &Url, addresses: &[SocketAddr]) -> LogoResult<Response> {
        let client = logo_client(url, addresses)?;
        let response = logo_request(&client, url)
            .send()
            .await
            .map_err(|_| "Logo download failed")?;
        // Defense in depth: the socket must match the address set we just vetted.
        if response
            .remote_addr()
            .is_none_or(|peer| !addresses.contains(&peer))
        {
            return Err("Logo peer address mismatch");
        }
        Ok(response)
    }
}

fn image_format(content_type: &str) -> LogoResult<ImageFormat> {
    match content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Ok(ImageFormat::Png),
        "image/jpeg" => Ok(ImageFormat::Jpeg),
        "image/webp" => Ok(ImageFormat::WebP),
        "image/gif" => Ok(ImageFormat::Gif),
        "image/x-icon" | "image/vnd.microsoft.icon" => Ok(ImageFormat::Ico),
        _ => Err("Unsupported logo image type"),
    }
}

async fn download_logo(
    transport: &impl LogoTransport,
    raw: &str,
) -> LogoResult<(Vec<u8>, ImageFormat)> {
    let mut url = validate_icon_url(raw)?;
    for hop in 0..=MAX_REDIRECTS {
        // Validate EVERY answer, then pin it for this hop. Never re-resolve in HTTP.
        let addresses = transport.resolve(&url).await?;
        validate_addresses(&addresses)?;
        let mut response = transport.get(&url, &addresses).await?;
        if matches!(
            response.status(),
            StatusCode::MOVED_PERMANENTLY
                | StatusCode::FOUND
                | StatusCode::SEE_OTHER
                | StatusCode::TEMPORARY_REDIRECT
                | StatusCode::PERMANENT_REDIRECT
        ) {
            if hop == MAX_REDIRECTS {
                return Err("Too many logo redirects");
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("Missing logo redirect")?;
            if location.len() > MAX_URL_CHARS
                || location
                    .chars()
                    .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
            {
                return Err("Invalid logo redirect");
            }
            let next = url.join(location).map_err(|_| "Invalid logo redirect")?;
            url = validate_icon_url(next.as_str())?;
            continue;
        }
        if !response.status().is_success() {
            return Err("Logo server returned an error");
        }
        if response
            .headers()
            .get(header::CONTENT_ENCODING)
            .is_some_and(|value| !value.as_bytes().eq_ignore_ascii_case(b"identity"))
        {
            return Err("Compressed logo transfer is not supported");
        }
        let format = image_format(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .ok_or("Missing logo image type")?,
        )?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_DOWNLOAD_BYTES as u64)
        {
            return Err("Logo download is too large");
        }
        if let Some(declared) = response.headers().get(header::CONTENT_LENGTH) {
            let size = declared
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or("Invalid logo content length")?;
            if size > MAX_DOWNLOAD_BYTES as u64 {
                return Err("Logo download is too large");
            }
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Logo body download failed")?
        {
            if chunk.len() > MAX_DOWNLOAD_BYTES - bytes.len() {
                return Err("Logo download is too large");
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((bytes, format));
    }
    Err("Too many logo redirects")
}

fn sanitize_image(bytes: &[u8], format: ImageFormat) -> LogoResult<Vec<u8>> {
    if bytes.len() > MAX_DOWNLOAD_BYTES || image::guess_format(bytes).ok() != Some(format) {
        return Err("Logo content does not match its image type");
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| "Invalid or oversized logo image")?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err("Empty logo image");
    }
    // Re-encode pixels only: no HTML/SVG, animation, source metadata or ancillary chunks.
    let pixels = decoded.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE).to_rgba8();
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(pixels)
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| "Could not encode logo")?;
    let png = output.into_inner();
    if png.len() > MAX_CACHE_BYTES {
        return Err("Logo cache image is too large");
    }
    Ok(png)
}

fn cache_file(root: &Path, original_url: &str) -> PathBuf {
    // Hash the exact original URL, including case and query. Never hash the endpoint,
    // provider name, redirect destination, or hostname alone.
    root.join(format!("{:x}.png", Sha256::digest(original_url.as_bytes())))
}

fn read_cached_png(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file()
        || meta.len() > MAX_CACHE_BYTES as u64
        || meta.modified().ok()?.elapsed().ok()? > CACHE_TTL
    {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_CACHE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_CACHE_BYTES {
        return None;
    }
    sanitize_image(&bytes, ImageFormat::Png).ok()
}

fn write_cached_png(root: &Path, path: &Path, png: &[u8]) -> LogoResult<()> {
    std::fs::create_dir_all(root).map_err(|_| "Logo cache is unavailable")?;
    let mut file =
        tempfile::NamedTempFile::new_in(root).map_err(|_| "Logo cache is unavailable")?;
    file.write_all(png)
        .map_err(|_| "Could not write logo cache")?;
    file.persist(path)
        .map_err(|_| "Could not save logo cache")?;
    // Bound retained cache files. Only this module's hash filenames are eligible.
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut files: Vec<_> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_str()?;
                if name.len() != 68
                    || !name.ends_with(".png")
                    || !name.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit)
                {
                    return None;
                }
                let meta = entry.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                Some((
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    entry.path(),
                ))
            })
            .collect();
        files.sort_by_key(|(modified, _)| *modified);
        let excess = files.len().saturating_sub(MAX_CACHE_FILES);
        for (_, old) in files.into_iter().take(excess) {
            if old != path {
                let _ = std::fs::remove_file(old);
            }
        }
    }
    Ok(())
}

async fn load_logo(root: PathBuf, original_url: String) -> LogoResult<String> {
    validate_icon_url(&original_url)?;
    let permit = LOAD_SLOTS
        .acquire()
        .await
        .map_err(|_| "Logo loader unavailable")?;
    let path = cache_file(&root, &original_url);
    let cached_path = path.clone();
    if let Some(png) = tokio::task::spawn_blocking(move || read_cached_png(&cached_path))
        .await
        .map_err(|_| "Logo cache read failed")?
    {
        return Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)));
    }
    let (bytes, format) = download_logo(&HttpsTransport, &original_url).await?;
    // Keep the slot until CPU/file work finishes, even if the waiting IPC times out.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let png = sanitize_image(&bytes, format)?;
        write_cached_png(&root, &path, &png)?;
        Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)))
    })
    .await
    .map_err(|_| "Logo processing failed")?
}

pub(crate) async fn cached_logo(root: PathBuf, original_url: String) -> Option<String> {
    // Includes queueing, DNS, every redirect and streaming. Failure is presentation only.
    tokio::time::timeout(LOAD_TIMEOUT, load_logo(root, original_url))
        .await
        .ok()?
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    fn raster(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        let image = if format == ImageFormat::Ico {
            image::DynamicImage::new_rgba8(width, height)
        } else {
            image::DynamicImage::new_rgb8(width, height)
        };
        image.write_to(&mut output, format).unwrap();
        output.into_inner()
    }

    fn response(status: u16, headers: &[(&str, &str)], body: impl Into<reqwest::Body>) -> Response {
        let mut builder = http::Response::builder().status(status);
        for (key, value) in headers {
            builder = builder.header(*key, *value);
        }
        builder.body(body.into()).unwrap().into()
    }

    struct FakeTransport {
        answers: Mutex<VecDeque<Vec<SocketAddr>>>,
        responses: Mutex<VecDeque<Response>>,
        resolved: Mutex<Vec<String>>,
        requested: Mutex<Vec<(String, Vec<SocketAddr>)>>,
    }

    impl FakeTransport {
        fn new(responses: Vec<Response>) -> Self {
            Self {
                answers: Mutex::new(VecDeque::new()),
                responses: Mutex::new(responses.into()),
                resolved: Mutex::new(Vec::new()),
                requested: Mutex::new(Vec::new()),
            }
        }
    }

    impl LogoTransport for FakeTransport {
        async fn resolve(&self, url: &Url) -> LogoResult<Vec<SocketAddr>> {
            self.resolved
                .lock()
                .unwrap()
                .push(url.host_str().unwrap().to_owned());
            Ok(self
                .answers
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| vec!["8.8.8.8:443".parse().unwrap()]))
        }

        async fn get(&self, url: &Url, addresses: &[SocketAddr]) -> LogoResult<Response> {
            self.requested
                .lock()
                .unwrap()
                .push((url.to_string(), addresses.to_vec()));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or("Missing test response")
        }
    }

    #[test]
    fn only_absolute_credential_free_public_https_urls_are_accepted() {
        for value in [
            "",
            "/Logo.png",
            "http://example.com/logo",
            "file:///logo",
            "data:image/png,x",
            "https://user:pass@example.com/logo",
            "https://@example.com/logo",
            "https://localhost/a",
            "https://sub.localhost./a",
            "https://printer.local/a",
            "https://intranet/a",
            "https://127.1/a",
            "https://0x7f000001/a",
            "https://2130706433/a",
            "https://[::ffff:127.0.0.1]/a",
            "https://[::1]/a",
            "https://[fc00::1]/a",
            "https://192.168.1.1/a",
            "https://169.254.169.254/latest/meta-data",
            "https://example.com:0/a",
            " https://example.com/a",
            "https://example.com/lo\ngo",
            "https://example.com\\a",
        ] {
            assert!(validate_icon_url(value).is_err(), "accepted {value:?}");
        }
        let exact = format!("https://example.com/{}", "A".repeat(2028));
        assert_eq!(exact.len(), 2048);
        assert!(validate_icon_url(&exact).is_ok());
        assert!(validate_icon_url(&(exact + "B")).is_err());
        for value in [
            "https://custom-site.example:8443/Logo.PNG?Token=AbC%2FDeF+X",
            "https://8.8.8.8/a",
            "https://[2606:4700:4700::1111]/a",
        ] {
            assert!(validate_icon_url(value).is_ok(), "rejected {value}");
        }
    }

    #[test]
    fn reserved_private_documentation_multicast_and_tunnel_ips_are_rejected() {
        for ip in [
            "0.0.0.0",
            "0.1.2.3",
            "10.1.2.3",
            "100.64.0.1",
            "100.127.255.254",
            "127.0.0.2",
            "169.254.1.2",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.0.1",
            "192.0.0.9",
            "192.0.2.1",
            "192.88.99.1",
            "198.18.0.1",
            "198.19.255.254",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:8.8.8.8",
            "64:ff9b::a00:1",
            "64:ff9b:1::1",
            "fe80::1",
            "fc00::1",
            "ff02::1",
            "2001::1",
            "2001:2::1",
            "2001:db8::1",
            "2002:a00:1::1",
            "3fff::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "accepted {ip}");
        }
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1",
            "100.128.0.1",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            assert!(is_public_ip(ip.parse().unwrap()), "rejected {ip}");
        }
    }

    #[tokio::test]
    async fn redirect_pipeline_checks_each_host_and_pins_each_dns_answer() {
        let original = "https://main.example/Logo.PNG?Token=AbC%2FDeF+X";
        let redirected = "https://cdn.example/Asset.PNG?Signature=aB%252FZ";
        let transport = FakeTransport::new(vec![
            response(
                302,
                &[
                    ("location", redirected),
                    ("set-cookie", "session=must-not-follow"),
                ],
                "",
            ),
            response(
                200,
                &[("content-type", "image/png")],
                raster(ImageFormat::Png, 2, 2),
            ),
        ]);
        transport.answers.lock().unwrap().extend([
            vec!["8.8.8.8:443".parse().unwrap()],
            vec!["1.1.1.1:443".parse().unwrap()],
        ]);
        let (bytes, format) = download_logo(&transport, original).await.unwrap();
        assert!(sanitize_image(&bytes, format).is_ok());
        assert_eq!(
            *transport.resolved.lock().unwrap(),
            ["main.example", "cdn.example"]
        );
        let requested = transport.requested.lock().unwrap();
        assert_eq!(
            requested[0],
            (original.into(), vec!["8.8.8.8:443".parse().unwrap()])
        );
        assert_eq!(
            requested[1],
            (redirected.into(), vec!["1.1.1.1:443".parse().unwrap()])
        );
    }

    #[tokio::test]
    async fn dns_private_mixed_empty_and_rebinding_answers_never_reach_http() {
        for addresses in [
            vec![],
            vec!["127.0.0.1:443"],
            vec!["8.8.8.8:443", "10.0.0.1:443"],
            vec!["[fc00::1]:443"],
        ] {
            let transport =
                FakeTransport::new(vec![response(302, &[("location", "/next.png")], "")]);
            transport.answers.lock().unwrap().extend([
                vec!["8.8.8.8:443".parse().unwrap()],
                addresses.iter().map(|addr| addr.parse().unwrap()).collect(),
            ]);
            assert!(download_logo(&transport, "https://rebind.example/a")
                .await
                .is_err());
            assert_eq!(transport.requested.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn unsafe_redirects_and_redirect_loops_fail_closed() {
        for target in [
            "http://example.com/a",
            "https://user:pass@example.com/a",
            "https://127.0.0.1/a",
            "//[::1]/a",
            "file:///a",
            "https://foo.local/a",
            "https://example.com\\a",
        ] {
            let transport = FakeTransport::new(vec![response(301, &[("location", target)], "")]);
            assert!(
                download_logo(&transport, "https://example.com/a")
                    .await
                    .is_err(),
                "followed {target}"
            );
            assert_eq!(transport.requested.lock().unwrap().len(), 1);
        }
        let transport = FakeTransport::new(
            (0..4)
                .map(|_| response(307, &[("location", "/again")], ""))
                .collect(),
        );
        assert_eq!(
            download_logo(&transport, "https://example.com/a")
                .await
                .unwrap_err(),
            "Too many logo redirects"
        );
        assert_eq!(transport.requested.lock().unwrap().len(), MAX_REDIRECTS + 1);
    }

    #[test]
    fn request_contains_only_logo_headers_and_no_credentials() {
        let url = validate_icon_url("https://logo.example/Logo.PNG?Token=Case%2FKeep").unwrap();
        let client = logo_client(&url, &["8.8.8.8:443".parse().unwrap()]).unwrap();
        let request = logo_request(&client, &url).build().unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(request.url().as_str(), url.as_str());
        assert_eq!(request.headers().len(), 2);
        for key in [
            "authorization",
            "cookie",
            "proxy-authorization",
            "x-api-key",
            "referer",
        ] {
            assert!(!request.headers().contains_key(key));
        }
        assert_eq!(request.headers()[header::ACCEPT_ENCODING], "identity");
    }

    #[tokio::test]
    async fn validates_status_mime_transfer_encoding_and_declared_size() {
        let oversized = (MAX_DOWNLOAD_BYTES + 1).to_string();
        for reply in [
            response(404, &[("content-type", "image/png")], ""),
            response(200, &[("content-type", "text/html")], "<img src=x>"),
            response(
                200,
                &[("content-type", "image/svg+xml")],
                "<svg onload='alert(1)'/>",
            ),
            response(200, &[], ""),
            response(
                200,
                &[("content-type", "image/png"), ("content-encoding", "gzip")],
                "",
            ),
            response(
                200,
                &[
                    ("content-type", "image/png"),
                    ("content-length", &oversized),
                ],
                "",
            ),
        ] {
            assert!(
                download_logo(&FakeTransport::new(vec![reply]), "https://example.com/a")
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn chunked_body_limit_and_slow_body_timeout_are_enforced() {
        let chunks = futures::stream::iter([
            Ok::<_, std::io::Error>(vec![0u8; MAX_DOWNLOAD_BYTES]),
            Ok(vec![0u8]),
        ]);
        let transport = FakeTransport::new(vec![response(
            200,
            &[("content-type", "image/png")],
            reqwest::Body::wrap_stream(chunks),
        )]);
        assert_eq!(
            download_logo(&transport, "https://example.com/a")
                .await
                .unwrap_err(),
            "Logo download is too large"
        );
        let never = futures::stream::pending::<Result<Vec<u8>, std::io::Error>>();
        let transport = FakeTransport::new(vec![response(
            200,
            &[("content-type", "image/png")],
            reqwest::Body::wrap_stream(never),
        )]);
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            download_logo(&transport, "https://example.com/a")
        )
        .await
        .is_err());
    }

    #[test]
    fn raster_types_decode_to_bounded_png_and_malicious_or_broken_content_falls_back() {
        for format in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::Gif,
            ImageFormat::WebP,
            ImageFormat::Ico,
        ] {
            let png = sanitize_image(&raster(format, 2, 2), format).unwrap();
            assert_eq!(image::guess_format(&png).unwrap(), ImageFormat::Png);
        }
        for bytes in [
            b"<svg onload='alert(1)'/>".as_slice(),
            b"<html><script>alert(1)</script>",
            b"\x89PNG\r\n\x1a\n",
        ] {
            assert!(sanitize_image(bytes, ImageFormat::Png).is_err());
        }
        assert!(sanitize_image(&raster(ImageFormat::Png, 1, 1), ImageFormat::Jpeg).is_err());
        assert!(sanitize_image(
            &raster(ImageFormat::Png, MAX_DIMENSION + 1, 1),
            ImageFormat::Png
        )
        .is_err());
        let png = sanitize_image(&raster(ImageFormat::Png, 512, 512), ImageFormat::Png).unwrap();
        let thumbnail = image::load_from_memory(&png).unwrap();
        assert_eq!((thumbnail.width(), thumbnail.height()), (256, 256));
    }

    #[tokio::test]
    async fn cache_uses_full_url_survives_reload_and_handles_corruption_and_write_failure() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .join("缓存 with spaces")
            .join("provider-logos-v1");
        let urls = [
            "https://main.example/Logo.PNG?Token=AbC",
            "https://branch-a.example/Logo.PNG?Token=AbC",
            "https://branch-b.example/Logo.PNG?Token=AbC",
            "https://custom.example/Logo.PNG?Token=AbC",
            "https://main.example/logo.png?Token=AbC",
            "https://main.example/Logo.PNG?Token=abc",
        ];
        let png = raster(ImageFormat::Png, 2, 2);
        for url in urls {
            let file = cache_file(&root, url);
            write_cached_png(&root, &file, &png).unwrap();
            write_cached_png(&root, &file, &png).unwrap(); // Windows/macOS replacement
            assert!(cached_logo(root.clone(), url.to_owned())
                .await
                .unwrap()
                .starts_with("data:image/png;base64,iVBORw0KGgo"));
        }
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), urls.len());
        let file = cache_file(&root, urls[0]);
        std::fs::write(&file, "<svg onload='alert(1)'/>").unwrap();
        assert!(read_cached_png(&file).is_none());
        write_cached_png(&root, &file, &png).unwrap();
        // Windows requires a writable handle to update the modification time.
        std::fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(SystemTime::now() - CACHE_TTL - Duration::from_secs(1))
            .unwrap();
        assert!(read_cached_png(&file).is_none());
        let bad_root = dir.path().join("not-a-directory");
        std::fs::write(&bad_root, "x").unwrap();
        assert!(write_cached_png(&bad_root, &cache_file(&bad_root, urls[0]), &png).is_err());
        assert!(cached_logo(root, "https://127.0.0.1/logo".into())
            .await
            .is_none());
    }

    #[test]
    fn cache_eviction_is_bounded_and_ignores_unrelated_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("keep.txt"), "unrelated").unwrap();
        // Deliberately place a multi-byte filename at the hash byte boundary.
        std::fs::write(root.join(format!("{}é.png", "a".repeat(62))), "unrelated").unwrap();
        let png = raster(ImageFormat::Png, 1, 1);
        for index in 0..MAX_CACHE_FILES + 2 {
            write_cached_png(
                root,
                &cache_file(root, &format!("https://example.com/{index}")),
                &png,
            )
            .unwrap();
        }
        assert_eq!(
            std::fs::read_dir(root).unwrap().count(),
            MAX_CACHE_FILES + 2
        );
        assert!(root.join("keep.txt").is_file());
    }
}
