/**
 * SSRF guard for outbound webhook URLs.
 *
 * Two concerns sit here:
 *
 *   1. Validation-time check (`assertWebhookUrlSafe`). Called from
 *      `validateUrl()` in services/webhooks.ts before the row is
 *      persisted. Rejects loopback, link-local, RFC1918 / RFC6598 /
 *      RFC4193 ranges, IPv4-mapped IPv6 forms of the same, the
 *      `localhost` / `*.local` / `*.internal` hostname conventions,
 *      and — for non-IP hostnames — every address returned by
 *      `dns.lookup(host, { all: true })`. A hostname whose A record
 *      points at the cloud metadata service is blocked at create time.
 *
 *   2. Connect-time check (`buildSafeAgent`). An undici `Agent` whose
 *      custom `connect.lookup` re-resolves the hostname and rejects
 *      disallowed addresses at TCP-connect time. This defeats DNS
 *      rebinding: between the validation lookup and the actual
 *      delivery, an attacker who controls the authoritative DNS for
 *      their hostname can flip the A record to 169.254.169.254, but
 *      our agent re-resolves and refuses to connect to that address.
 *
 *      The agent connects to the validated IP literal (the first
 *      allowed address from the resolution) and passes the original
 *      hostname through as SNI / Host header, so TLS / vhost still
 *      work end-to-end.
 *
 * Block list (CIDR shorthand):
 *
 *   IPv4:  0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
 *          169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16
 *   IPv6:  ::, ::1, fe80::/10, fc00::/7, ::ffff:0:0/96
 *          (IPv4-mapped — re-check the embedded v4 address)
 *
 *   Hostnames: "localhost", "*.local", "*.internal"
 *
 * Escape hatch: when `NODE_ENV=test` AND
 * `WEBHOOK_ALLOW_PRIVATE_FOR_TESTS=true`, validation skips both the
 * IP-range check and the DNS lookup, and the agent's connect-time
 * guard becomes a no-op. The integration suite spins up an
 * `http.createServer` on 127.0.0.1 and points webhooks at it; the
 * production guard would refuse those URLs by design. Operators MUST
 * NOT set this flag in production — it's read at boot, and the
 * config layer never honors it outside NODE_ENV=test.
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { Agent } from "undici";

/**
 * Distinct error type so the route layer can map this to a clean
 * `400 webhook_url_blocked` without confusing it with a generic
 * validation_error (the developer needs to know the URL was
 * specifically refused on safety grounds, not that they got the
 * schema wrong).
 */
export class WebhookValidationError extends Error {
  constructor(
    public readonly code:
      | "webhook_url_blocked"
      | "webhook_url_invalid",
    message: string,
  ) {
    super(message);
    this.name = "WebhookValidationError";
  }
}

// ----- hostname conventions --------------------------------------------

const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal"] as const;
const BLOCKED_EXACT_HOSTNAMES = new Set(["localhost"]);

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (BLOCKED_EXACT_HOSTNAMES.has(h)) return true;
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (h.endsWith(suffix)) return true;
  }
  return false;
}

// ----- IP-range matching -----------------------------------------------

/**
 * Parse an IPv4 dotted-quad into a 32-bit unsigned integer. Returns
 * `null` for anything that isn't four `0..255` octets — `isIP()`
 * already gates the caller, this is a defensive parse.
 */
function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (p.length === 0 || p.length > 3) return null;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out * 256) + n;
  }
  return out >>> 0;
}

interface V4Range {
  /** Network address as uint32. */
  network: number;
  /** CIDR prefix length (1..32). */
  prefix: number;
}

function v4(cidr: string): V4Range {
  const [addr, prefixStr] = cidr.split("/");
  const network = ipv4ToUint32(addr!);
  const prefix = Number(prefixStr);
  if (network === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`bad v4 cidr literal: ${cidr}`);
  }
  return { network, prefix };
}

/** Block list per the security spec. Anything that lands here is refused. */
const BLOCKED_V4_RANGES: readonly V4Range[] = Object.freeze([
  v4("0.0.0.0/8"),       // "this network" / unspecified
  v4("10.0.0.0/8"),      // RFC1918 private
  v4("100.64.0.0/10"),   // RFC6598 carrier-grade NAT
  v4("127.0.0.0/8"),     // loopback
  v4("169.254.0.0/16"),  // link-local + cloud metadata (AWS/GCP/Azure 169.254.169.254)
  v4("172.16.0.0/12"),   // RFC1918 private
  v4("192.168.0.0/16"),  // RFC1918 private
]);

