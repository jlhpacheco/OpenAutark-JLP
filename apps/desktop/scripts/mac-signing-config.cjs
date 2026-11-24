// Owns: the explicit macOS signing configuration for electron-builder 26.15.3, chosen by AUTARK_MAC_SIGNING:
//   developer-id  Developer ID Application certificate (CSC_LINK + CSC_KEY_PASSWORD, or one already in the keychain),
//                 hardened runtime, notarization with the App Store Connect API key (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER).
//   adhoc         identity "-" with hardened runtime, no notarization. Test builds on CI before the Apple account exists; the
//                 entitlements add disable-library-validation because an ad-hoc signature has no Team ID.
// Never: embeds credentials, falls back to an unsigned build, or lets an ad-hoc build look like a release.
const fs = require('node:fs');
const path = require('node:path');
const base = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).build;
const mode = process.env.AUTARK_MAC_SIGNING;
if (!['developer-id', 'adhoc'].includes(mode)) throw new Error('AUTARK_MAC_SIGNING must be developer-id or adhoc.');
const { identity: _unsigned, ...mac } = base.mac; // package.json keeps identity: null so a plain build stays unsigned
const assets = path.resolve(__dirname, '../assets');
if (mode === 'developer-id') {
  for (const key of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    if (!process.env[key]?.trim()) throw new Error(`Notarization setting missing: ${key}`);
  }
  if (!fs.existsSync(process.env.APPLE_API_KEY)) throw new Error('APPLE_API_KEY must be the path of the .p8 file.');
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') throw new Error('CSC_IDENTITY_AUTO_DISCOVERY=false would skip the certificate.');
}
module.exports = {
  ...base,
  forceCodeSigning: true,
  mac: {
    ...mac,
    ...(mode === 'adhoc' ? { identity: '-', notarize: false } : { notarize: true }),
    hardenedRuntime: true,
    gatekeeperAssess: false, // spctl is run on purpose after the build, with its output kept
    entitlements: path.join(assets, mode === 'adhoc' ? 'entitlements.mac.adhoc.plist' : 'entitlements.mac.plist'),
    entitlementsInherit: path.join(assets, mode === 'adhoc' ? 'entitlements.mac.adhoc.plist' : 'entitlements.mac.plist'),
  },
};
