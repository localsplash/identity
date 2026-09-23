// Exercise client-zone.js in a real DOM (jsdom), covering both concerns:
// the SSO auto-return and the menu icon decoration.
const fs = require('fs');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(
  require('path').join(__dirname, '../public/client-zone.js'), 'utf8');
const ORIGIN = 'https://my.example.net';
const SRC = ORIGIN + '/crm/_plugins/identity-sso/public/client-zone.js';
const HREF = '/crm/_plugins/identity-sso/public.php';

async function boot({ html = '', cookie = '', scriptSrc = SRC, url = ORIGIN + '/crm/client-zone' } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${html}<script src="${scriptSrc}"></script></body></html>`,
    { url, runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;
  // public.php sets this with path=/, so the harness must too — otherwise it
  // would default to /crm/ and the script's Path=/ clear would not match it.
  if (cookie) cookie.split('; ').forEach(c => { window.document.cookie = c + '; Path=/'; });

  // jsdom's location.replace is non-configurable and refuses real navigation,
  // so run the script with a stand-in window whose location we can observe.
  const nav = { to: null };
  const fakeWindow = {
    location: { origin: new URL(url).origin, replace: (u) => { nav.to = u; } },
    MutationObserver: window.MutationObserver,
  };

  const run = (w) => window.Function('window', 'document', SCRIPT)(w, window.document);
  run(fakeWindow);

  // The script defers init() to DOMContentLoaded when the document is still
  // loading, so let that fire before asserting.
  if (window.document.readyState === 'loading') {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
  }
  await new Promise((r) => setTimeout(r, 10));

  return { window, doc: window.document, nav, rerun: () => run(fakeWindow) };
}

const menu = (label = 'Platform sign-in', href = HREF, inner = '<svg class="ui-icon"></svg>', wrap = '') =>
  `<nav><ul><li class="${wrap}"><a href="${href}">${inner}<span>${label}</span></a></li></ul></nav>`;

const T = [];
const test = (name, fn) => T.push({ name, fn });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── auto-return ─────────────────────────────────────────────────────────────

test('no intent cookie -> no navigation', async () => {
  const { nav } = await boot({ html: menu() });
  return nav.to === null;
});

test('intent cookie -> navigates to public.php', async () => {
  const { nav } = await boot({ html: menu(), cookie: 'identity_sso_intent=1' });
  return nav.to === ORIGIN + '/crm/_plugins/identity-sso/public.php';
});

test('intent cookie is cleared before navigating (loop guard)', async () => {
  const { doc } = await boot({ html: menu(), cookie: 'identity_sso_intent=1' });
  return !/identity_sso_intent=1/.test(doc.cookie);
});

test('cross-origin script src -> refuses to navigate', async () => {
  const { nav } = await boot({
    html: menu(), cookie: 'identity_sso_intent=1',
    scriptSrc: 'https://evil.example/public/client-zone.js',
  });
  return nav.to === null;
});

test('cookie value must be exactly 1', async () => {
  const { nav } = await boot({ html: menu(), cookie: 'identity_sso_intent=0' });
  return nav.to === null;
});

// ── menu decoration ─────────────────────────────────────────────────────────

test('injects icon when matched by href', async () => {
  const { doc } = await boot({ html: menu('Mensajes', HREF) }); // label localised
  const a = doc.querySelector('a');
  return a.getAttribute('data-identity-icon') === 'default' &&
         a.querySelector('svg[aria-label="Platform sign-in"]') !== null;
});

test('injects icon when matched by label alone (no plugin href)', async () => {
  const { doc } = await boot({ html: menu('Platform sign-in', '/somewhere/else') });
  return doc.querySelector('a').getAttribute('data-identity-icon') === 'default';
});

test('replaces the existing icon rather than appending', async () => {
  const { doc } = await boot({ html: menu() });
  return doc.querySelectorAll('a svg').length === 1;
});

test('preserves the original icon class for UISP sizing', async () => {
  const { doc } = await boot({ html: menu() });
  return doc.querySelector('a svg').getAttribute('class') === 'ui-icon';
});

test('falls back to 24x24 when there was no icon to copy', async () => {
  const { doc } = await boot({ html: menu('Platform sign-in', HREF, '') });
  const svg = doc.querySelector('a svg');
  return svg.getAttribute('width') === '24' && svg.getAttribute('height') === '24';
});

test('active item gets the #E5F0FF / #006FFF treatment', async () => {
  const { doc } = await boot({ html: menu('Platform sign-in', HREF, '<svg></svg>', 'active') });
  const a = doc.querySelector('a');
  const svg = a.querySelector('svg');
  return a.getAttribute('data-identity-icon') === 'active' &&
         svg.innerHTML.includes('#E5F0FF') && svg.innerHTML.includes('#006FFF');
});

test('idle item uses currentColor so it inherits UISP menu colour', async () => {
  const { doc } = await boot({ html: menu() });
  return doc.querySelector('a svg').getAttribute('fill') === 'currentColor';
});

test('unrelated links are left alone', async () => {
  const { doc } = await boot({ html: '<a href="/crm/client-zone/billing"><svg></svg>Billing</a>' });
  return doc.querySelector('a').getAttribute('data-identity-icon') === null;
});

test('decoration is idempotent (no duplicate svgs on re-run)', async () => {
  const { doc, rerun } = await boot({ html: menu() });
  rerun();
  return doc.querySelectorAll('a svg').length === 1;
});

test('does not decorate when navigating away', async () => {
  const { doc } = await boot({ html: menu(), cookie: 'identity_sso_intent=1' });
  return doc.querySelector('a').getAttribute('data-identity-icon') === null;
});

test('link href is never modified', async () => {
  const { doc } = await boot({ html: menu() });
  return doc.querySelector('a').getAttribute('href') === HREF;
});

test('label text survives decoration', async () => {
  const { doc } = await boot({ html: menu() });
  return doc.querySelector('a').textContent.includes('Platform sign-in');
});

test('survives a menu with no icon and no match without throwing', async () => {
  const { doc } = await boot({ html: '<nav></nav>' });
  return doc.querySelectorAll('[data-identity-icon]').length === 0;
});

// ── run ─────────────────────────────────────────────────────────────────────

(async () => {
  let fail = 0;
  for (const t of T) {
    let ok = false, err = '';
    try { ok = (await t.fn()) === true; } catch (e) { err = ' — ' + e.message; }
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.name}${err}`);
  }
  console.log(`\n${T.length - fail}/${T.length} passed`);
  process.exit(fail ? 1 : 0);
})();