function v4InRange(addr: number, r: V4Range): boolean {
  if (r.prefix === 0) return true;
  const mask = r.prefix === 32 ? 0xffffffff : (0xffffffff << (32 - r.prefix)) >>> 0;
  return (addr & mask) === (r.network & mask);
}

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToUint32(ip);
  if (n === null) return false;
  for (const r of BLOCKED_V4_RANGES) {
    if (v4InRange(n, r)) return true;
  }
  return false;
}

/**
 * Expand an IPv6 literal to its 8 16-bit groups. Handles `::`
 * shorthand. Returns `null` if the literal can't be parsed; callers
 * should have run `isIP()` first.
 */
function ipv6Groups(ip: string): number[] | null {
  // Strip an IPv4-mapped tail like `::ffff:1.2.3.4` so the head parses
  // as pure hex groups. The IPv4-mapped case is handled by callers via
  // a separate path.
  const v4Tail = ip.match(/(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let head = ip;
  let trailingGroups: number[] = [];
  if (v4Tail) {
    head = v4Tail[1]!.replace(/:$/, "");
    if (head === "") head = "::";
    const v4n = ipv4ToUint32(v4Tail[2]!);
    if (v4n === null) return null;
    trailingGroups = [(v4n >>> 16) & 0xffff, v4n & 0xffff];
  }

  const doubleIdx = head.indexOf("::");
  let leftRaw: string[];
  let rightRaw: string[];
  if (doubleIdx === -1) {
    leftRaw = head === "" ? [] : head.split(":");
    rightRaw = [];
  } else {
    const left = head.slice(0, doubleIdx);
    const right = head.slice(doubleIdx + 2);
    leftRaw = left === "" ? [] : left.split(":");
    rightRaw = right === "" ? [] : right.split(":");
  }

  const explicit = leftRaw.length + rightRaw.length + trailingGroups.length;
  if (explicit > 8) return null;
  const zeros = doubleIdx === -1 ? 0 : 8 - explicit;

  const out: number[] = [];
  for (const g of leftRaw) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  for (let i = 0; i < zeros; i++) out.push(0);
  for (const g of rightRaw) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  for (const g of trailingGroups) out.push(g);
  if (out.length !== 8) return null;
  return out;
}

function isBlockedV6(ip: string): boolean {
  // Normalize zone suffix (`%eth0`) away — RFC4007 zone ids never
  // change which address family / range an address belongs to.
  const stripped = ip.split("%")[0]!;

  // IPv4-mapped forms (`::ffff:1.2.3.4` etc): re-check the embedded
  // v4 address against the v4 block list. Captures the `::ffff:0:0/96`
  // requirement explicitly.
  const mapped = stripped.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) {
    return isBlockedV4(mapped[1]!);
  }

  const groups = ipv6Groups(stripped);
  if (!groups) return false;

  // :: (unspecified) and ::1 (loopback)
  const isAllZero = groups.every((g) => g === 0);
  if (isAllZero) return true;
  const isLoopback =
    groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (isLoopback) return true;

  // fe80::/10 — link-local. First 10 bits = 0xfe80 >> 6 = 0x3fa
  // i.e. groups[0] & 0xffc0 === 0xfe80.
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;

  // fc00::/7 — unique local addresses (RFC4193). First 7 bits = 0xfc/8
  // i.e. groups[0] & 0xfe00 === 0xfc00.
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;

  // IPv4-mapped via group form (::ffff:0:0/96): groups[0..4] = 0,
  // groups[5] = 0xffff. Re-check the embedded v4 address.
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
  ) {
    const v4Num = ((groups[6]! << 16) | groups[7]!) >>> 0;
    const a = (v4Num >>> 24) & 0xff;
    const b = (v4Num >>> 16) & 0xff;
    const c = (v4Num >>> 8) & 0xff;
    const d = v4Num & 0xff;
    return isBlockedV4(`${a}.${b}.${c}.${d}`);
  }

  return false;
}

/**
 * True if `ip` is a literal address in any of the disallowed ranges.
 * Accepts both v4 and v6 literals; returns false for anything
 * `isIP()` doesn't recognize.
 */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return false;
}

// ----- escape hatch for the integration suite --------------------------

/**
 * The integration suite spins up `http.createServer` on 127.0.0.1
 * and points webhooks at it; the production guard would refuse those
 * URLs by design. This escape hatch is honored ONLY when
 * `NODE_ENV=test` — production deployments cannot bypass the SSRF
 * guard even if they set the flag.
 */
function escapeHatchActive(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.WEBHOOK_ALLOW_PRIVATE_FOR_TESTS === "true"
  );
}

// ----- validation-time check ------------------------------------------

/**
 * Reject URLs that would target an internal address. Caller must
 * already have validated http(s) protocol, max length, and absence of
 * userinfo — this function is concerned only with the host.
 *
 * Throws `WebhookValidationError("webhook_url_blocked", ...)` on
 * refusal so the route layer maps to 400 with a clean code.
 */
