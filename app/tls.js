// Certificate checks beyond Chromium's own, for setCertificateVerifyProc.
//
// In order, for a certificate Chromium rejects:
// 1. A host in tls.insecure is accepted whatever it shows.
// 2. A chain that leads to a certificate from tls.ca is accepted, if every
//    certificate is in date and the first one names the host.
// 3. A host in tls.pin trusts the first certificate it shows in this run, and
//    rejects any other until the pins are cleared (Ctrl+Alt+Shift+R).
// Anything else, and anything Chromium accepts, keeps Chromium's verdict.
const { X509Certificate } = require('crypto');
const net = require('net');
const origins = require('./origins');

const ACCEPT = 0;
const REJECT = -2;
const CHROMIUM = -3;

function x509(pem) {
  try { return new X509Certificate(pem); } catch { return null; }
}

function inDate(cert, now) {
  return cert.validFromDate <= now && now <= cert.validToDate;
}

// cert is Electron's Certificate: PEM in .data, its issuer in .issuerCert.
function chainOf(cert) {
  const chain = [];
  for (let c = cert; c && chain.length < 10; c = c.issuerCert) {
    const x = x509(c.data);
    if (!x) return null;
    chain.push(x);
  }
  return chain;
}

function trustedByCa(cert, hostname, cas, now = new Date()) {
  if (!cas.length) return false;
  const chain = chainOf(cert);
  if (!chain || !chain.length) return false;
  const leaf = chain[0];
  const named = net.isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname);
  if (!named) return false;
  for (let i = 0; i < chain.length; i += 1) {
    const c = chain[i];
    if (!inDate(c, now)) return false;
    const ca = cas.find((a) => c.checkIssued(a) && c.verify(a.publicKey));
    if (ca) return inDate(ca, now);
    const next = chain[i + 1];
    if (!next || !next.ca || !c.checkIssued(next) || !c.verify(next.publicKey)) return false;
  }
  return false;
}

// tlsPolicy: { pin: host patterns, ca: [{ pem }], insecure: host patterns }.
function verifier(tlsPolicy) {
  const cas = tlsPolicy.ca.map((c) => x509(c.pem)).filter(Boolean);
  const pins = new Map(); // host -> fingerprint
  const changed = new Set(); // hosts whose certificate differs from the pin
  // How each host's certificate was last accepted, for the bar's security chip:
  // verified (by Chromium or a tls.ca), pinned, or insecure (not checked).
  const trust = new Map();

  function verify(request, callback) {
    const { hostname, certificate, verificationResult } = request;
    if (verificationResult === 'net::OK') { trust.set(hostname, 'verified'); callback(CHROMIUM); return; }
    if (tlsPolicy.insecure.some((p) => origins.hostMatches(p, hostname))) { trust.set(hostname, 'insecure'); callback(ACCEPT); return; }
    if (trustedByCa(certificate, hostname, cas)) { trust.set(hostname, 'verified'); callback(ACCEPT); return; }
    if (tlsPolicy.pin.some((p) => origins.hostMatches(p, hostname))) {
      if (!pins.has(hostname)) pins.set(hostname, certificate.fingerprint);
      if (pins.get(hostname) === certificate.fingerprint) {
        changed.delete(hostname);
        trust.set(hostname, 'pinned');
        callback(ACCEPT);
      } else {
        changed.add(hostname);
        trust.delete(hostname);
        callback(REJECT);
      }
      return;
    }
    callback(CHROMIUM);
  }

  return {
    verify,
    changed: (hostname) => changed.has(hostname),
    trust: (hostname) => trust.get(hostname) || null,
    clear: () => { pins.clear(); changed.clear(); trust.clear(); },
  };
}

module.exports = { verifier, trustedByCa, ACCEPT, REJECT, CHROMIUM };
