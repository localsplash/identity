<?php
/**
 * Identity SSO Bridge — scheduled/manual execution entry point.
 *
 * UCRM requires this file to exist, but this plugin does all of its work in
 * public.php in response to a client clicking through from the client zone.
 * There is nothing to do on a schedule, so this is intentionally a no-op.
 */

declare(strict_types=1);

echo "Identity SSO Bridge is a request-driven plugin; there is no scheduled work to perform.\n";
