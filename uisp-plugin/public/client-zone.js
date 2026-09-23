/**
 * Identity SSO Bridge — client zone enhancements.
 *
 * UCRM loads this file on every client zone page. It does two independent jobs:
 *
 *   1. autoReturn()  — completes a sign-in that started at Identity. The CRM login
 *      form carries no target-path field and public.php sits outside the
 *      Symfony firewall, so UISP cannot send the user back where they came
 *      from. public.php drops a short-lived intent cookie before handing off to
 *      the login page; this picks it up on the way back and finishes the trip.
 *
 *   2. decorateMenu() — swaps the icon on the "Platform sign-in" client zone menu
 *      item. UCRM's manifest has no icon field, so the only way to style the
 *      entry is from here. This is cosmetic by design: every step is guarded and
 *      failure leaves a working, unstyled link rather than a broken menu. It
 *      depends on UISP's markup and may stop applying after a UISP upgrade.
 */
(function () {
  'use strict';

  var INTENT_COOKIE = 'identity_sso_intent';
  var MENU_LABEL    = 'Platform sign-in';
  var MARK          = 'data-identity-icon';

  // document.currentScript is only valid during initial execution, so resolve
  // it now rather than inside a later callback.
  var SCRIPT_SRC = (function () {
    if (document.currentScript && document.currentScript.src) {
      return document.currentScript.src;
    }
    var s = document.getElementsByTagName('script');
    for (var i = 0; i < s.length; i++) {
      if (s[i].src && s[i].src.indexOf('/public/client-zone.js') !== -1) return s[i].src;
    }
    return null;
  })();

  // fill="currentColor" so the idle icon inherits whatever colour UISP applies
  // to menu links, including their own hover and active transitions.
  var ICON_DEFAULT =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Platform sign-in">' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M3 4C3 2.89543 3.89543 2 5 2H13C14.1046 2 15 2.89543 15 4V11C15 12.1046 14.1046 13 13 13H9.41421L5 17.4142V13H5C3.89543 13 3 12.1046 3 11V4ZM5 3H13C13.5523 3 14 3.44772 14 4V11C14 11.5523 13.5523 12 13 12H8.58579L6 14.5858V12H5C4.44772 12 4 11.5523 4 11V4C4 3.44772 4.44772 3 5 3Z"/>' +
    '<path d="M6 5H12V6.25H6V5Z"/>' +
    '<path d="M6 7.25H11V8.5H6V7.25Z"/>' +
    '<path d="M6 9.5H10V10.75H6V9.5Z"/>' +
    '<path d="M16.0 5.8C17.4 6.3 18.5 7.5 19.0 9.0L18.0 9.3C17.6 8.1 16.8 7.2 15.7 6.8Z"/>' +
    '<path d="M16.6 3.8C18.6 4.5 20.2 6.2 21.0 8.8L19.9 9.2C19.2 7.0 18.0 5.6 16.3 5.0Z"/>' +
    '<path d="M17.2 1.8C19.8 2.8 21.8 5.0 22.7 8.6L21.5 9.1C20.7 6.0 19.0 4.2 16.8 3.3Z"/>' +
    '</svg>';

  var ICON_ACTIVE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="Platform sign-in (active)">' +
    '<rect x="1" y="1" width="22" height="22" rx="3.5" fill="#E5F0FF"/>' +
    '<g fill="#006FFF">' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M3 4C3 2.89543 3.89543 2 5 2H13C14.1046 2 15 2.89543 15 4V11C15 12.1046 14.1046 13 13 13H9.41421L5 17.4142V13H5C3.89543 13 3 12.1046 3 11V4ZM5 3H13C13.5523 3 14 3.44772 14 4V11C14 11.5523 13.5523 12 13 12H8.58579L6 14.5858V12H5C4.44772 12 4 11.5523 4 11V4C4 3.44772 4.44772 3 5 3Z"/>' +
    '<path d="M6 5H12V6.25H6V5Z"/>' +
    '<path d="M6 7.25H11V8.5H6V7.25Z"/>' +
    '<path d="M6 9.5H10V10.75H6V9.5Z"/>' +
    '<path d="M16.0 5.8C17.4 6.3 18.5 7.5 19.0 9.0L18.0 9.3C17.6 8.1 16.8 7.2 15.7 6.8Z"/>' +
    '<path d="M16.6 3.8C18.6 4.5 20.2 6.2 21.0 8.8L19.9 9.2C19.2 7.0 18.0 5.6 16.3 5.0Z"/>' +
    '<path d="M17.2 1.8C19.8 2.8 21.8 5.0 22.7 8.6L21.5 9.1C20.7 6.0 19.0 4.2 16.8 3.3Z"/>' +
    '</g></svg>';

  // ── Cookies ────────────────────────────────────────────────────────────────

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(name + '=') === 0) return p.substring(name.length + 1);
    }
    return null;
  }

  function clearCookie(name) {
    document.cookie = name + '=; Path=/; Max-Age=0; SameSite=Lax; Secure';
  }

  // ── 1. Finish an Identity-initiated sign-in ────────────────────────────────────

  function pluginUrl() {
    if (!SCRIPT_SRC) return null;
    var target = SCRIPT_SRC.split('?')[0].replace(/\/public\/client-zone\.js$/, '/public.php');
    if (target === SCRIPT_SRC.split('?')[0]) return null; // pattern didn't match

    // Same-origin only — a tampered src can never bounce the user off-site.
    var a = document.createElement('a');
    a.href = target;
    return a.origin === window.location.origin ? target : null;
  }

  /** @return {boolean} true if a navigation was started. */
  function autoReturn() {
    if (readCookie(INTENT_COOKIE) !== '1') return false;
    var target = pluginUrl();
    if (!target) return false;

    // Consume the intent before navigating so this can only ever fire once and
    // a downstream failure cannot loop.
    clearCookie(INTENT_COOKIE);
    window.location.replace(target);
    return true;
  }

  // ── 2. Decorate the menu item ──────────────────────────────────────────────

  function isActive(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('aria-current')) return true;
      var c = ' ' + (n.className || '') + ' ';
      if (typeof c === 'string' && /\s(active|is-active|current|selected)\s/.test(c)) return true;
    }
    return false;
  }

  /**
   * The href is a far more reliable handle than the label, which changes with
   * locale and with anything the operator renames. Label match is the fallback.
   */
  function findMenuLinks() {
    var out = [];
    var anchors = document.getElementsByTagName('a');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var href = a.getAttribute('href') || '';
      var text = (a.textContent || '').trim();
      if (/\/_plugins\/[^/]*identity-sso[^/]*\/public\.php/.test(href) || text === MENU_LABEL) {
        out.push(a);
      }
    }
    return out;
  }

  function decorateOne(a) {
    var wantActive = isActive(a);
    if (a.getAttribute(MARK) === (wantActive ? 'active' : 'default')) return;

    // Reuse the existing icon node's classes so UISP's own sizing rules still
    // apply; fall back to an explicit 24px box if there was no icon to match.
    var existing = a.querySelector('svg, img, i, .icon');
    var holder = document.createElement('span');
    holder.innerHTML = wantActive ? ICON_ACTIVE : ICON_DEFAULT;
    var svg = holder.firstChild;

    if (existing && existing.getAttribute('class')) {
      svg.setAttribute('class', existing.getAttribute('class'));
    } else {
      svg.setAttribute('width', '24');
      svg.setAttribute('height', '24');
    }
    svg.style.flexShrink = '0';

    if (existing) {
      existing.parentNode.replaceChild(svg, existing);
    } else {
      a.insertBefore(svg, a.firstChild);
    }
    a.setAttribute(MARK, wantActive ? 'active' : 'default');
  }

  function decorateMenu() {
    var links = findMenuLinks();
    for (var i = 0; i < links.length; i++) {
      try {
        decorateOne(links[i]);
      } catch (e) {
        /* cosmetic only — never let this break the menu */
      }
    }
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  function init() {
    try {
      if (autoReturn()) return; // navigating away; don't bother styling
    } catch (e) { /* fall through to decoration */ }

    try {
      decorateMenu();

      // The client zone may render or re-render its menu after load, so keep
      // watching. Re-decoration is idempotent via the MARK attribute.
      if (window.MutationObserver && document.body) {
        var pending = null;
        new MutationObserver(function () {
          if (pending) return;
          pending = setTimeout(function () { pending = null; decorateMenu(); }, 100);
        }).observe(document.body, { childList: true, subtree: true });
      }
    } catch (e) { /* cosmetic only */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
