/**
 * Outbound-request safety for claim verification (SSRF protection).
 *
 * Citation URLs come from a third-party web page, so they are untrusted input. Before any request is made we:
 *   1. allow only http:/https: URLs without embedded credentials,
 *   2. reject loopback / private / link-local / metadata / reserved destinations,
 *   3. resolve DNS and reject the host if ANY resolved address is non-public,
 *   4. validate every redirect hop (callers use redirect: "manual"),
 *   5. re-validate the resolved address at connect time (defeats DNS-rebinding between check and use).
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";

export const BLOCKED_ADDRESS_CODE = "EBLOCKED_ADDRESS";

export class BlockedAddressError extends Error {
    constructor(message, address = null) {
        super(message);
        this.name = "BlockedAddressError";
        this.code = BLOCKED_ADDRESS_CODE;
        this.address = address;
    }
}

const IPV4_BLOCKED = [
    ["0.0.0.0", 8], // "this" network
    ["10.0.0.0", 8], // RFC1918
    ["100.64.0.0", 10], // carrier-grade NAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local incl. cloud metadata (169.254.169.254)
    ["172.16.0.0", 12], // RFC1918
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // TEST-NET-1
    ["192.168.0.0", 16], // RFC1918
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // TEST-NET-2
    ["203.0.113.0", 24], // TEST-NET-3
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved + broadcast
];

const IPV6_BLOCKED = [
    ["::", 96], // unspecified, loopback, deprecated IPv4-compatible
    ["64:ff9b::", 96], // NAT64 (embeds IPv4)
    ["100::", 64], // discard-only
    ["2001::", 32], // Teredo
    ["2001:db8::", 32], // documentation
    ["2002::", 16], // 6to4 (embeds IPv4)
    ["fc00::", 7], // unique local
    ["fe80::", 10], // link-local
    ["fec0::", 10], // deprecated site-local
    ["ff00::", 8], // multicast
];

// IPv4-mapped IPv6 (::ffff:a.b.c.d) is evaluated by BlockList against the IPv4 rules above.
const blockList = new net.BlockList();
for (const [addr, prefix] of IPV4_BLOCKED)
    blockList.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of IPV6_BLOCKED)
    blockList.addSubnet(addr, prefix, "ipv6");

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

function bareHost(hostname) {
    return String(hostname ?? "")
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/%.*$/, "")
        .replace(/\.$/, "");
}

/** True when `address` is not a routable public IP (fails closed on anything unparseable). */
export function isBlockedAddress(address) {
    const a = bareHost(address);
    const family = net.isIP(a);
    if (!family)
        return true;
    return blockList.check(a, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Validate the static shape of a URL (scheme, credentials, obviously-internal host names / IP literals).
 * Returns { ok: true, url, host } or { ok: false, reason }.
 */
export function parsePublicUrl(raw) {
    let url;
    try {
        url = new URL(String(raw));
    }
    catch {
        return { ok: false, reason: "invalid_url" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        return { ok: false, reason: "unsupported_protocol" };
    if (url.username || url.password)
        return { ok: false, reason: "credentials_in_url" };
    const host = bareHost(url.hostname);
    if (!host)
        return { ok: false, reason: "invalid_url" };
    if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)))
        return { ok: false, reason: "blocked_address" };
    if (net.isIP(host) && isBlockedAddress(host))
        return { ok: false, reason: "blocked_address" };
    return { ok: true, url, host };
}

/**
 * Resolve `host` and throw BlockedAddressError unless every address is public.
 * `lookupImpl` is promise-style `dns.promises.lookup` (injectable for tests).
 */
export async function assertPublicHost(host, lookupImpl = dns.promises.lookup) {
    if (net.isIP(host)) {
        if (isBlockedAddress(host))
            throw new BlockedAddressError(`Refusing to connect to non-public address ${host}`, host);
        return;
    }
    const resolved = await lookupImpl(host, { all: true, verbatim: true });
    const list = Array.isArray(resolved) ? resolved : [resolved];
    if (list.length === 0)
        throw new BlockedAddressError(`Host ${host} did not resolve to any address`, null);
    for (const entry of list) {
        if (isBlockedAddress(entry.address))
            throw new BlockedAddressError(`Host ${host} resolves to non-public address ${entry.address}`, entry.address);
    }
}

/** Build a `lookup` function for http(s).request that rejects non-public addresses at connect time. */
export function createGuardedLookup({ resolver = dns.lookup, isBlocked = isBlockedAddress } = {}) {
    return function guardedLookup(hostname, options, callback) {
        if (typeof options === "function") {
            callback = options;
            options = {};
        }
        const wantAll = Boolean(options?.all);
        resolver(hostname, { ...options, all: true }, (err, addresses) => {
            if (err)
                return callback(err);
            const list = Array.isArray(addresses) ? addresses : [];
            const bad = list.find((a) => isBlocked(a.address));
            if (list.length === 0 || bad) {
                return callback(new BlockedAddressError(`Host ${hostname} resolves to non-public address ${bad?.address ?? "(none)"}`, bad?.address ?? null));
            }
            if (wantAll)
                return callback(null, list);
            return callback(null, list[0].address, list[0].family);
        });
    };
}

function toHeaders(raw) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(raw)) {
        if (Array.isArray(value))
            value.forEach((v) => headers.append(key, v));
        else if (value !== undefined)
            headers.set(key, String(value));
    }
    return headers;
}

