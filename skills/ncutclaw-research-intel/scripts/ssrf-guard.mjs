/**
 * NCUTclaw research-intel — SSRF guard for skill scripts.
 *
 * These scripts run in a child Node process spawned by the Electron main
 * bundle, so they cannot import from electron/main/net/ssrf-fetch.ts.
 * This file is the mjs counterpart, kept intentionally simple:
 *
 *   - Reject non-http(s) schemes
 *   - Reject literal loopback / link-local / private-IP host strings
 *   - DNS-resolve the hostname and reject if ANY A/AAAA record is private
 *
 * It does NOT pin the resolved IP into the actual fetch() call (which
 * would close the DNS-rebinding TOCTOU window the way ssrf-fetch.ts
 * does), because the skill scripts are short-lived workers fetching
 * paper / RSS / search-API URLs the LLM picked, and the cost-benefit
 * here favours simplicity. The dominant risk we close is "LLM returns
 * http://127.0.0.1:18789 / 169.254.169.254 / 192.168.1.1 as a paper URL
 * and we GET it without thinking" — for that, validate-then-fetch is
 * already enough.
 *
 * Callers: resource-utils.mjs::fetchWithRetry (which fetch-rss.mjs and
 * fetch-web.mjs both go through). Add new entry points here as needed.
 */
import { promises as dnsPromises } from 'node:dns'
import { isIPv4, isIPv6 } from 'node:net'

export function isPrivateIp(addr) {
  if (isIPv4(addr)) {
    const parts = addr.split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true
    const [a, b] = parts
    if (a === 10) return true                                  // 10.0.0.0/8
    if (a === 127) return true                                 // loopback
    if (a === 0) return true                                   // 0.0.0.0/8
    if (a === 169 && b === 254) return true                    // link-local
    if (a === 172 && b >= 16 && b <= 31) return true           // 172.16/12
    if (a === 192 && b === 168) return true                    // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true          // CGNAT 100.64/10
    if (a >= 224) return true                                  // multicast / reserved
    return false
  }
  if (isIPv6(addr)) {
    const lower = addr.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('::ffff:')) {
      const suffix = lower.slice(7)
      if (isIPv4(suffix)) return isPrivateIp(suffix)
      const parts = suffix.split(':')
      if (parts.length === 2 && parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
        const hi = parseInt(parts[0], 16)
        const lo = parseInt(parts[1], 16)
        const a = (hi >> 8) & 0xff
        const b = hi & 0xff
        const c = (lo >> 8) & 0xff
        const d = lo & 0xff
        return isPrivateIp(`${a}.${b}.${c}.${d}`)
      }
      return true  // unrecognized ::ffff: suffix — fail closed
    }
    if (lower.startsWith('fe80:') || lower.startsWith('fec0:')) return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('ff')) return true
    return false
  }
  return true  // unparseable → fail closed
}

/**
 * Validate that `urlStr` is safe to fetch from a child-process worker.
 * Returns { ok: true } when caller may proceed, or { ok: false, message }.
 * Resolves DNS once; if any returned address is private, rejects.
 *
 * Disabled when env NCUTCLAW_SSRF_GUARD_DISABLE === '1', for users who
 * deliberately want to point fetch-* at a private mirror. Set this only
 * if you understand the implications.
 */
export async function validateSafeUrl(urlStr) {
  if (process.env.NCUTCLAW_SSRF_GUARD_DISABLE === '1') return { ok: true }
  let parsed
  try {
    parsed = new URL(urlStr)
  } catch {
    return { ok: false, message: 'URL 格式无效' }
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    return { ok: false, message: '仅支持 http/https 协议' }
  }
  const hostname = parsed.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname === '[::1]') {
    return { ok: false, message: '不允许访问内网地址 (localhost)' }
  }
  const stripped = hostname.replace(/^\[|\]$/g, '')
  if (isIPv4(stripped) || isIPv6(stripped)) {
    if (isPrivateIp(stripped)) {
      return { ok: false, message: `不允许访问内网地址 (${stripped})` }
    }
    return { ok: true }
  }
  let addrs
  try {
    addrs = await dnsPromises.lookup(hostname, { all: true, verbatim: true })
  } catch (e) {
    return { ok: false, message: `DNS 解析失败: ${e?.message || e}` }
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    return { ok: false, message: `DNS 未返回任何地址 (${hostname})` }
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      return { ok: false, message: `不允许访问内网地址 (${hostname} → ${a.address})` }
    }
  }
  return { ok: true }
}
