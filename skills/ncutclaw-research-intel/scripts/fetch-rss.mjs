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

  const today = new Date().toISOString().slice(0, 10)
  const outputDir = join(expandStorageDir(task), today)
  mkdirSync(outputDir, { recursive: true })

  const keywords = (task.keywords || []).map((keyword) => String(keyword).toLowerCase())

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

      // Keyword matching
      const keywordMatched = keywords.length > 0
        ? items.filter((item) => {
            const textToSearch = `${item.title} ${item.summary} ${item.authors}`.toLowerCase()
            return keywords.some((keyword) => textToSearch.includes(keyword))
          })
        : items

      // Date filtering: prefer recent 2 years
      const currentYear = new Date().getFullYear()
      const minYear = currentYear - 2
      const recentItems = keywordMatched.filter((item) => {
        if (!item.published) return true
        const year = new Date(item.published).getFullYear()
        return Number.isNaN(year) || year >= minYear
      })
      // Fall back to all if too few recent results
      const filtered = recentItems.length >= 3 ? recentItems : keywordMatched

      console.log(`[fetch-rss] Matched ${keywordMatched.length} items, ${recentItems.length} recent (>=${minYear}), keeping ${filtered.length}`)

      if (filtered.length === 0) continue

      const provider = inferRssProvider(src)
      const resources = await Promise.all(filtered.map((item) => buildPaperResource(task, provider, item)))

      const resourcePath = join(outputDir, `resources-rss-${Date.now()}.json`)
      writeFileSync(resourcePath, JSON.stringify(resources, null, 2), 'utf-8')
      console.log(`[fetch-rss] Saved resources to ${resourcePath}`)

      const legacyPath = join(outputDir, `rss-${src.label}-${Date.now()}.json`)
      writeFileSync(legacyPath, JSON.stringify(filtered.map(buildLegacyItem), null, 2), 'utf-8')
      console.log(`[fetch-rss] Saved legacy items to ${legacyPath}`)
    } catch (error) {
      console.error(`[fetch-rss] Failed to fetch ${src.url}:`, error?.message || String(error))
    }
  }
}

main().catch((error) => {
  console.error('[fetch-rss] fatal:', error?.message || String(error))
  process.exit(1)
})
