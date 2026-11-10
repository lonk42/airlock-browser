// Origin patterns for navigation, permissions and TLS.
//
//   https://coder.example.lan       one origin (default port for the scheme)
//   https://coder.example.lan:8443  with a port
//   https://*.coder.example.lan     any subdomain, at any depth, not the apex
//
// TLS patterns name hosts only: the same forms without the scheme also work.

const DEFAULT_PORT = { 'https:': '443', 'http:': '80' };

class PatternError extends Error {}

function parseHost(host, raw) {
  const wildcard = host.startsWith('*.');
  const rest = wildcard ? host.slice(2) : host;
  if (!rest || rest.includes('*') || !/^[a-z0-9.[\]:-]+$/.test(rest)) {
    throw new PatternError(`${raw}: not a host name; only a leading "*." is allowed as a wildcard.`);
  }
  return { wildcard, host: rest };
}

// An origin pattern: scheme://host[:port], no path.
function parse(raw) {
  const text = String(raw).trim().toLowerCase();
  const m = /^(https?):\/\/([^/:]+|\[[^\]]+\])(?::(\d+))?\/?$/.exec(text);
  if (!m) throw new PatternError(`${raw}: use scheme://host or scheme://*.domain, with an optional :port and no path.`);
  const { wildcard, host } = parseHost(m[2], raw);
  const scheme = `${m[1]}:`;
  return { scheme, wildcard, host, port: m[3] || DEFAULT_PORT[scheme], text };
}

// A host pattern for TLS: host, *.domain, or an origin pattern (scheme and port ignored).
function parseHostPattern(raw) {
  const text = String(raw).trim().toLowerCase();
  if (/^https?:\/\//.test(text)) {
    const p = parse(text);
    return { wildcard: p.wildcard, host: p.host, text };
  }
  return { ...parseHost(text, raw), text };
}

function hostMatches(pattern, host) {
  const h = String(host).toLowerCase();
  return pattern.wildcard ? h.endsWith(`.${pattern.host}`) : h === pattern.host;
}

function toUrl(url) {
  if (url instanceof URL) return url;
  try { return new URL(url); } catch { return null; }
}

function matches(pattern, url) {
  const u = toUrl(url);
  if (!u || u.protocol !== pattern.scheme) return false;
  const port = u.port || DEFAULT_PORT[u.protocol];
  return port === pattern.port && hostMatches(pattern, u.hostname);
}

function matchesAny(patterns, url) {
  return patterns.some((p) => matches(p, url));
}

// The origin of an address as a pattern, for the defaults built from settings.url.
function fromUrl(url) {
  const u = new URL(url);
  return parse(`${u.protocol}//${u.host}`);
}

function isWeb(url) {
  const u = toUrl(url);
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
}

module.exports = { PatternError, parse, parseHostPattern, hostMatches, matches, matchesAny, fromUrl, isWeb };