function decodeBody(res) {
    const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
    let decoder = null;
    if (encoding === "gzip" || encoding === "x-gzip")
        decoder = zlib.createGunzip();
    else if (encoding === "deflate")
        decoder = zlib.createInflate();
    else if (encoding === "br")
        decoder = zlib.createBrotliDecompress();
    if (!decoder)
        return { stream: res, decoded: false };
    res.on("error", (e) => decoder.destroy(e));
    decoder.on("close", () => res.destroy());
    res.pipe(decoder);
    return { stream: decoder, decoded: true };
}

/**
 * Create a fetch-compatible function (GET only, never follows redirects) whose sockets can only connect
 * to public addresses. Returns a standard `Response`.
 */
export function createSafeFetch({ resolver = dns.lookup, isBlocked = isBlockedAddress } = {}) {
    const lookup = createGuardedLookup({ resolver, isBlocked });
    return function safeFetch(input, { method = "GET", headers = {}, signal } = {}) {
        return new Promise((resolve, reject) => {
            let url;
            try {
                url = new URL(String(input));
            }
            catch (err) {
                return reject(err);
            }
            if (url.protocol !== "http:" && url.protocol !== "https:")
                return reject(new BlockedAddressError(`Unsupported protocol ${url.protocol}`));
            const literal = bareHost(url.hostname);
            if (net.isIP(literal) && isBlocked(literal))
                return reject(new BlockedAddressError(`Refusing to connect to non-public address ${literal}`, literal));
            const lib = url.protocol === "https:" ? https : http;
            const req = lib.request(url, { method, headers: { "Accept-Encoding": "gzip, deflate, br", ...headers }, lookup, signal }, (res) => {
                const status = res.statusCode ?? 0;
                const responseHeaders = toHeaders(res.headers);
                const nullBody = status === 204 || status === 205 || status === 304 || status < 200;
                let body = null;
                if (!nullBody) {
                    const { stream, decoded } = decodeBody(res);
                    if (decoded) {
                        responseHeaders.delete("content-encoding");
                        responseHeaders.delete("content-length");
                    }
                    body = Readable.toWeb(stream);
                }
                else {
                    res.resume();
                }
                resolve(new Response(body, { status: Math.min(Math.max(status, 200), 599), statusText: res.statusMessage, headers: responseHeaders }));
            });
            req.on("error", reject);
            req.end();
        });
    };
}

export const safeFetch = createSafeFetch();
