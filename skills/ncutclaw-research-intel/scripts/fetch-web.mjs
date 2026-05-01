import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  downloadPaperPdf,
  expandStorageDir,
  fetchWithRetry,
  hashKey,
  readJsonFile,
} from './resource-utils.mjs'

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileCb(command, args, { ...options, encoding: 'utf-8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

function getOpenClawStateDir() {
  const fromEnv = String(process.env.OPENCLAW_STATE_DIR || '').trim()
  return fromEnv || join(homedir(), '.ncutclaw')
}

function resolveYtDlpCommand() {
  const stateDir = getOpenClawStateDir()
  const localName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const localPath = join(stateDir, 'bin', localName)
  return existsSync(localPath) ? localPath : 'yt-dlp'
}

// Mirrors VALID_COOKIES_BROWSERS in electron/main/research-download.ts.
// Kept in sync by hand because this script runs in a separate Node child
// process and cannot import from the Electron main bundle.
const VALID_COOKIES_BROWSERS = new Set([
  'chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'safari', 'chromium', 'whale',
])

// NCUTclaw-only state lives in ncutclaw.json (sibling of openclaw.json).
// openclaw.json is the Gateway's strict-schema config and rejects any
// unknown root key (e.g. "downloads", "research") with exit code 1, so
// app-level state must NOT live there. We still read openclaw.json as a
// fall-back for users running this script from a checkout where the
// migration in electron/main/config.ts hasn't run yet — once the app
// starts up once, ncutclaw.json wins.
function loadNcutclawAppConfig() {
  const stateDir = getOpenClawStateDir()
  // Try the new app-config file first.
  try {
    return readJsonFile(join(stateDir, 'ncutclaw.json'))
  } catch {
    // Fall through to legacy lookup.
  }
  // Legacy: read from openclaw.json. Old NCUTclaw versions wrote
  // downloads/research keys here; the parent app migrates them away on
  // next startup, but this script can run before that migration.
  try {
    return readJsonFile(join(stateDir, 'openclaw.json'))
  } catch {
    return null
  }
}

function loadCookiesPath() {
  try {
    const config = loadNcutclawAppConfig()
    const filePath = typeof config?.downloads?.cookiesFile === 'string'
      ? config.downloads.cookiesFile.trim()
      : ''
    return filePath || ''
  } catch {
    return ''
  }
}

function loadCookiesBrowser() {
  try {
    const config = loadNcutclawAppConfig()
    const browser = typeof config?.downloads?.cookiesBrowser === 'string'
      ? config.downloads.cookiesBrowser.trim().toLowerCase()
      : ''
    return browser && VALID_COOKIES_BROWSERS.has(browser) ? browser : ''
  } catch {
    return ''
  }
}

// Build yt-dlp cookies args. Browser > file > none. Mirrors the same
// helper in research-download.ts. Returns string[] for spread into argv.
function buildYtDlpCookiesArgs() {
  const browser = loadCookiesBrowser()
  if (browser) return ['--cookies-from-browser', browser]
  const file = loadCookiesPath()
  if (file && existsSync(file)) return ['--cookies', file]
  return []
}

// Optional. Users can paste a free API key from
// https://www.semanticscholar.org/product/api#api-key-form into
// ~/.ncutclaw/ncutclaw.json as { "research": { "semanticScholarApiKey": "..." } }
// to lift the anonymous rate limit (100 req / 5min) to the keyed tier
// (1000 req / sec). Without a key we still try, just with more aggressive
// retries and a higher chance of returning 0 items under load.
function loadSemanticScholarApiKey() {
  try {
    const config = loadNcutclawAppConfig()
    const key = typeof config?.research?.semanticScholarApiKey === 'string'
      ? config.research.semanticScholarApiKey.trim()
      : ''
    return key || ''
  } catch {
    return ''
  }
}

const SEMANTIC_SCHOLAR_FIELDS = [
  'title',
  'authors',
  'year',
  'abstract',
  'url',
  'venue',
  'paperId',
  'openAccessPdf',
  'externalIds',
]

function appendSearchList(url, paramName, requiredValues) {
  try {
    const parsed = new URL(url)
    const current = parsed.searchParams.get(paramName)
      ? parsed.searchParams.get(paramName).split(',').map((item) => item.trim()).filter(Boolean)
      : []

    for (const value of requiredValues) {
      if (!current.includes(value)) current.push(value)
    }

    if (current.length > 0) {
      parsed.searchParams.set(paramName, current.join(','))
    }
    return parsed.toString()
  } catch {
    return url
  }
}

function prepareSemanticScholarUrl(url) {
  const prepared = appendSearchList(url, 'fields', SEMANTIC_SCHOLAR_FIELDS)
  try {
    const parsed = new URL(prepared)
    if (!parsed.searchParams.get('limit')) {
      parsed.searchParams.set('limit', '20')
    }
    return parsed.toString()
  } catch {
    return prepared
  }
}

function inferProvider(source) {
  const label = String(source?.label || '').toLowerCase()
  const url = String(source?.url || '').toLowerCase()

  if (label.includes('semantic') || url.includes('api.semanticscholar.org')) return 'semantic-scholar'
  if (label === 'scholar' || url.includes('scholar.google.com')) return 'scholar'
  if (label.includes('github') || url.includes('api.github.com')) return 'github'
  if (label.includes('youtube') || url.includes('youtu.be') || url.includes('youtube.com')) return 'youtube'
  if (label.includes('bili') || url.includes('bilibili.com') || url.includes('api.bilibili.com')) return 'bilibili'
  if (label.includes('xiaohongshu') || url.includes('xiaohongshu.com')) return 'xiaohongshu'
  if (label.includes('douyin') || url.includes('douyin.com') || url.includes('v.douyin.com')) return 'douyin'
  return 'web'
}

function toLegacyItem(resource) {
  return {
    title: resource.title,
    link: resource.url,
    summary: resource.abstractOrDescription || resource.aiSummary || resource.whatItDoes || '',
    date: resource.publishedAt || resource.fetchedAt || new Date().toISOString(),
  }
}

function buildResource(task, provider, partial) {
  const url = String(partial.url || '').trim()
  const dedupKey = partial.dedupKey || `${provider}:${partial.arxivId || partial.videoId || hashKey(url)}`
  const localPath = String(partial.localPath || '').trim()
  const downloadError = String(partial.downloadError || '').trim()
  const downloadStatus = partial.downloadStatus || (
    localPath
      ? 'completed'
      : (downloadError
          ? 'failed'
          : ((partial.resourceType === 'repo' || partial.resourceType === 'web') ? 'not_applicable' : 'none'))
  )
  const downloadAttempts = Number.isFinite(Number(partial.downloadAttempts))
    ? Number(partial.downloadAttempts)
    : ((localPath || downloadError) ? 1 : 0)
  const downloadedAt = String(partial.downloadedAt || '').trim() || (localPath ? new Date().toISOString() : '')

  return {
    id: `${task.id}_${hashKey(dedupKey)}`,
    taskId: task.id,
    resourceType: partial.resourceType || 'web',
    provider,
    title: partial.title || '(未命名资源)',
    authorsOrChannel: partial.authorsOrChannel || '',
    publishedAt: partial.publishedAt || '',
    url,
    localPath,
    downloadStatus,
    downloadError,
    downloadAttempts,
    downloadedAt,
    abstractOrDescription: partial.abstractOrDescription || '',
    aiSummary: partial.aiSummary || '',
    // Generic guard: clear whatItDoes if it duplicates abstractOrDescription
    whatItDoes: (partial.whatItDoes || '').trim() === (partial.abstractOrDescription || '').trim()
      ? '' : (partial.whatItDoes || ''),
    method: partial.method || '',
    result: partial.result || '',
    relevanceToTopic: partial.relevanceToTopic || '',
    fetchedAt: new Date().toISOString(),
    dedupKey,
    meta: partial.meta || {},
  }
}

async function fetchJson(url, headers = {}) {
  const resp = await fetchWithRetry(url, { headers }, { maxRetries: 3 })
  return await resp.json()
}

async function fetchText(url, headers = {}) {
  const resp = await fetchWithRetry(url, { headers }, { maxRetries: 3 })
  return await resp.text()
}

function matchKeywords(resources, keywords) {
  if (keywords.length === 0) return resources
  return resources.filter((item) => {
    const blob = `${item.title} ${item.abstractOrDescription}`.toLowerCase()
    return keywords.some((kw) => blob.includes(kw))
  })
}

/**
 * Filter papers to prefer recent 2 years. If too few remain, gradually relax.
 */
function filterRecentPapers(resources, minCount = 5, maxResults = 15) {
  const currentYear = new Date().getFullYear()
  const minYear = currentYear - 2

  const recent = resources.filter((r) => {
    const year = parseInt(r.publishedAt, 10)
    if (Number.isNaN(year)) return true  // keep items with unknown date
    return year >= minYear
  })

  // Sort + cap to maxResults: papers piled up by recency tend to dwarf the
  // round-robin video quota in the briefing, costing tokens on AI summary
  // generation even when most aren't read. maxResults=15 is enough to
  // surface a useful daily digest without overwhelming.
  const sortByDate = (arr) => arr.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))

  if (recent.length >= minCount) {
    return sortByDate(recent).slice(0, maxResults)
  }
  // Not enough recent — fall back to all sorted, still capped.
  return sortByDate(resources).slice(0, maxResults)
}

