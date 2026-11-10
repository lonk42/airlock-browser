const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scratchDir = require('./scratch');
const { execFileSync } = require('child_process');
const origins = require('../app/origins');
const policy = require('../app/policy');
const tls = require('../app/tls');

// --- Origin patterns -----------------------------------------------------------

test('origin patterns match scheme, host and port', () => {
  const p = origins.parse('https://coder.example.lan');
  assert.ok(origins.matches(p, 'https://coder.example.lan/workspaces'));
  assert.ok(origins.matches(p, 'https://coder.example.lan:443/'));
  assert.ok(!origins.matches(p, 'http://coder.example.lan/'));
  assert.ok(!origins.matches(p, 'https://coder.example.lan:8443/'));
  assert.ok(!origins.matches(p, 'https://coder.example.lan.evil.com/'));
  assert.ok(!origins.matches(p, 'https://evilcoder.example.lan/'));
  assert.ok(origins.matches(origins.parse('https://localhost:3001'), 'https://localhost:3001/'));
  assert.ok(!origins.matches(origins.parse('https://localhost:3001'), 'https://localhost/'));
});

test('wildcards match subdomains at any depth but not the apex', () => {
  const p = origins.parse('https://*.coder.example.lan');
  assert.ok(origins.matches(p, 'https://desktop--main--ws1--alice.coder.example.lan/'));
  assert.ok(origins.matches(p, 'https://a.b.coder.example.lan/'));
  assert.ok(!origins.matches(p, 'https://coder.example.lan/'));
  assert.ok(!origins.matches(p, 'https://xcoder.example.lan/'));
});

test('bad patterns are rejected', () => {
  for (const bad of ['coder.lan', 'https://coder.lan/path', 'https://a*.lan', 'https://*', 'ftp://x.lan', 'https://*.*.lan']) {
    assert.throws(() => origins.parse(bad), origins.PatternError, bad);
  }
  assert.throws(() => origins.parseHostPattern('a*.lan'), origins.PatternError);
});

test('host patterns accept a bare host or an origin', () => {
  assert.ok(origins.hostMatches(origins.parseHostPattern('*.coder.lan'), 'x.coder.lan'));
  assert.ok(origins.hostMatches(origins.parseHostPattern('https://legacy.lan:8443'), 'legacy.lan'));
});

test('isWeb only allows http and https', () => {
  assert.ok(origins.isWeb('https://x.lan/'));
  for (const u of ['file:///etc/passwd', 'smb://x/share', 'javascript:alert(1)', 'mailto:a@b', 'nonsense']) assert.ok(!origins.isWeb(u), u);
});

// --- Policy sections -----------------------------------------------------------

test('navigation and tls parse, with CA files relative to the config', () => {
  const dir = scratchDir('airlock-browser-tlsconf-');
  fs.writeFileSync(path.join(dir, 'ca.pem'), `junk\n${PEM_A}\n${PEM_A}\n`);
  fs.writeFileSync(path.join(dir, 'k.yaml'), `
version: 1
navigation:
  allow: [https://docs.lan]
  auth: [https://login.microsoftonline.com]
  desktops: [https://*.coder.lan]
  offsite: block
tls:
  pin: [legacy.lan]
  ca: [ca.pem]
  insecure: [https://old.lan]
`);
  const p = policy.load(['airlock-browser', '--config', path.join(dir, 'k.yaml')]);
  assert.equal(p.navigation.offsite, 'block');
  assert.equal(p.navigation.desktops[0].text, 'https://*.coder.lan');
  assert.equal(p.tls.ca.length, 2);
  assert.equal(p.tls.ca[0].file, path.join(dir, 'ca.pem'));
  assert.equal(p.tls.insecure[0].host, 'old.lan');
});

test('navigation and tls defaults', () => {
  assert.equal(policy.defaults(false).navigation.offsite, 'browser');
  assert.equal(policy.defaults(true).navigation.offsite, 'block');
  assert.equal(policy.defaults(false).navigation.desktops, null);
  assert.equal(policy.defaults(false).tls.pin, null);
});

test('navigation and tls mistakes are errors', () => {
  const fails = (text, re) => assert.throws(() => policy.parse(text), re);
  fails('version: 1\nnavigation: {allow: [coder.lan]}', /navigation.allow.0: coder.lan: use scheme/);
  fails('version: 1\nnavigation: {offsite: open}', /navigation.offsite: must be one of/);
  fails('version: 1\nnavigation: {allowed: []}', /navigation.allowed: unknown key/);
  fails('version: 1\ntls: {ca: [/nonexistent/ca.pem]}', /tls.ca.0: cannot read \/nonexistent\/ca.pem: no such file/);
  fails('version: 1\ntls: {insecure: [https://a.lan/path]}', /tls.insecure.0/);
});

// --- Certificates ----------------------------------------------------------------

const work = scratchDir('airlock-browser-certs-');
function openssl(...args) { execFileSync('openssl', args, { cwd: work, stdio: 'pipe' }); }
function read(f) { return fs.readFileSync(path.join(work, f), 'utf8'); }

