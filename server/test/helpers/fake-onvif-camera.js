'use strict';

/*
 * A fake ONVIF camera for tests: an HTTP SOAP endpoint and a WS-Discovery responder, both on
 * random localhost ports. It checks authentication the way real cameras do, so the client's
 * WS-Security, clock sync and HTTP Digest paths are exercised for real.
 *
 * Options:
 *   username / password   required credentials ('' = open camera)
 *   auth: 'wsse' | 'digest' | 'both'   what it demands ('both' = Digest challenge, then WS-Security)
 *   clockSkewSec          the camera's clock minus real time; tokens more than 5 s off it are refused
 *   media2Only            no Media (ver10) service, only Media2 (ver20)
 *   ptz                   has a PTZ service and a PTZ profile
 *   oldFirmware           no GetServices (answers it with a fault), only GetCapabilities
 *   advertiseHost         the host it puts in service XAddrs (to test re-aiming), default 127.0.0.1
 *
 * `calls` records every operation by name with its body; `ptzLog` the PTZ ones.
 */

const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const digest = require('../../lib/onvif/http-digest');

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

function envelope(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"
 xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
 xmlns:tr2="http://www.onvif.org/ver20/media/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"
 xmlns:tt="http://www.onvif.org/ver10/schema"><env:Body>${inner}</env:Body></env:Envelope>`;
}
function fault(code, reason) {
  return envelope(`<env:Fault><env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>ter:${code}</env:Value></env:Subcode></env:Code><env:Reason><env:Text xml:lang="en">${reason}</env:Text></env:Reason></env:Fault>`);
}

async function startFakeCamera(opts = {}) {
  const o = { username: 'admin', password: 'secret', auth: 'wsse', clockSkewSec: 0, media2Only: false, ptz: false, oldFirmware: false, advertiseHost: '127.0.0.1', ...opts };
  const calls = [];
  const ptzLog = [];
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://${o.advertiseHost}:${port}`;
  const camNow = () => new Date(Date.now() + o.clockSkewSec * 1000);

  function wsseOk(doc) {
    if (!o.username) return true;
    const tok = doc.getElementsByTagNameNS('*', 'UsernameToken')[0];
    if (!tok) return false;
    const g = (n) => { const e = tok.getElementsByTagNameNS('*', n)[0]; return e ? e.textContent.trim() : ''; };
    if (g('Username') !== o.username) return false;
    const created = g('Created');
    const nonce = Buffer.from(g('Nonce'), 'base64');
    const want = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(o.password)])).digest('base64');
    if (want !== g('Password')) return false;
    return Math.abs(new Date(created).getTime() - camNow().getTime()) <= 5000;
  }

  let digestNonce = crypto.randomBytes(8).toString('hex');
  function digestOk(req, method) {
    const h = req.headers.authorization || '';
    if (!/^Digest /.test(h)) return false;
    const p = digest.parseChallenge(h);   // same key="value" grammar
    if (!p || p.username !== o.username || p.nonce !== digestNonce) return false;
    const expect = digest.authorization({ realm: 'fakecam', nonce: digestNonce, qop: 'auth' },
      { username: o.username, password: o.password, method, uri: p.uri, cnonce: p.cnonce, nc: parseInt(p.nc, 16) });
    return digest.parseChallenge(expect).response === p.response;
  }
  function challenge(res) {
    digestNonce = crypto.randomBytes(8).toString('hex');
    res.writeHead(401, { 'WWW-Authenticate': `Digest realm="fakecam", qop="auth", nonce="${digestNonce}", algorithm=MD5` });
    res.end();
  }

  server.on('request', (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/snap')) {
        if (o.username && !digestOk(req, 'GET')) return challenge(res);
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(JPEG);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      const bodyEl = doc.getElementsByTagNameNS('*', 'Body')[0];
      let op = null;
      for (let c = bodyEl && bodyEl.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) { op = c; break; }
      const name = op ? op.localName : '?';
      calls.push({ name, body: text, path: req.url });
      const send = (status, xml) => { res.writeHead(status, { 'Content-Type': 'application/soap+xml' }); res.end(xml); };

      if (name === 'GetSystemDateAndTime') {
        const d = camNow();
        return send(200, envelope(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`));
      }
      if ((o.auth === 'digest' || o.auth === 'both') && o.username && !digestOk(req, 'POST')) return challenge(res);
      if ((o.auth === 'wsse' || o.auth === 'both') && !wsseOk(doc)) return send(400, fault('NotAuthorized', 'Sender not Authorized'));

      const tokenOf = () => { const t = op.getElementsByTagNameNS('*', 'ProfileToken')[0]; return t ? t.textContent : ''; };
      switch (name) {
        case 'GetServices':
          if (o.oldFirmware) return send(400, fault('ActionNotSupported', 'Not implemented'));
          return send(200, envelope(`<tds:GetServicesResponse>
            <tds:Service><tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace><tds:XAddr>${base}/onvif/device_service</tds:XAddr></tds:Service>
            ${o.media2Only ? '' : `<tds:Service><tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace><tds:XAddr>${base}/onvif/media</tds:XAddr></tds:Service>`}
            <tds:Service><tds:Namespace>http://www.onvif.org/ver20/media/wsdl</tds:Namespace><tds:XAddr>${base}/onvif/media2</tds:XAddr></tds:Service>
            ${o.ptz ? `<tds:Service><tds:Namespace>http://www.onvif.org/ver20/ptz/wsdl</tds:Namespace><tds:XAddr>${base}/onvif/ptz</tds:XAddr></tds:Service>` : ''}
          </tds:GetServicesResponse>`));
        case 'GetCapabilities':
          return send(200, envelope(`<tds:GetCapabilitiesResponse><tds:Capabilities>
            <tt:Media><tt:XAddr>${base}/onvif/media</tt:XAddr></tt:Media>
            ${o.ptz ? `<tt:PTZ><tt:XAddr>${base}/onvif/ptz</tt:XAddr></tt:PTZ>` : ''}
          </tds:Capabilities></tds:GetCapabilitiesResponse>`));
        case 'GetDeviceInformation':
          return send(200, envelope('<tds:GetDeviceInformationResponse><tds:Manufacturer>FakeCam</tds:Manufacturer><tds:Model>FC-1</tds:Model><tds:FirmwareVersion>1.2.3</tds:FirmwareVersion><tds:SerialNumber>SN1</tds:SerialNumber><tds:HardwareId>HW1</tds:HardwareId></tds:GetDeviceInformationResponse>'));
        case 'GetProfiles': {
          const ptzCfg = o.ptz ? '<tt:PTZConfiguration token="ptz0"><tt:Name>PTZ</tt:Name></tt:PTZConfiguration>' : '';
          if (op.namespaceURI === 'http://www.onvif.org/ver20/media/wsdl') {
            return send(200, envelope(`<tr2:GetProfilesResponse>
              <tr2:Profiles token="main" fixed="true"><tr2:Name>Main stream</tr2:Name><tr2:Configurations><tr2:VideoEncoder token="ve0"><tt:Name>VE</tt:Name><tt:Encoding>H265</tt:Encoding><tt:Resolution><tt:Width>2560</tt:Width><tt:Height>1440</tt:Height></tt:Resolution></tr2:VideoEncoder>${o.ptz ? '<tr2:PTZ token="ptz0"><tt:Name>PTZ</tt:Name></tr2:PTZ>' : ''}</tr2:Configurations></tr2:Profiles>
              <tr2:Profiles token="sub"><tr2:Name>Sub stream</tr2:Name><tr2:Configurations><tr2:VideoEncoder token="ve1"><tt:Name>VE</tt:Name><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>640</tt:Width><tt:Height>360</tt:Height></tt:Resolution></tr2:VideoEncoder></tr2:Configurations></tr2:Profiles>
            </tr2:GetProfilesResponse>`));
          }
          return send(200, envelope(`<trt:GetProfilesResponse>
            <trt:Profiles token="main" fixed="true"><tt:Name>Main stream</tt:Name><tt:VideoEncoderConfiguration token="ve0"><tt:Name>VE</tt:Name><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>${ptzCfg}</trt:Profiles>
            <trt:Profiles token="sub"><tt:Name>Sub stream</tt:Name><tt:VideoEncoderConfiguration token="ve1"><tt:Name>VE</tt:Name><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>640</tt:Width><tt:Height>360</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>
          </trt:GetProfilesResponse>`));
        }
        case 'GetStreamUri':
          // A real quirk: the address advertised is 0.0.0.0 (camera means "me").
          return send(200, envelope(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://0.0.0.0:554/${tokenOf()}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`));
        case 'GetSnapshotUri':
          return send(200, envelope(`<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://127.0.0.1:${port}/snap?p=${tokenOf()}</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`));
        case 'GetPresets':
          return send(200, envelope('<tptz:GetPresetsResponse><tptz:Preset token="1"><tt:Name>Door</tt:Name></tptz:Preset><tptz:Preset token="2"><tt:Name>Car park</tt:Name></tptz:Preset></tptz:GetPresetsResponse>'));
        case 'ContinuousMove': case 'Stop': case 'GotoPreset': case 'GotoHomePosition': {
          if (!o.ptz) return send(400, fault('ActionNotSupported', 'No PTZ'));
          const entry = { op: name, token: tokenOf() };
          const pt = op.getElementsByTagNameNS('*', 'PanTilt')[0];
          if (name === 'ContinuousMove' && pt) { entry.pan = Number(pt.getAttribute('x')); entry.tilt = Number(pt.getAttribute('y')); }
          const z = op.getElementsByTagNameNS('*', 'Zoom')[0];
          if (name === 'ContinuousMove' && z) entry.zoom = Number(z.getAttribute('x'));
          const pre = op.getElementsByTagNameNS('*', 'PresetToken')[0];
          if (pre) entry.preset = pre.textContent;
          ptzLog.push(entry);
          return send(200, envelope(`<tptz:${name}Response/>`));
        }
        default:
          return send(400, fault('ActionNotSupported', `Unknown ${name}`));
      }
    });
  });

  // WS-Discovery: answer a Probe on a random UDP port with this camera's ProbeMatch.
  const udp = dgram.createSocket('udp4');
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  udp.on('message', (msg, rinfo) => {
    if (!/Probe/.test(msg.toString())) return;
    const m = `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"><s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:fake-${port}</a:Address></a:EndpointReference><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/name/Lobby%20Cam onvif://www.onvif.org/hardware/FC-1 onvif://www.onvif.org/location/front</d:Scopes><d:XAddrs>http://[fe80::1]:${port}/onvif/device_service http://127.0.0.1:${port}/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`;
    udp.send(Buffer.from(m), rinfo.port, rinfo.address);
  });

  return {
    port,
    discoveryPort: udp.address().port,
    xaddr: `http://127.0.0.1:${port}/onvif/device_service`,
    calls, ptzLog, jpeg: JPEG,
    close: () => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => udp.close(r))]),
  };
}

module.exports = { startFakeCamera };
