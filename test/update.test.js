'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { isNewer, findSum, looksLikeProgram, ASSETS } = require('../src/update');
const install = require('../src/install');
const assets = require('../src/assets');

test('versiunile se compară numeric', () => {
  assert.ok(isNewer('1.10.0', '1.9.9'));
  assert.ok(isNewer('v1.0.1', '1.0.0'));
  assert.ok(!isNewer('1.0.0', '1.0.0'));
  assert.ok(!isNewer('1.0.0-beta', '1.0.0'));
  assert.ok(isNewer('2', '1.99.99'));
});

test('SHA256SUMS.txt se citește ca sha256sum', () => {
  const a = 'a'.repeat(64);
  const sums = `${a}  ${ASSETS.win32}\n${'B'.repeat(64)} *${ASSETS.linux}\n`;
  assert.strictEqual(findSum(sums, ASSETS.win32), a);
  assert.strictEqual(findSum(sums, ASSETS.linux), 'b'.repeat(64));
  assert.strictEqual(findSum(sums, ASSETS.darwin), null);
  assert.strictEqual(findSum('zz  x', 'x'), null);
});

test('doar un program al acestui sistem este acceptat', () => {
  assert.ok(!looksLikeProgram(Buffer.from('<html>')));
  const head = { win32: Buffer.from('MZ\x90\x00'), darwin: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) }[process.platform] || Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  assert.ok(looksLikeProgram(head));
});

test('folderul unei aplicații macOS este cel care o conține', () => {
  const exe = '/Users/a/Applications/eManagement/e-Management ANSC.app/Contents/MacOS/eManagement';
  assert.strictEqual(install.bundleOf(exe), '/Users/a/Applications/eManagement/e-Management ANSC.app');
  assert.strictEqual(install.rootOfExe(exe).replace(/\\/g, '/'), '/Users/a/Applications/eManagement');
  assert.strictEqual(install.bundleOf('/opt/em/eManagement'), null);
});

test('folderul de instalare introdus este verificat', () => {
  assert.throws(() => install.parseDir(''));
  assert.throws(() => install.parseDir('relativ/folder'));
  assert.throws(() => install.parseDir(path.parse(process.cwd()).root));
  assert.ok(install.parseDir(path.join(process.cwd(), 'x')));
});

test('toate fișierele interfeței există', () => {
  for (const url of Object.keys(assets.FILES)) assert.ok(assets.get(url).body.length > 0, url);
});
