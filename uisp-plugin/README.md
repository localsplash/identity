# Identity SSO Bridge — UISP plugin

Adopted from `localsplash/EchoOrchestrator/uisp-plugin` at `e07b811`.
The plugin reads an authenticated UISP client-zone session and redirects a
30-second HMAC-signed code directly to Identity's `/sso/callback`.
Identity validates the signature and expiry and prevents nonce replay.

## Package and install

From this directory:

```sh
zip -r identity-sso-plugin.zip manifest.json main.php public.php public/
```

These files must be at the ZIP root. Tests and local `data/config.json` are not
included. Upload the ZIP through CRM → System → Plugins, enable it, and set:

- **Identity Base URL** (`identityBaseUrl`): `https://identity.X.TLD`, using the
  deployment's own parent domain. No Echo callback or forwarding hop is used.
- **SSO Shared Secret** (`ssoSecret`): exactly the value of
  `identity/UISP_SSO_SECRET` in `PlatformConfig/cfg_tbl_Setting`.

Copy UISP's generated **Plugin public URL** to the `identity/UISP_PLUGIN_URL`
PlatformConfig row. Identity already displays the ISP sign-in entry when this
URL and the shared secret are configured. No EchoWeb setting or environment
variable is needed. UISP's server domain must be configured for this URL to exist.

This is a clean configuration change: `echoBaseUrl` is no longer read.
Reconfigure each UISP installation before removing EchoWeb's old callback.
Installation on another host is an operator action, separate from merging or
deploying Identity here. Verify sign-in from the client-zone menu and from
Identity, including a browser initially signed out of UISP.

## Login return

When the UISP session is absent, `public.php` sets a host-only, Secure,
SameSite=Lax `identity_sso_intent` cookie for five minutes and redirects to CRM
login. UISP loads `public/client-zone.js` after login; it clears the intent
before returning to the plugin, with a same-origin check to prevent redirect
loops and off-site navigation. Without JavaScript the client-zone menu still
works. The menu opens a top-level tab, as the SSO cookie is SameSite=Lax.

The script also decorates the menu icon; this is cosmetic and fails quietly
if UISP changes its markup. `information.version` is bumped on every upload;
manifest schema `version` remains `1`.

## Validation

See `tests/README.md`. Validate both PHP files with `php -l` when packaging.
The DOM tests cover intent consumption, same-origin navigation, menu matching,
active styling, and idempotency. Identity's existing SSO tests cover redemption.
