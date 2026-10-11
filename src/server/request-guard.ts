/**
 * Who may talk to the bridge. There is no token: the bridge listens only on
 * 127.0.0.1, and every request is checked for where it comes from.
 *
 * - **Host** must be 127.0.0.1 or localhost on this port. That stops DNS
 *   rebinding, where a remote site points its own name at 127.0.0.1.
 * - **Origin**, when the browser sends one, must be this page or the ZX
 *   extension. A script on any other site always carries its own Origin on
 *   fetch, form posts and EventSource, so it cannot drive the bridge.
 *
 * What this does not stop: another program running on this computer. It can
 * reach 127.0.0.1 and leave out the Origin header. The user chose this
 * trade-off to start ZX without copying a link; a local program running as
 * the user could read the files directly anyway.
 */
export type Verdict = { ok: true } | { ok: false; status: 403; reason: string };

export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function checkUi(
  req: { host: string | undefined; origin: string | undefined },
  expected: { port: number; extensionId: string },
): Verdict {
  if (!hostAllowed(req.host, expected.port)) return { ok: false, status: 403, reason: `host not allowed: ${String(req.host)}` };
  const origin = req.origin;
  const allowed =
    origin === undefined ||
    origin === `http://127.0.0.1:${expected.port}` ||
    origin === `http://localhost:${expected.port}` ||
    origin === `chrome-extension://${expected.extensionId}`;
  return allowed ? { ok: true } : { ok: false, status: 403, reason: `origin not allowed: ${origin}` };
}

export function checkExtension(
  req: { host: string | undefined; origin: string | undefined },
  expected: { port: number; extensionId: string },
): Verdict {
  if (!hostAllowed(req.host, expected.port)) return { ok: false, status: 403, reason: `host not allowed: ${String(req.host)}` };
  if (req.origin !== `chrome-extension://${expected.extensionId}`) {
    return { ok: false, status: 403, reason: `origin not allowed: ${String(req.origin)}` };
  }
  return { ok: true };
}
