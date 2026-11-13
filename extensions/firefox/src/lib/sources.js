/**
 * Public free-proxy lists (same defaults as the Android app). These are third-party lists of unvetted
 * open proxies: every entry is tested over HTTPS with certificate validation before it can be used.
 */
const GH = 'https://raw.githubusercontent.com';

export const DEFAULT_SOURCES = [
  { name: 'TheSpeedX SOCKS5', url: `${GH}/TheSpeedX/PROXY-List/master/socks5.txt`, protocol: 'socks5' },
  { name: 'TheSpeedX HTTP', url: `${GH}/TheSpeedX/PROXY-List/master/http.txt`, protocol: 'http' },
  { name: 'monosans SOCKS5', url: `${GH}/monosans/proxy-list/main/proxies/socks5.txt`, protocol: 'socks5' },
  { name: 'monosans HTTP', url: `${GH}/monosans/proxy-list/main/proxies/http.txt`, protocol: 'http' },
  { name: 'hookzof SOCKS5', url: `${GH}/hookzof/socks5_list/master/proxy.txt`, protocol: 'socks5' },
  { name: 'proxifly SOCKS5', url: `${GH}/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt`, protocol: 'socks5' },
  { name: 'proxifly HTTP', url: `${GH}/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt`, protocol: 'http' },
  { name: 'jetkai SOCKS5', url: `${GH}/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt`, protocol: 'socks5' },
  { name: 'jetkai HTTP', url: `${GH}/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt`, protocol: 'http' },
  { name: 'ShiftyTR SOCKS5', url: `${GH}/ShiftyTR/Proxy-List/master/socks5.txt`, protocol: 'socks5' },
  { name: 'clarketm HTTP', url: `${GH}/clarketm/proxy-list/master/proxy-list-raw.txt`, protocol: 'http' },
  { name: 'sunny9577 SOCKS5', url: `${GH}/sunny9577/proxy-scraper/master/generated/socks5_proxies.txt`, protocol: 'socks5' },
  { name: 'sunny9577 HTTP', url: `${GH}/sunny9577/proxy-scraper/master/generated/http_proxies.txt`, protocol: 'http' },
  { name: 'roosterkid HTTPS', url: `${GH}/roosterkid/openproxylist/main/HTTPS_RAW.txt`, protocol: 'http' },
  { name: 'hideip.me SOCKS5', url: `${GH}/zloi-user/hideip.me/main/socks5.txt`, protocol: 'socks5' },
  { name: 'hideip.me HTTPS', url: `${GH}/zloi-user/hideip.me/main/https.txt`, protocol: 'http' },
  { name: 'r00tee SOCKS5', url: `${GH}/r00tee/Proxy-List/main/Socks5.txt`, protocol: 'socks5' },
  { name: 'r00tee HTTPS', url: `${GH}/r00tee/Proxy-List/main/Https.txt`, protocol: 'http' },
];

/** Protocol for a custom source URL (by file name), defaulting to HTTP. */
export function guessProtocol(url) {
  return /socks/i.test(url) ? 'socks5' : 'http';
}

/**
 * Cloudflare-served HTTPS endpoints that answer /cdn-cgi/trace with the caller's IP and country.
 * Each host is a "test slot": while a proxy is being tested, the PAC script routes that one host
 * through the proxy under test, so several proxies can be tested in parallel. Hosts that do not
 * answer correctly from the user's network are dropped at calibration time.
 */
export const DEFAULT_TRACE_URLS = [
  'https://1.1.1.1/cdn-cgi/trace',
  'https://1.0.0.1/cdn-cgi/trace',
  'https://one.one.one.one/cdn-cgi/trace',
  'https://cloudflare-dns.com/cdn-cgi/trace',
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://cloudflare.com/cdn-cgi/trace',
  'https://speed.cloudflare.com/cdn-cgi/trace',
  'https://blog.cloudflare.com/cdn-cgi/trace',
  'https://developers.cloudflare.com/cdn-cgi/trace',
  'https://radar.cloudflare.com/cdn-cgi/trace',
  'https://workers.cloudflare.com/cdn-cgi/trace',
  'https://pages.cloudflare.com/cdn-cgi/trace',
  'https://community.cloudflare.com/cdn-cgi/trace',
  'https://dash.cloudflare.com/cdn-cgi/trace',
  'https://api.cloudflare.com/cdn-cgi/trace',
  'https://www.cloudflarestatus.com/cdn-cgi/trace',
];
