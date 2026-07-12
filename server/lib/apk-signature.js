// #device-owner: compute the AOSP provisioning SIGNATURE_CHECKSUM straight from the served
// APK, so the device-owner QR is ALWAYS correct for whatever build is on disk — no hardcoded
// value to drift when the signing key or APK changes.
//
// The checksum Android compares against is base64url(no-pad) of SHA-256 over the signing
// certificate's DER bytes. We pull that cert from the APK's v1 (JAR) signature block —
// META-INF/*.{RSA,DSA,EC}, a PKCS#7 SignedData — with a minimal definite-length DER walk
// (no openssl/keytool in the container, and no new dependency; unzipper is already a dep).
//
// v1 and v2/v3 sign with the same certificate for our builds, so the v1 cert yields the same
// checksum PackageManager reports from the v2 signer. Returns null on any parse failure so the
// caller can fall back to its configured constant rather than emit a wrong QR.

const crypto = require('crypto');
const fs = require('fs');
const unzipper = require('unzipper');

// Read one definite-length DER TLV at `off`. Returns { tag, hdr, len, contentStart, end }.
function readTLV(buf, off) {
  const tag = buf[off];
  let p = off + 1;
  let len = buf[p++];
  if (len & 0x80) {                    // long form: low 7 bits = number of length bytes
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p++];
  }
  return { tag, hdr: p - off, len, contentStart: p, end: p + len };
}

// Yield the direct child TLVs within [start, end).
function children(buf, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    const t = readTLV(buf, p);
    out.push(t);
    p = t.end;
  }
  return out;
}

// Extract the first X.509 certificate (full DER bytes) from a PKCS#7 SignedData.
function firstCertFromPkcs7(der) {
  const outer = readTLV(der, 0);                                  // ContentInfo SEQUENCE
  const kids = children(der, outer.contentStart, outer.end);
  const explicit0 = kids.find(k => k.tag === 0xa0);               // [0] content -> SignedData
  if (!explicit0) return null;
  const signedData = children(der, explicit0.contentStart, explicit0.end)[0]; // SignedData SEQUENCE
  if (!signedData || signedData.tag !== 0x30) return null;
  const sdKids = children(der, signedData.contentStart, signedData.end);
  const certs = sdKids.find(k => k.tag === 0xa0);                 // [0] IMPLICIT certificates
  if (!certs) return null;
  const cert = children(der, certs.contentStart, certs.end).find(k => k.tag === 0x30); // first cert
  if (!cert) return null;
  return der.subarray(cert.contentStart - cert.hdr, cert.end);   // full cert TLV (tag..end)
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Compute the checksum from an APK path. Async (reads + unzips). Resolves to the base64url
// string, or null if the APK/signature can't be read or parsed.
async function apkSignatureChecksum(apkPath) {
  try {
    if (!apkPath || !fs.existsSync(apkPath)) return null;
    const dir = await unzipper.Open.file(apkPath);
    const sig = dir.files.find(f => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(f.path));
    if (!sig) return null;
    const der = await sig.buffer();
    const cert = firstCertFromPkcs7(der);
    if (!cert || !cert.length) return null;
    return base64url(crypto.createHash('sha256').update(cert).digest());
  } catch (e) {
    return null;
  }
}

// mtime-keyed memo so a rare QR request doesn't re-parse the ~8MB zip every time; recomputes
// automatically when the served APK changes on disk (new build mounted).
let _memo = { key: null, checksum: null };
async function apkSignatureChecksumCached(apkPath, mtime) {
  const key = `${apkPath}@${mtime}`;
  if (_memo.key === key && _memo.checksum) return _memo.checksum;
  const c = await apkSignatureChecksum(apkPath);
  if (c) _memo = { key, checksum: c };
  return c;
}

module.exports = { apkSignatureChecksum, apkSignatureChecksumCached, _firstCertFromPkcs7: firstCertFromPkcs7 };