/**
 * Filter videos by quality signals: minimum view count and duration.
 * If at least `minCount` items pass the thresholds, return only those
 * (sorted by play desc). Otherwise fall back to "all sorted by play".
 *
 * minCount default 3 implements the user's "超过三个就挑高质量" rule for
 * non-paper sources — once a source returns more than ~3 items the
 * filter starts kicking in; below that everything is returned because
 * filtering 1–2 items defeats the point. Papers use minCount=5 via
 * filterRecentPapers / fetch-rss recency gate.
 */
function filterVideoQuality(resources, minCount = 3, maxResults = 8) {
  const MIN_VIEWS = 100       // minimum play count
  const MIN_DURATION_SEC = 60 // minimum 1 minute (filter out very short clips)

  const scored = resources.map((r) => {
    const play = Number(r.meta?.play) || 0
    const duration = parseDurationToSeconds(r.meta?.duration)
    return { resource: r, play, duration }
  })

  // Filter by quality thresholds, then cap to maxResults. Without the cap a
  // popular keyword (e.g. LLM tutorials on bilibili) can return 20+ quality
  // hits and the round-robin downloader spends 5–10 minutes on a single
  // task pass. Top-8 by play keeps the user-perceived "best" subset.
  const quality = scored.filter((s) => s.play >= MIN_VIEWS && s.duration >= MIN_DURATION_SEC)

  if (quality.length >= minCount) {
    quality.sort((a, b) => b.play - a.play)
    return quality.slice(0, maxResults).map((s) => s.resource)
  }

  // Not enough quality results, sort all by views and return (also capped).
  scored.sort((a, b) => b.play - a.play)
  return scored.slice(0, maxResults).map((s) => s.resource)
}

