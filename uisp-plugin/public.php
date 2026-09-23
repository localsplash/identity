<?php
/**
 * Identity SSO Bridge – UISP Plugin Public Entry Point
 *
 * UCRM generates this file's public URL on install and shows it on the plugin
 * page as "Plugin public URL". That URL is what Identity's login page links to.
 *
 * Flow:
 *  1. Forward the browser's UISP cookies to /crm/current-user server-side.
 *  2. If not authenticated → redirect to UISP client-zone login.
 *  3. If authenticated as a client → sign a 30-second one-time code and
 *     redirect to Identity's /sso/callback endpoint.
 */

declare(strict_types=1);

// ─── Load plugin configuration ─────────────────────────────────────────────────
// UCRM writes the admin-configured values to data/config.json alongside this file.
$configFile = __DIR__ . '/data/config.json';
$pluginConfig = file_exists($configFile)
    ? json_decode(file_get_contents($configFile), true)
    : [];

$identityBaseUrl = rtrim((string)($pluginConfig['identityBaseUrl'] ?? ''), '/');
$ssoSecret   = (string)($pluginConfig['ssoSecret'] ?? '');

if (!filter_var($identityBaseUrl, FILTER_VALIDATE_URL) || parse_url($identityBaseUrl, PHP_URL_SCHEME) !== 'https' || $ssoSecret === '') {
    http_response_code(503);
    echo '<p>Identity SSO is not configured. Please set the Identity Base URL and SSO Shared Secret in the plugin settings.</p>';
    exit;
}

// ─── Forward UISP session cookies to /crm/current-user ────────────────────────
// The browser is on the UISP host so its UISP cookies arrive with this request.
$sessionId  = $_COOKIE['nms-crm-php-session-id'] ?? '';
$nmsSession = $_COOKIE['nms-session'] ?? '';

// Build the Cookie header to forward
$cookieHeader = '';
if ($sessionId !== '') {
    $cookieHeader .= 'nms-crm-php-session-id=' . urlencode($sessionId) . '; ';
}
if ($nmsSession !== '') {
    $cookieHeader .= 'nms-session=' . urlencode($nmsSession) . '; ';
}

$host = (string)($_SERVER['HTTP_HOST'] ?? '');
if ($host === '' || !preg_match('/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/D', $host)) {
    http_response_code(503);
    echo '<p>UISP server hostname is not configured.</p>';
    exit;
}
$uispHost = 'https://' . $host;
$currentUserUrl = $uispHost . '/crm/current-user';

$ch = curl_init($currentUserUrl);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER     => [
        'Accept: application/json',
        'Cookie: ' . rtrim($cookieHeader, '; '),
    ],
    CURLOPT_TIMEOUT        => 10,
    CURLOPT_FOLLOWLOCATION => false,
]);

$body     = curl_exec($ch);
$httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

// ─── Handle unauthenticated / error responses ──────────────────────────────────
if ($httpCode === 401 || $httpCode === 403) {
    // Not signed in to the client zone.
    //
    // The CRM login form carries no target-path field and this file sits
    // outside the Symfony firewall, so UISP cannot return the user here after
    // login — it always lands them on the client zone. Drop a short-lived
    // intent cookie; public/client-zone.js runs on every client zone page,
    // sees it, and forwards back here once the session exists.
    //
    // Host-only, JS-readable (client-zone.js must read it), and short-lived so
    // an abandoned attempt cannot surprise the user with a redirect later.
    setcookie('identity_sso_intent', '1', [
        'expires'  => time() + 300,
        'path'     => '/',
        'secure'   => true,
        'httponly' => false,
        'samesite' => 'Lax',
    ]);

    header('Location: /crm/login');
    exit;
}

if ($httpCode !== 200 || $body === false) {
    http_response_code(502);
    echo '<p>Could not reach the UISP CRM. Please try again in a moment.</p>';
    exit;
}

$user = json_decode($body, true);

// Must be a client (not a UISP admin) and must have a clientId
if (!($user['isClient'] ?? false) || empty($user['clientId'])) {
    http_response_code(403);
    echo '<p>This page is only available to ISP subscriber accounts.</p>';
    exit;
}

$clientId = (string) $user['clientId'];

// ─── Build the signed one-time code ───────────────────────────────────────────
// nonce = 16 random bytes as hex (32 chars) — matches auth_tbl_SsoNonce CHAR(32)
$nonce = bin2hex(random_bytes(16));
$exp   = time() + 30; // 30-second TTL

$rawPayload = json_encode([
    'clientId' => $clientId,
    'nonce'    => $nonce,
    'exp'      => $exp,
]);

// URL-safe base64 (no padding) — Identity side decodes with Buffer.from(code, 'base64url')
$code = rtrim(strtr(base64_encode($rawPayload), '+/', '-_'), '=');

// HMAC-SHA256 over the code string; Identity does constant-time comparison
$sig = hash_hmac('sha256', $code, $ssoSecret);

// ─── Redirect to Identity SSO callback ────────────────────────────────────────────
$callbackUrl = $identityBaseUrl . '/sso/callback'
    . '?code=' . urlencode($code)
    . '&sig='  . urlencode($sig);

header('Location: ' . $callbackUrl);
exit;
