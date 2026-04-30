import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  downloadPaperPdf,
  expandStorageDir,
  fetchWithRetry,
  hashKey,
  readJsonFile,
} from './resource-utils.mjs'

function cleanText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractArxivId(value) {
  const text = String(value || '').trim()
  if (!text) return ''

  const urlMatch = text.match(/arxiv\.org\/(?:abs|pdf)\/([^?#/]+?)(?:\.pdf)?(?:[?#].*)?$/i)
  if (urlMatch) return urlMatch[1]

  const bareIdMatch = text.match(/\b(\d{4}\.\d{4,5}(?:v\d+)?)\b/)
  return bareIdMatch ? bareIdMatch[1] : ''
}

function parseRssXml(xml) {
  const items = []
  const itemRegex = /<(?:item|entry)\b[\s\S]*?>([\s\S]*?)<\/(?:item|entry)>/gi
  let match

  while ((match = itemRegex.exec(xml)) !== null) {
    const content = match[1]

    const titleMatch = /<title(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(content)
    const linkMatch1 = /<link[^>]*href=["']([^"']+)["']/i.exec(content)
    const linkMatch2 = /<link>([\s\S]*?)<\/link>/i.exec(content)
    const descMatch = /<(?:description|summary|content)(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content)>/i.exec(content)
    const dateMatch = /<(?:pubDate|updated|published|dc:date)(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:pubDate|updated|published|dc:date)>/i.exec(content)
    const idMatch = /<(?:id|guid)(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:id|guid)>/i.exec(content)
    const pdfMatch = /<link[^>]*title=["']pdf["'][^>]*href=["']([^"']+)["']/i.exec(content)

    const authors = [...content.matchAll(/<author\b[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map((entry) => cleanText(entry[1]))
      .filter(Boolean)
      .join(', ')

    const title = cleanText(titleMatch?.[1] || 'No Title')
    const link = cleanText(linkMatch1?.[1] || linkMatch2?.[1] || '')
    const summary = cleanText(descMatch?.[1] || '')
    const date = cleanText(dateMatch?.[1] || new Date().toISOString())
    const guid = cleanText(idMatch?.[1] || '')
    const arxivId = extractArxivId(link) || extractArxivId(guid) || extractArxivId(pdfMatch?.[1])
    const pdfUrl = cleanText(pdfMatch?.[1] || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : ''))

    items.push({
      title,
      link: link || (arxivId ? `https://arxiv.org/abs/${arxivId}` : ''),
      summary,
      date,
      authors,
      pdfUrl,
      arxivId,
    })
  }

  return items
}

function inferRssProvider(source) {
  const blob = `${source?.label || ''} ${source?.url || ''}`.toLowerCase()
  return blob.includes('arxiv') ? 'arxiv' : 'rss'
}

function buildLegacyItem(item) {
  return {
    title: item.title,
    link: item.link,
    summary: item.summary,
    date: item.date,
  }
}

async function buildPaperResource(task, provider, item) {
  let localPath = ''
  let downloadError = ''
  if (item.pdfUrl) {
    try {
      localPath = await downloadPaperPdf(task, provider, {
        title: item.title,
        stableId: item.arxivId || hashKey(item.link || item.title),
        pdfUrl: item.pdfUrl,
        pdfUrlCandidates: item.arxivId ? [`https://export.arxiv.org/pdf/${item.arxivId}.pdf`] : [],
      })
    } catch (error) {
      downloadError = error?.message || String(error)
      console.warn(`[fetch-rss] PDF download failed for ${item.title}: ${downloadError}`)
    }
  }

  const dedupKey = item.arxivId ? `${provider}:${item.arxivId}` : `${provider}:${hashKey(item.link || item.title)}`
  const downloadStatus = localPath ? 'completed' : (downloadError ? 'failed' : 'none')

  return {
    id: `${task.id}_${hashKey(dedupKey)}`,
    taskId: task.id,
    resourceType: 'paper',
    provider,
    title: item.title,
    authorsOrChannel: item.authors || '',
    publishedAt: item.date,
    url: item.link,
    localPath,
    downloadStatus,
    downloadError,
    downloadAttempts: item.pdfUrl ? 1 : 0,
    downloadedAt: localPath ? new Date().toISOString() : '',
    abstractOrDescription: item.summary,
    aiSummary: '',
    whatItDoes: item.summary.slice(0, 180),
    method: '',
    result: '',
    relevanceToTopic: '',
    fetchedAt: new Date().toISOString(),
    dedupKey,
    meta: {
      pdfUrl: item.pdfUrl || '',
      arxivId: item.arxivId || '',
      ...(downloadError ? { downloadError } : {}),
    },
  }
}

async function main() {
  const taskIdx = process.argv.indexOf('--task')
  if (taskIdx === -1 || taskIdx === process.argv.length - 1) {
    console.error('Usage: node fetch-rss.mjs --task <path/to/task.json>')
    process.exit(1)
  }

  const taskPath = process.argv[taskIdx + 1]
  const task = readJsonFile(taskPath)
  const rssSources = task.sources?.filter((source) => source.type === 'rss') || []

  if (rssSources.length === 0) {
    console.log('[fetch-rss] No RSS sources found for this task')
    return
  }

  // Honour --date from the parent (research.ts threads runDate so all four
  // scripts in one pass land in the same directory). Fall back to local
  // YYYY-MM-DD for ad-hoc CLI runs — UTC slice diverged from the user's
  // wall clock around midnight CST.
  const dateIdx = process.argv.indexOf('--date')
  const today = dateIdx !== -1 && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[dateIdx + 1] || '')
    ? process.argv[dateIdx + 1]
    : new Date().toLocaleDateString('en-CA')
  const outputDir = join(expandStorageDir(task), today)
  mkdirSync(outputDir, { recursive: true })

  const keywords = (task.keywords || []).map((keyword) => String(keyword).toLowerCase())
  // Per-source status tally, mirroring fetch-web.mjs's SUMMARY protocol so
  // research.ts can promote partial/total failures into honest step state.
  const sourceResults = []

  for (const src of rssSources) {
    console.log(`[fetch-rss] Fetching ${src.label}: ${src.url}`)
    try {
      const resp = await fetchWithRetry(src.url, {
        headers: { 'User-Agent': 'NCUTclaw-Research-Bot/2.0' },
      }, {
        maxRetries: 3,
      })

      const xml = await resp.text()
      const items = parseRssXml(xml)
      console.log(`[fetch-rss] Parsed ${items.length} items`)

      // Keyword matching. Two-tier:
      //   Tier 1: exact phrase substring match (high-precision signal — picks
      //           up "cloud computing" inside "Cloud Computing for X" etc.)
      //   Tier 2: token-level any-match. Each keyword phrase is split on
      //           whitespace; tokens shorter than 3 chars are dropped (skip
      //           noise like "ai", "of"). An item passes if any single
      //           token appears as a word boundary match in title/summary.
      // Why two-tier: arxiv's new OR-of-quoted-phrases query (see
      // electron/main/research-storage.ts buildLegacySourceUrl arxiv case)
      // returns relevant papers like "Cloud-native Containers for HPC" or
      // "Serverless Platforms" that don't contain any user phrase verbatim
      // but obviously match a single token. Tier 1 alone over-filters.
      const tokens = new Set(
        keywords.flatMap((keyword) => keyword.split(/\s+/).filter((t) => t.length >= 3)),
      )
      const tokenRegexes = [...tokens].map((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'))
      const keywordMatched = keywords.length > 0
        ? items.filter((item) => {
            const textToSearch = `${item.title} ${item.summary} ${item.authors}`.toLowerCase()
            // Tier 1: phrase-level substring
            if (keywords.some((keyword) => textToSearch.includes(keyword))) return true
            // Tier 2: token-level word-boundary
            return tokenRegexes.some((re) => re.test(textToSearch))
          })
        : items

      // Date filtering: prefer recent 2 years.
      // Note: parseRssXml emits `date` (line ~54), not `published` — the
      // previous `!item.published` always returned true so this filter
      // was a no-op and old papers slipped through.
      const currentYear = new Date().getFullYear()
      const minYear = currentYear - 2
      const recentItems = keywordMatched.filter((item) => {
        if (!item.date) return true
        const year = new Date(item.date).getFullYear()
        return Number.isNaN(year) || year >= minYear
      })
      // Fall back to all if too few recent results
      const filtered = recentItems.length >= 3 ? recentItems : keywordMatched

      console.log(`[fetch-rss] Matched ${keywordMatched.length} items, ${recentItems.length} recent (>=${minYear}), keeping ${filtered.length}`)

      if (filtered.length === 0) {
        sourceResults.push({ label: src.label || 'rss', status: 'empty', count: 0 })
        continue
      }

      const provider = inferRssProvider(src)
      const resources = await Promise.all(filtered.map((item) => buildPaperResource(task, provider, item)))

      const resourcePath = join(outputDir, `resources-rss-${Date.now()}.json`)
      writeFileSync(resourcePath, JSON.stringify(resources, null, 2), 'utf-8')
      console.log(`[fetch-rss] Saved resources to ${resourcePath}`)

      const legacyPath = join(outputDir, `rss-${src.label}-${Date.now()}.json`)
      writeFileSync(legacyPath, JSON.stringify(filtered.map(buildLegacyItem), null, 2), 'utf-8')
      console.log(`[fetch-rss] Saved legacy items to ${legacyPath}`)

      sourceResults.push({ label: src.label || 'rss', status: 'ok', count: filtered.length })
    } catch (error) {
      const message = error?.message || String(error)
      sourceResults.push({ label: src.label || 'rss', status: 'error', count: 0, message })
      console.error(`[fetch-rss] Failed to fetch ${src.url}:`, message)
    }
  }

  // Machine-readable summary — see research.ts::parseFetchSummary. Must be
  // a single line, exact prefix so the regex can lift it out of stdout.
  console.log(`[fetch-rss] SUMMARY ${JSON.stringify({ results: sourceResults })}`)
}

main().catch((error) => {
  console.error('[fetch-rss] fatal:', error?.message || String(error))
  process.exit(1)
})