/**
 * Filter GitHub repos by quality signals: minimum stargazer count.
 * GitHub's search API URL already passes `&sort=stars`, so input is
 * descending by stars; we only need to drop low-quality tail entries.
 * Same minCount=3 escape hatch as filterVideoQuality so a niche topic
 * with only 1–2 high-star repos doesn't return an empty list.
 */
function filterRepoQuality(resources, minCount = 3, maxResults = 6) {
  const MIN_STARS = 50

  const scored = resources.map((r) => ({
    resource: r,
    stars: Number(r.meta?.stars) || 0,
  }))

  const quality = scored.filter((s) => s.stars >= MIN_STARS)

  // Top-N cap: github search returns up to 100 repos and most LLM-related
  // keywords surface dozens of high-star repos. The briefing only needs a
  // handful of representative high-quality ones — beyond that, AI summary
  // tokens get spent listing repos the user won't read.
  if (quality.length >= minCount) {
    quality.sort((a, b) => b.stars - a.stars)
    return quality.slice(0, maxResults).map((s) => s.resource)
  }

  // Fallback path (not enough above-MIN_STARS): also cap so a niche topic
  // doesn't accidentally return 30 low-star tail repos.
  scored.sort((a, b) => b.stars - a.stars)
  return scored.slice(0, maxResults).map((s) => s.resource)
}

function parseDurationToSeconds(raw) {
  if (typeof raw === 'number') return raw
  if (typeof raw !== 'string' || !raw.trim()) return 0
  // Format "MM:SS" or "HH:MM:SS"
  const parts = raw.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return Number(raw) || 0
}