export async function assertWebhookUrlSafe(parsed: URL): Promise<void> {
  if (escapeHatchActive()) return;

  // `URL` exposes `[ipv6]` in brackets — strip for `isIP` / DNS use.
  const rawHost = parsed.hostname;
  if (!rawHost) {
    throw new WebhookValidationError(
      "webhook_url_invalid",
      "url has no host",
    );
  }

  const host = rawHost.startsWith("[") && rawHost.endsWith("]")
    ? rawHost.slice(1, -1)
    : rawHost;

  // Path A: literal IP. No DNS — just range-check.
  const fam = isIP(host);
  if (fam !== 0) {
    if (isBlockedIp(host)) {
      throw new WebhookValidationError(
        "webhook_url_blocked",
        "url targets a disallowed address range",
      );
    }
    return;
  }

  // Path B: hostname. Reject by-convention names first.
  if (isBlockedHostname(host)) {
    throw new WebhookValidationError(
      "webhook_url_blocked",
      "url targets a disallowed hostname",
    );
  }

  // Path C: hostname → DNS. Reject if ANY returned address is in the
  // block list (a hostname that resolves to a mix of public + private
  // addresses is still unsafe — the connect could land on the
  // private one).
  let addrs: LookupAddress[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new WebhookValidationError(
      "webhook_url_blocked",
      "url host could not be resolved",
    );
  }
  if (addrs.length === 0) {
    throw new WebhookValidationError(
      "webhook_url_blocked",
      "url host could not be resolved",
    );
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new WebhookValidationError(
        "webhook_url_blocked",
        "url host resolves to a disallowed address",
      );
    }
  }
}

// ----- connect-time guard for the worker ------------------------------

/**
 * Build an undici `Agent` whose `connect.lookup` re-resolves the
 * hostname per outbound request and rejects disallowed addresses
 * before TCP connect. The agent is shared across deliveries — undici
 * pools sockets per-origin internally.
 *
 * Why a custom lookup vs. validating once and connecting by IP:
 *   - Re-resolution defeats DNS-rebinding: a hostname can pass
 *     create-time validation today and resolve to 169.254.169.254
 *     tomorrow. The connect-time check catches that.
 *   - undici passes our `lookup` result straight to `net.connect`,
 *     so we can pick the address (public, allowed) and pin the SNI
 *     to the original hostname for TLS.
 */
export function buildSafeAgent(): Agent {
  const allowAll = escapeHatchActive();

  return new Agent({
    connect: {
      lookup(
        hostname: string,
        _opts: unknown,
        cb: (
          err: NodeJS.ErrnoException | null,
          address: string,
          family: number,
        ) => void,
      ) {
        // Test escape hatch: defer to the platform resolver.
        if (allowAll) {
          // Mirror the default Node behavior — pick the first address.
          dnsLookup(hostname, { all: false }).then(
            (a) => cb(null, a.address, a.family),
            (err) => cb(err as NodeJS.ErrnoException, "", 0),
          );
          return;
        }

        // If the URL was already an IP literal, isIP catches it here
        // and we don't need to hit the resolver. Range-check directly.
        const fam = isIP(hostname);
        if (fam !== 0) {
          if (isBlockedIp(hostname)) {
            cb(
              Object.assign(new Error("ssrf_blocked_address"), {
                code: "EWEBHOOK_SSRF_BLOCKED",
              }),
              "",
              0,
            );
            return;
          }
          cb(null, hostname, fam);
          return;
        }

        // Hostname-by-convention check, mirroring the create-time
        // guard. A worker shouldn't have to trust that the row was
        // ever validated.
        if (isBlockedHostname(hostname)) {
          cb(
            Object.assign(new Error("ssrf_blocked_hostname"), {
              code: "EWEBHOOK_SSRF_BLOCKED",
            }),
            "",
            0,
          );
          return;
        }

        dnsLookup(hostname, { all: true }).then(
          (addrs) => {
            // Pick the FIRST allowed address. We could iterate and
            // try each on connect failure, but undici doesn't give us
            // a retry hook here; in practice a single hostname rarely
            // has a public + private mix that needs picking around.
            for (const a of addrs) {
              if (!isBlockedIp(a.address)) {
                cb(null, a.address, a.family);
                return;
              }
            }
            cb(
              Object.assign(new Error("ssrf_blocked_address"), {
                code: "EWEBHOOK_SSRF_BLOCKED",
              }),
              "",
              0,
            );
          },
          (err) => cb(err as NodeJS.ErrnoException, "", 0),
        );
      },
    },
  });
}
