# Desktop updates

## Desktop 0.3.17

- Windows: Opt in to signing in after a restart using a password from the
  secrets catalog. No password is stored or used unless you enable the
  feature. The broker stops retrying after a rejected password or repeated
  failures. The screen locks by default once Autark starts.
- Development: Standard runtime tests use loopback instead of LAN
  listeners. Real WebRTC and Windows TCP checks still run explicitly in CI.