async function parseSemanticScholar(task, source) {
  const url = prepareSemanticScholarUrl(source.url)
  const apiKey = loadSemanticScholarApiKey()
  // With an API key we're on the keyed tier and normal retry budget is
  // plenty. Without one we're sharing the anonymous 100-req / 5-min pool
  // with every other SS caller in the world — bump retries and widen
  // the backoff cap so a transient 429 at start-of-task doesn't turn
  // into a zero-paper run. The overall cap stays under the fetch-web
  // 90s script timeout so one sticky source can't blow the budget.
  const headers = apiKey ? { 'x-api-key': apiKey } : {}
  const retryConfig = apiKey
    ? { maxRetries: 3, maxBackoffMs: 8000 }
    : { maxRetries: 5, maxBackoffMs: 20000 }

  let data
  try {
    const resp = await fetchWithRetry(url, { headers }, retryConfig)
    data = await resp.json()
  } catch (err) {
    console.warn(`[fetch-web] Semantic Scholar unavailable${apiKey ? ' (with API key)' : ' (anonymous, likely rate-limited — add an API key in ~/.ncutclaw/ncutclaw.json under research.semanticScholarApiKey; do NOT use openclaw.json — Gateway will reject unknown root keys)'}: ${err?.message || err} — skipping`)
    return []
  }
  const papers = Array.isArray(data?.data) ? data.data : []

  return await Promise.all(papers.map(async (paper) => {
    const paperId = paper?.paperId || ''
    const arxivId = paper?.externalIds?.ArXiv || paper?.externalIds?.ARXIV || ''
    const paperUrl = paper?.url
      || (paperId ? `https://www.semanticscholar.org/paper/${paperId}` : '')
      || (arxivId ? `https://arxiv.org/abs/${arxivId}` : source.url)
    const pdfUrl = paper?.openAccessPdf?.url
      || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : '')

    let localPath = ''
    let downloadError = ''
    if (pdfUrl) {
      try {
        localPath = await downloadPaperPdf(task, 'semantic-scholar', {
          title: paper?.title || paperId || arxivId || 'semantic-scholar-paper',
          stableId: paperId || arxivId,
          pdfUrl,
          pdfUrlCandidates: arxivId ? [`https://export.arxiv.org/pdf/${arxivId}.pdf`] : [],
        })
      } catch (error) {
        downloadError = error?.message || String(error)
        console.warn(`[fetch-web] Semantic Scholar PDF download failed for ${paper?.title || paperId || arxivId}: ${downloadError}`)
      }
    }

    return buildResource(task, 'semantic-scholar', {
      resourceType: 'paper',
      title: paper?.title || 'Untitled',
      authorsOrChannel: Array.isArray(paper?.authors) ? paper.authors.map((a) => a?.name).filter(Boolean).join(', ') : '',
      publishedAt: paper?.year ? `${paper.year}-01-01` : '',
      url: paperUrl,
      localPath,
      downloadError,
      downloadStatus: localPath ? 'completed' : (downloadError ? 'failed' : 'none'),
      downloadAttempts: pdfUrl ? 1 : 0,
      downloadedAt: localPath ? new Date().toISOString() : '',
      abstractOrDescription: paper?.abstract || '',
      whatItDoes: '',  // paper whatItDoes left empty — abstract shown separately, translated in briefing
      dedupKey: paperId ? `semantic:${paperId}` : undefined,
      meta: {
        paperId,
        venue: paper?.venue,
        pdfUrl,
        arxivId,
        ...(downloadError ? { downloadError } : {}),
      },
    })
  }))
}

async function parseGitHub(task, source) {
  const data = await fetchJson(source.url, {
    'User-Agent': 'NCUTclawBot/2.0',
    'Accept': 'application/vnd.github+json',
  })
  const repos = Array.isArray(data?.items) ? data.items : []

  return repos.map((repo) => buildResource(task, 'github', {
    resourceType: 'repo',
    title: repo?.full_name || repo?.name || 'Untitled Repo',
    authorsOrChannel: repo?.owner?.login || '',
    publishedAt: repo?.updated_at || '',
    url: repo?.html_url || source.url,
    abstractOrDescription: repo?.description || '',
    whatItDoes: '',
    dedupKey: repo?.id ? `github:${repo.id}` : undefined,
    meta: { stars: repo?.stargazers_count || 0, language: repo?.language || '' },
  }))
}

async function parseBilibili(task, source) {
  const data = await fetchJson(source.url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
    'Referer': 'https://www.bilibili.com',
  })
  const list = Array.isArray(data?.data?.result) ? data.data.result : []

  return list.map((item) => {
    const bvid = item?.bvid || item?.arcurl?.split('/').filter(Boolean).pop() || ''
    const arcUrl = item?.arcurl || (bvid ? `https://www.bilibili.com/video/${bvid}` : source.url)
    const title = String(item?.title || '').replace(/<[^>]+>/g, '')
    const desc = String(item?.description || '').replace(/<[^>]+>/g, '')

    return buildResource(task, 'bilibili', {
      resourceType: 'video',
      title: title || 'B站视频',
      authorsOrChannel: item?.author || '',
      publishedAt: item?.pubdate ? new Date(Number(item.pubdate) * 1000).toISOString() : '',
      url: arcUrl,
      abstractOrDescription: desc,
      whatItDoes: desc ? '' : '',  // video whatItDoes left empty to avoid duplicating description
      dedupKey: bvid ? `bilibili:${bvid}` : undefined,
      meta: { duration: item?.duration || '', play: item?.play || 0 },
    })
  })
}

