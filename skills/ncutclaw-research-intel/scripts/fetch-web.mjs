import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  downloadPaperPdf,
  expandStorageDir,
  fetchWithRetry,
  hashKey,
  readJsonFile,
} from './resource-utils.mjs'

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
function filterRecentPapers(resources, minCount = 5) {
  const currentYear = new Date().getFullYear()
  const minYear = currentYear - 2

  const recent = resources.filter((r) => {
    const year = parseInt(r.publishedAt, 10)
    if (Number.isNaN(year)) return true  // keep items with unknown date
    return year >= minYear
  })

  // If filtering removes too many, fall back to keeping all but sorted by date
  if (recent.length >= minCount) return recent
  // Sort by date descending so newer papers come first
  return resources.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
}

/**
 * Filter videos by quality signals: minimum view count and duration.
 * Keeps at least minCount results even if they don't meet thresholds.
 */
function filterVideoQuality(resources, minCount = 5) {
  const MIN_VIEWS = 100       // minimum play count
  const MIN_DURATION_SEC = 60 // minimum 1 minute (filter out very short clips)

  const scored = resources.map((r) => {
    const play = Number(r.meta?.play) || 0
    const duration = parseDurationToSeconds(r.meta?.duration)
    return { resource: r, play, duration }
  })

  // Filter by quality thresholds
  const quality = scored.filter((s) => s.play >= MIN_VIEWS && s.duration >= MIN_DURATION_SEC)

  if (quality.length >= minCount) {
    // Sort by views descending for quality ordering
    quality.sort((a, b) => b.play - a.play)
    return quality.map((s) => s.resource)
  }

  // Not enough quality results, sort all by views and return
  scored.sort((a, b) => b.play - a.play)
  return scored.map((s) => s.resource)
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
  let data
  try {
    data = await fetchJson(prepareSemanticScholarUrl(source.url))
  } catch (err) {
    console.warn(`[fetch-web] Semantic Scholar unavailable: ${err?.message || err} — skipping`)
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

async function parseYoutube(task, source) {
  const url = String(source.url || '')
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

  const outputDir = join(expandStorageDir(task), new Date().toISOString().slice(0, 10))
  mkdirSync(outputDir, { recursive: true })

  const keywords = (task.keywords || []).map((k) => String(k).toLowerCase())
  const allResources = []
  const legacyItems = []

  for (const source of webSources) {
    console.log(`[fetch-web] Fetching ${source.label}: ${source.url}`)
    try {
      const fetched = await fetchBySource(task, source)
      let matched = matchKeywords(fetched, keywords)

      // Apply quality filters by resource type
      const provider = inferProvider(source)
      if (provider === 'semantic-scholar' || provider === 'scholar') {
        matched = filterRecentPapers(matched)
      } else if (provider === 'bilibili' || provider === 'youtube') {
        matched = filterVideoQuality(matched)
      }

      allResources.push(...matched)
      legacyItems.push(...matched.map(toLegacyItem))
      console.log(`[fetch-web] ${source.label} -> ${matched.length} resources (after quality filter)`)
    } catch (e) {
      console.error(`[fetch-web] Failed for ${source.label}:`, e?.message || String(e))
    }
  }

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