// CA -> intermediate -> leaf for desktop.coder.lan, plus a stranger CA.
function makeCa(name, extra = []) {
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30',
    '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.pem`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', ...extra);
}
function makeCert(name, issuer, ext) {
  fs.writeFileSync(path.join(work, `${name}.ext`), ext);
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', `/CN=${name}`,
    '-keyout', `${name}.key`, '-out', `${name}.csr`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`,
    '-CAcreateserial', '-days', '10', '-extfile', `${name}.ext`, '-out', `${name}.pem`);
}
makeCa('root');
makeCa('stranger');
makeCert('inter', 'root', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n');
makeCert('leaf', 'inter', 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:desktop.coder.lan\n');
makeCert('direct', 'root', 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:*.coder.lan,IP:192.0.2.10\n');
const PEM_A = read('root.pem').trim();

// Electron's Certificate shape: PEM in data, issuer chain in issuerCert.
function electronCert(...names) {
  let cert;
  for (const n of names.reverse()) cert = { data: read(`${n}.pem`), fingerprint: `fp-${n}`, issuerCert: cert };
  return cert;
}
const caOf = (n) => [{ pem: read(`${n}.pem`) }];
const none = { pin: [], ca: [], insecure: [] };

function verdict(v, hostname, cert, result = 'net::ERR_CERT_AUTHORITY_INVALID') {
  let out;
  v.verify({ hostname, certificate: cert, verificationResult: result }, (r) => { out = r; });
  return out;
}

test('a chain through an intermediate to tls.ca is accepted', () => {
  const v = tls.verifier({ ...none, ca: caOf('root') });
  assert.equal(verdict(v, 'desktop.coder.lan', electronCert('leaf', 'inter')), tls.ACCEPT);
  assert.equal(verdict(v, 'desktop.coder.lan', electronCert('leaf', 'inter', 'root')), tls.ACCEPT);
});

test('a CA chain is refused for the wrong host, a missing intermediate or another CA', () => {
  const v = tls.verifier({ ...none, ca: caOf('root') });
  assert.equal(verdict(v, 'other.coder.lan', electronCert('leaf', 'inter')), tls.CHROMIUM);
  assert.equal(verdict(v, 'desktop.coder.lan', electronCert('leaf')), tls.CHROMIUM);
  const w = tls.verifier({ ...none, ca: caOf('stranger') });
  assert.equal(verdict(w, 'desktop.coder.lan', electronCert('leaf', 'inter')), tls.CHROMIUM);
});

test('wildcard and IP names in a CA-signed certificate', () => {
  const v = tls.verifier({ ...none, ca: caOf('root') });
  assert.equal(verdict(v, 'x.coder.lan', electronCert('direct')), tls.ACCEPT);
  assert.equal(verdict(v, '192.0.2.10', electronCert('direct')), tls.ACCEPT);
  assert.equal(verdict(v, 'a.b.coder.lan', electronCert('direct')), tls.CHROMIUM);
});

test('an expired certificate is refused even from the CA', () => {
  const later = new Date(Date.now() + 20 * 86400 * 1000);
  const ca = [new (require('crypto').X509Certificate)(read('root.pem'))];
  assert.equal(tls.trustedByCa(electronCert('leaf', 'inter'), 'desktop.coder.lan', ca), true);
  assert.equal(tls.trustedByCa(electronCert('leaf', 'inter'), 'desktop.coder.lan', ca, later), false);
});

test('pinning trusts the first certificate per host until cleared', () => {
  const v = tls.verifier({ ...none, pin: [origins.parseHostPattern('*.coder.lan')] });
  assert.equal(verdict(v, 'a.coder.lan', electronCert('leaf')), tls.ACCEPT);
  assert.equal(verdict(v, 'b.coder.lan', electronCert('direct')), tls.ACCEPT);
  assert.equal(verdict(v, 'a.coder.lan', electronCert('direct')), tls.REJECT);
  assert.ok(v.changed('a.coder.lan'));
  assert.ok(!v.changed('b.coder.lan'));
  v.clear();
  assert.equal(verdict(v, 'a.coder.lan', electronCert('direct')), tls.ACCEPT);
  assert.equal(verdict(v, 'elsewhere.lan', electronCert('leaf')), tls.CHROMIUM);
});

test('the verifier records how each host was trusted, for the security chip', () => {
  const v = tls.verifier({ ...none, pin: [origins.parseHostPattern('pinned.lan')], insecure: [origins.parseHostPattern('old.lan')] });
  assert.equal(v.trust('pinned.lan'), null);
  verdict(v, 'pinned.lan', electronCert('leaf'));
  verdict(v, 'old.lan', electronCert('leaf'));
  verdict(v, 'public.example', electronCert('leaf'), 'net::OK');
  assert.equal(v.trust('pinned.lan'), 'pinned');
  assert.equal(v.trust('old.lan'), 'insecure');
  assert.equal(v.trust('public.example'), 'verified');
  verdict(v, 'pinned.lan', electronCert('direct'));
  assert.equal(v.trust('pinned.lan'), null);
  assert.ok(v.changed('pinned.lan'));
  v.clear();
  assert.equal(v.trust('old.lan'), null);
});

test('insecure hosts accept anything; Chromium-approved certificates keep its verdict', () => {
  const v = tls.verifier({ ...none, insecure: [origins.parseHostPattern('old.lan')] });
  assert.equal(verdict(v, 'old.lan', electronCert('leaf')), tls.ACCEPT);
  assert.equal(verdict(v, 'new.lan', electronCert('leaf')), tls.CHROMIUM);
  assert.equal(verdict(v, 'new.lan', electronCert('leaf'), 'net::OK'), tls.CHROMIUM);
});
