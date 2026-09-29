# UISP client-zone tests

The test resolves the plugin script relative to this directory. Run with Node
22 and jsdom 26.1.0 available (`npm install --no-save jsdom@26.1.0` in a disposable
copy), then `node client-zone.check.cjs`.

Covers SSO auto-return, redirect-loop prevention, same-origin refusal, menu
matching, active styling, idempotency, and preserving the link destination.
Do not include tests or node_modules in the plugin ZIP.
