import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

export function expandStorageDir(task) {
  let storageDir = task.storageDir
  if (storageDir && storageDir.startsWith('~')) {
    storageDir = join(homedir(), storageDir.slice(1))
  } else if (!storageDir) {
    storageDir = join(homedir(), '.ncutclaw/workspace/research-data', task.id)
  }
  return storageDir
}

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''))
}

export function hashKey(input) {
  return createHash('sha1').update(String(input || '')).digest('hex')
}

export function sanitizeFileName(value, fallback = 'resource') {
  const normalized = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return fallback
  return normalized.slice(0, 96)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseRetryAfterSeconds(resp) {
  const value = Number.parseInt(String(resp.headers.get('retry-after') || '').trim(), 10)
  if (!Number.isFinite(value) || value < 0) return 0
  return value
}

// maxBackoffMs caps both the synthesized exponential backoff AND the
// Retry-After value. We still honor Retry-After as the minimum signal
// (servers know their own rate-limit window) but refuse to wait longer
// than the caller asked for — e.g. Semantic Scholar sometimes asks for
// 120s on anonymous calls, which would blow the outer fetch-web 90s
// script timeout. Better to fail fast than hang the whole pipeline.
function computeRetryDelay(attempt, resp, maxBackoffMs) {
  const retryAfterSeconds = resp ? parseRetryAfterSeconds(resp) : 0
  if (retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, maxBackoffMs)
  const baseDelay = 800 * (2 ** attempt)
  const jitter = Math.floor(Math.random() * 250)
  return Math.min(baseDelay + jitter, maxBackoffMs)
}

export async function fetchWithRetry(url, options = {}, config = {}) {
  const maxRetries = Number.isFinite(Number(config.maxRetries)) ? Number(config.maxRetries) : 3
  const maxBackoffMs = Number.isFinite(Number(config.maxBackoffMs)) ? Number(config.maxBackoffMs) : 8000
  let lastError = null

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let resp = null
    try {
      resp = await fetch(url, options)
      if (resp.ok) return resp

      const shouldRetry = resp.status === 429 || resp.status >= 500
      if (!shouldRetry || attempt === maxRetries) {
        throw new Error(`HTTP ${resp.status}`)
      }
    } catch (error) {
      lastError = error
      if (attempt === maxRetries) break
    }

    await sleep(computeRetryDelay(attempt, resp, maxBackoffMs))
  }

  throw lastError || new Error('request failed')
}

function buildPaperDownloadPath(task, provider, title, stableId, pdfUrl) {
  const baseDir = join(expandStorageDir(task), 'papers', sanitizeFileName(provider || 'paper-provider', 'paper-provider'))
  mkdirSync(baseDir, { recursive: true })

  const safeTitle = sanitizeFileName(title || 'paper', 'paper')
  const safeId = sanitizeFileName(stableId || hashKey(pdfUrl || safeTitle), 'paper')
  return join(baseDir, `${safeTitle}_${safeId}.pdf`)
}

export async function downloadPaperPdf(task, provider, {
  title,
  stableId,
  pdfUrl,
  pdfUrlCandidates = [],
  headers = {},
}) {
  const candidateUrls = [...new Set(
    [pdfUrl, ...pdfUrlCandidates]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )]

  if (candidateUrls.length === 0) return ''

  const outputPath = buildPaperDownloadPath(task, provider, title, stableId, candidateUrls[0])
  if (existsSync(outputPath)) return outputPath

  let lastError = null
  for (const url of candidateUrls) {
    try {
      const resp = await fetchWithRetry(url, {
        headers: {
          'User-Agent': 'NCUTclaw-Research-Bot/2.0',
          'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
          ...headers,
        },
      }, {
        maxRetries: 3,
      })

      const contentType = String(resp.headers.get('content-type') || '').toLowerCase()
      if (contentType.includes('text/html')) {
        throw new Error('unexpected HTML response')
      }

      const buffer = Buffer.from(await resp.arrayBuffer())
      if (buffer.length === 0) {
        throw new Error('empty response body')
      }

      writeFileSync(outputPath, buffer)
      return outputPath
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error('download failed')
}