// Convert yt-dlp's upload_date (YYYYMMDD) to ISO 8601 date. yt-dlp omits
// time-of-day for search-page entries, so noon UTC is a stable, sortable
// proxy that won't accidentally fall on the wrong calendar day in any
// timezone the briefing renders in.
function ytDlpUploadDateToIso(upload_date) {
  if (typeof upload_date !== 'string' || !/^\d{8}$/.test(upload_date)) return ''
  const y = upload_date.slice(0, 4)
  const m = upload_date.slice(4, 6)
  const d = upload_date.slice(6, 8)
  return `${y}-${m}-${d}T12:00:00.000Z`
}

// Run `yt-dlp ytsearchN:<query> --flat-playlist --dump-json` and yield
// one parsed JSON object per result line. Cookies file is honored when
// configured — YouTube serves much richer / less throttled metadata to
// authenticated requests, and unauthenticated runs are increasingly likely
// to return 0 results. Returns [] on any failure so the caller can fall
// back to the HTML-scrape path.
async function ytDlpSearch(query, limit = 20) {
  const cookiesArgs = buildYtDlpCookiesArgs()
  const args = [
    `ytsearch${limit}:${query}`,
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
    ...cookiesArgs,
  ]

  try {
    const { stdout } = await execFileAsync(resolveYtDlpCommand(), args, {
      // 90s covers slow networks; --flat-playlist is metadata-only so it
      // shouldn't take this long under normal conditions.
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    const lines = String(stdout || '').split(/\r?\n/).filter((line) => line.trim().length > 0)
    const items = []
    for (const line of lines) {
      try {
        items.push(JSON.parse(line))
      } catch {
        // Skip malformed lines (yt-dlp occasionally interleaves status output)
      }
    }
    return items
  } catch (err) {
    const noCookies = cookiesArgs.length === 0
    console.warn(`[fetch-web] yt-dlp ytsearch failed${noCookies ? ' (no cookies — YouTube often blocks anonymous searches; configure cookies in settings)' : ''}: ${err?.message || err}`)
    return []
  }
}

async function parseYoutube(task, source) {
  const url = String(source.url || '')

  // Real YouTube Data API v3 — caller pasted a v3 search endpoint with their
  // own key. Untouched: when the user has gone to that trouble, they want
  // exactly that, not a yt-dlp substitute.
  if (url.includes('googleapis.com/youtube/v3/search') || url.includes('youtube.googleapis.com/youtube/v3/search')) {
    const data = await fetchJson(url)
    const items = Array.isArray(data?.items) ? data.items : []
    return items
      .filter((item) => item?.id?.videoId)
      .map((item) => buildResource(task, 'youtube', {
        resourceType: 'video',
        title: item?.snippet?.title || 'YouTube Video',
        authorsOrChannel: item?.snippet?.channelTitle || '',
        publishedAt: item?.snippet?.publishedAt || '',
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        abstractOrDescription: item?.snippet?.description || '',
        whatItDoes: '',  // video whatItDoes left empty to avoid duplicating description
        dedupKey: `youtube:${item.id.videoId}`,
        meta: { videoId: item.id.videoId },
      }))
  }

  // Search-page URL produced by buildSourcesFromTypes / getYoutubeSearchUrl
  // (research-storage.ts) — switch from the old HTML scrape (which YouTube
  // increasingly serves bot-detection markup for, returning 0 results) to
  // `yt-dlp ytsearchN:`. Same call shape as the Douyin metadata pipeline,
  // honors cookies, returns flat-playlist metadata so we don't pay one
  // request per video.
  const isSearchPage = /youtube\.com\/results\?/i.test(url)
  if (isSearchPage) {
    let query = ''
    try {
      query = new URL(url).searchParams.get('search_query') || ''
    } catch {
      // fall through — query stays empty, ytsearch returns nothing, we
      // drop into HTML scrape below
    }
    if (query) {
      const items = await ytDlpSearch(query, 20)
      const dedup = new Set()
      const resources = []
      for (const item of items) {
        const videoId = item?.id || item?.url
        if (!videoId || typeof videoId !== 'string' || dedup.has(videoId)) continue
        dedup.add(videoId)
        const watchUrl = videoId.startsWith('http')
          ? videoId
          : `https://www.youtube.com/watch?v=${videoId}`
        resources.push(buildResource(task, 'youtube', {
          resourceType: 'video',
          title: item?.title || 'YouTube Video',
          authorsOrChannel: item?.uploader || item?.channel || item?.uploader_id || '',
          publishedAt: ytDlpUploadDateToIso(item?.upload_date),
          url: watchUrl,
          abstractOrDescription: item?.description || '',
          whatItDoes: '',
          dedupKey: `youtube:${videoId}`,
          meta: {
            videoId,
            // filterVideoQuality reads play (view count) and duration (seconds).
            play: Number(item?.view_count) || 0,
            duration: Number(item?.duration) || 0,
          },
        }))
      }
      // Only fall through to HTML scrape if yt-dlp produced literally nothing
      // — likely means binary missing or YouTube blocking. If yt-dlp gave us
      // even one result, trust it and return.
      if (resources.length > 0) return resources
    }
  }

  // Last-resort HTML scrape. Kept because (a) yt-dlp may not be installed
  // on first run before `resolveYtDlpPath()` in research-download.ts has
  // had a chance to fetch it, and (b) some custom URLs aren't search pages
  // and we still want a best-effort path for them.
  const html = await fetchText(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NCUTclawBot/2.0',
    'Accept-Language': 'en-US,en;q=0.8',
  })

  const matches = [...html.matchAll(/"videoId":"([^"]+)"[\s\S]{0,240}?"title":\{"runs":\[\{"text":"([^"]+)"/g)]
  const dedup = new Set()
  const resources = []
  for (const m of matches) {
    const videoId = m[1]
    const title = m[2]
    if (!videoId || dedup.has(videoId)) continue
    dedup.add(videoId)
    resources.push(buildResource(task, 'youtube', {
      resourceType: 'video',
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      abstractOrDescription: '',
      whatItDoes: '',
      dedupKey: `youtube:${videoId}`,
      meta: { videoId },
    }))
    if (resources.length >= 20) break
  }
  return resources
}

async function parseXiaohongshu(task, source) {
  // yt-dlp has a dedicated xiaohongshu extractor that reads window.__INITIAL_STATE__
  // and returns structured metadata (title, description, uploader, tags, media).
  // Falls back to raw HTML title/description when yt-dlp fails — typically that
  // means cookies are stale or the note requires login. Same shape as parseDouyin
  // so both platforms are at parity: URL-import only, yt-dlp first, HTML fallback.
  try {
    const args = ['--dump-single-json', '--no-download', ...buildYtDlpCookiesArgs()]
    args.push(source.url)

    const { stdout } = await execFileAsync(resolveYtDlpCommand(), args, {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })

    const meta = JSON.parse(stdout || '{}')
    const timestamp = Number(meta?.timestamp)
    return [buildResource(task, 'xiaohongshu', {
      resourceType: 'video',
      title: meta?.title || '小红书内容',
      authorsOrChannel: meta?.uploader || meta?.channel || meta?.creator || '',
      publishedAt: Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp * 1000).toISOString()
        : '',
      url: meta?.webpage_url || source.url,
      abstractOrDescription: meta?.description || '',
      whatItDoes: '',
      dedupKey: meta?.id ? `xiaohongshu:${meta.id}` : `xiaohongshu:${hashKey(source.url)}`,
      meta: {
        duration: meta?.duration || '',
        play: meta?.view_count || 0,
      },
    })]
  } catch (error) {
    console.warn(`[fetch-web] Xiaohongshu yt-dlp metadata failed: ${error?.message || error}`)
  }

  const html = await fetchText(source.url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NCUTclawBot/2.0',
  })
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i)
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']/i)

  return [buildResource(task, 'xiaohongshu', {
    resourceType: 'video',
    title: titleMatch?.[1]?.trim() || '小红书内容',
    url: source.url,
    abstractOrDescription: descMatch?.[1]?.trim() || '',
    whatItDoes: (descMatch?.[1] || '').slice(0, 180),
    dedupKey: `xiaohongshu:${hashKey(source.url)}`,
  })]
}

