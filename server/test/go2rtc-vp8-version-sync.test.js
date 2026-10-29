'use strict';

/*
 * ⚠️ docker/go2rtc-vp8: THE PATCHED SOURCE TAG MUST MATCH THE RUNTIME IMAGE TAG.
 *
 * The image clones go2rtc at ARG GO2RTC_VERSION, applies the VP8/VP9 patch, and drops the binary
 * into the alexxit/go2rtc runtime pulled by the final FROM. Dependabot moves the FROM (tag + digest)
 * but never touches an ARG, so every go2rtc bump silently ships the OLD patched binary inside the
 * NEW runtime. #741 (1.9.14 -> 1.9.15) did exactly that and still went green, because nothing here
 * builds the image. This makes the Dependabot PR itself go red until the ARG is moved too.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOCKERFILE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'docker', 'go2rtc-vp8', 'Dockerfile'), 'utf8');

test('go2rtc-vp8 clones and patches the same go2rtc version its runtime image is', () => {
  const arg = /^ARG GO2RTC_VERSION=v?(\S+)\s*$/m.exec(DOCKERFILE);
  const from = /^FROM alexxit\/go2rtc:([^@\s]+)/m.exec(DOCKERFILE);
  assert.ok(arg, 'ARG GO2RTC_VERSION not found');
  assert.ok(from, 'final FROM alexxit/go2rtc:<tag> not found');
  assert.equal(arg[1], from[1],
    `ARG GO2RTC_VERSION=v${arg[1]} but the runtime is alexxit/go2rtc:${from[1]}; bump the ARG to v${from[1]}`);
});