async function parseDouyin(task, source) {
  try {
    const args = ['--dump-single-json', '--no-download', ...buildYtDlpCookiesArgs()]
    args.push(source.url)

    const { stdout } = await execFileAsync(resolveYtDlpCommand(), args, {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })

    const meta = JSON.parse(stdout || '{}')
    const timestamp = Number(meta?.timestamp)
    return [buildResource(task, 'douyin', {
      resourceType: 'video',
      title: meta?.title || '抖音内容',
      authorsOrChannel: meta?.uploader || meta?.channel || meta?.creator || '',
      publishedAt: Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp * 1000).toISOString()
        : '',
      url: meta?.webpage_url || source.url,
      abstractOrDescription: meta?.description || '',
      whatItDoes: '',
      dedupKey: meta?.id ? `douyin:${meta.id}` : `douyin:${hashKey(source.url)}`,
      meta: {
        duration: meta?.duration || '',
        play: meta?.view_count || 0,
      },
    })]
  } catch (error) {
    console.warn(`[fetch-web] Douyin yt-dlp metadata failed: ${error?.message || error}`)
  }

  const html = await fetchText(source.url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NCUTclawBot/2.0',
  })
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i)
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']/i)

  return [buildResource(task, 'douyin', {
    resourceType: 'video',
    title: titleMatch?.[1]?.trim() || '抖音内容',
    url: source.url,
    abstractOrDescription: descMatch?.[1]?.trim() || '',
    whatItDoes: '',
    dedupKey: `douyin:${hashKey(source.url)}`,
  })]
}

function extractText(html, url) {
  let bodyHTML = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')

  const articleMatch = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(bodyHTML)
  const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(bodyHTML)
  if (articleMatch) bodyHTML = articleMatch[1]
  else if (mainMatch) bodyHTML = mainMatch[1]
  else {
    const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(bodyHTML)
    if (bodyMatch) bodyHTML = bodyMatch[1]
  }

  const text = bodyHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch ? titleMatch[1].trim() : 'Web Content'

  return { title, summary: text.slice(0, 1000), link: url }
}

async function parseGenericWeb(task, source) {
  const html = await fetchText(source.url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NCUTclawBot/2.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  })

  const item = extractText(html, source.url)
  return [buildResource(task, 'web', {
    resourceType: 'web',
    title: item.title,
    url: item.link,
    abstractOrDescription: item.summary,
    whatItDoes: item.summary.slice(0, 180),
    dedupKey: `web:${hashKey(item.link)}`,
  })]
}

async function parseGoogleScholar(task, source) {
  const html = await fetchText(source.url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
    'Accept-Language': 'en-US,en;q=0.8',
  })

  const resources = []
  // Extract paper entries from Google Scholar HTML
  const entryRegex = /<div class="gs_ri">([\s\S]*?)<\/div>\s*<\/div>/g
  let match
  while ((match = entryRegex.exec(html)) !== null) {
    const block = match[1]
    const titleMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
    const snippetMatch = block.match(/<div class="gs_rs">([\s\S]*?)<\/div>/)
    const metaMatch = block.match(/<div class="gs_a">([\s\S]*?)<\/div>/)

    const title = (titleMatch?.[2] || '').replace(/<[^>]+>/g, '').trim()
    const url = titleMatch?.[1] || ''
    const snippet = (snippetMatch?.[1] || '').replace(/<[^>]+>/g, '').trim()
    const meta = (metaMatch?.[1] || '').replace(/<[^>]+>/g, '').trim()
    // Meta format: "Authors - Journal, Year - Publisher"
    const authors = meta.split(' - ')[0] || ''
    const yearMatch = meta.match(/(\d{4})/)

    if (!title || !url) continue

    resources.push(buildResource(task, 'scholar', {
      resourceType: 'paper',
      title,
      authorsOrChannel: authors,
      publishedAt: yearMatch ? `${yearMatch[1]}-01-01` : '',
      url: url.startsWith('http') ? url : `https://scholar.google.com${url}`,
      abstractOrDescription: snippet,
      whatItDoes: snippet.slice(0, 180),
      dedupKey: `scholar:${hashKey(url)}`,
    }))
    if (resources.length >= 20) break
  }
  return resources
}

async function fetchBySource(task, source) {
  const provider = inferProvider(source)
  if (provider === 'semantic-scholar') return await parseSemanticScholar(task, source)
  if (provider === 'scholar') return await parseGoogleScholar(task, source)
  if (provider === 'github') return await parseGitHub(task, source)
  if (provider === 'youtube') return await parseYoutube(task, source)
  if (provider === 'bilibili') return await parseBilibili(task, source)
  if (provider === 'xiaohongshu') return await parseXiaohongshu(task, source)
  if (provider === 'douyin') return await parseDouyin(task, source)
  return await parseGenericWeb(task, source)
}

async function main() {
  const taskIdx = process.argv.indexOf('--task')
  if (taskIdx === -1 || taskIdx === process.argv.length - 1) {
    console.error('Usage: node fetch-web.mjs --task <path/to/task.json>')
    process.exit(1)
  }

  const taskPath = process.argv[taskIdx + 1]
  const task = readJsonFile(taskPath)
  const webSources = task.sources?.filter((s) => s.type === 'web') || []

  if (webSources.length === 0) {
    console.log('[fetch-web] No web sources found for this task')
    return
  }

  // Honour --date from the parent (research.ts threads runDate). Local
  // YYYY-MM-DD fallback for ad-hoc CLI runs; UTC slice was racing the
  // user's wall clock around midnight CST.
  const dateIdx = process.argv.indexOf('--date')
  const today = dateIdx !== -1 && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[dateIdx + 1] || '')
    ? process.argv[dateIdx + 1]
    : new Date().toLocaleDateString('en-CA')
  const outputDir = join(expandStorageDir(task), today)
  mkdirSync(outputDir, { recursive: true })

  const keywords = (task.keywords || []).map((k) => String(k).toLowerCase())
  const allResources = []
  const legacyItems = []
  // Per-source status tally so research.ts can surface honest step state
  // instead of the old silent "fetch-web = ok even if every source was
  // empty or errored" behavior. Emitted as a SUMMARY sentinel line below.
  const sourceResults = []

  for (const source of webSources) {
    console.log(`[fetch-web] Fetching ${source.label}: ${source.url}`)
    try {
      const fetched = await fetchBySource(task, source)
      const provider = inferProvider(source)
      // Direct Douyin/Xiaohongshu URL imports are explicit user picks rather than
      // keyword search results, so keep the resource even if its title/
      // description don't literally contain every task keyword.
      let matched = (provider === 'douyin' || provider === 'xiaohongshu')
        ? fetched
        : matchKeywords(fetched, keywords)

      // Apply quality filters by resource type. Threshold rule:
      // papers use minCount=5 (filterRecentPapers), everything else uses
      // minCount=3. Each filter has a safety fallback that returns "all
      // sorted by signal" when the source has too few items to filter
      // strictly, so a niche query never returns an empty list.
      if (provider === 'semantic-scholar' || provider === 'scholar') {
        matched = filterRecentPapers(matched)
      } else if (provider === 'bilibili' || provider === 'youtube') {
        matched = filterVideoQuality(matched)
      } else if (provider === 'github') {
        matched = filterRepoQuality(matched)
      }

      allResources.push(...matched)
      legacyItems.push(...matched.map(toLegacyItem))
      sourceResults.push({
        label: source.label || provider || 'web',
        status: matched.length > 0 ? 'ok' : 'empty',
        count: matched.length,
      })
      console.log(`[fetch-web] ${source.label} -> ${matched.length} resources (after quality filter)`)
    } catch (e) {
      const message = e?.message || String(e)
      sourceResults.push({
        label: source.label || inferProvider(source) || 'web',
        status: 'error',
        count: 0,
        message,
      })
      console.error(`[fetch-web] Failed for ${source.label}:`, message)
    }
  }

  // Machine-readable summary for research.ts. Must be on a single line and
  // prefixed exactly with "[fetch-web] SUMMARY " so the caller regex can
  // pick it out of the combined stdout stream. Keep message short to stay
  // inside the runner's default maxBuffer.
  const summaryPayload = { results: sourceResults }
  console.log(`[fetch-web] SUMMARY ${JSON.stringify(summaryPayload)}`)

  if (allResources.length === 0) {
    console.log('[fetch-web] No resources collected')
    return
  }

  const resourcePath = join(outputDir, `resources-web-${Date.now()}.json`)
  writeFileSync(resourcePath, JSON.stringify(allResources, null, 2), 'utf-8')
  console.log(`[fetch-web] Saved resources to ${resourcePath}`)

  const legacyPath = join(outputDir, `web-${Date.now()}.json`)
  writeFileSync(legacyPath, JSON.stringify(legacyItems, null, 2), 'utf-8')
  console.log(`[fetch-web] Saved legacy briefing items to ${legacyPath}`)
}

main().catch((e) => {
  console.error('[fetch-web] fatal:', e?.message || String(e))
  process.exit(1)
})
