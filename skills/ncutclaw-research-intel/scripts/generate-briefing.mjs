import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function normalizeCollectedItem(raw) {
  const title = typeof raw?.title === 'string' ? raw.title.trim() : ''
  const link = typeof raw?.link === 'string' && raw.link.trim()
    ? raw.link.trim()
    : (typeof raw?.url === 'string' ? raw.url.trim() : '')

  const summaryCandidates = [
    raw?.summary,
    raw?.abstractOrDescription,
    raw?.aiSummary,
    raw?.whatItDoes,
    raw?.description,
  ]
  const summary = summaryCandidates.find((value) => typeof value === 'string' && value.trim()) || ''

  const date = typeof raw?.date === 'string' && raw.date.trim()
    ? raw.date.trim()
    : (typeof raw?.publishedAt === 'string' && raw.publishedAt.trim()
      ? raw.publishedAt.trim()
      : (typeof raw?.fetchedAt === 'string' && raw.fetchedAt.trim()
        ? raw.fetchedAt.trim()
        : new Date().toISOString()))

  if (!title) return null

  const type = typeof raw?.resourceType === 'string' ? raw.resourceType : ''

  return {
    title,
    link,
    summary: typeof summary === 'string' ? summary.trim() : '',
    date,
    type,
  }
}

async function main() {
  const taskIdx = process.argv.indexOf('--task')
  const portIdx = process.argv.indexOf('--port')
  
  if (taskIdx === -1) {
    console.error('Usage: node generate-briefing.mjs --task <path/to/task.json> [--port 18789]')
    process.exit(1)
  }
  
  const taskPath = process.argv[taskIdx + 1]
  const task = JSON.parse(readFileSync(taskPath, 'utf-8'))
  const port = portIdx !== -1 ? process.argv[portIdx + 1] : '18789'
  
  const today = new Date().toISOString().slice(0, 10)
  
  let storageDir = task.storageDir
  if (storageDir && storageDir.startsWith('~')) {
    storageDir = join(homedir(), storageDir.slice(1))
  } else if (!storageDir) {
    storageDir = join(homedir(), '.ncutclaw/workspace/research-data', task.id)
  }
  
  const dataDir = join(storageDir, today)
  if (!existsSync(dataDir)) {
    console.log(`[generate-briefing] No data directory found for today: ${dataDir}`)
    return
  }
  
  const files = readdirSync(dataDir).filter(f => f.endsWith('.json') && !f.startsWith('briefing'))
  if (files.length === 0) {
    console.log(`[generate-briefing] No data files found for today`)
    // Optionally create an empty briefing if requested
    return
  }
  
  // Aggregate all items
  const allItems = []
  const seenUrls = new Set()
  
  for (const f of files) {
    try {
      const items = JSON.parse(readFileSync(join(dataDir, f), 'utf-8'))
      for (const item of items) {
        const normalized = normalizeCollectedItem(item)
        if (!normalized) continue

        const dedupKey = normalized.link || `${normalized.title}|${normalized.date}`
        if (seenUrls.has(dedupKey)) continue

        seenUrls.add(dedupKey)
        allItems.push(normalized)
      }
    } catch(e) {
      console.warn(`[generate-briefing] Failed to parse ${f}: ${e.message}`)
    }
  }
  
  if (allItems.length === 0) {
    console.log(`[generate-briefing] No valid items parsed`)
    return
  }
  
  console.log(`[generate-briefing] Ready to summarize ${allItems.length} unique items`)
  
  // Prioritize papers over videos: 70% papers, 30% others
  const papers = allItems.filter(i => i.type === 'paper')
  const others = allItems.filter(i => i.type !== 'paper')
  const maxItems = 30
  const paperQuota = Math.min(papers.length, Math.ceil(maxItems * 0.7))
  const otherQuota = Math.min(others.length, maxItems - paperQuota)
  const prioritized = [...papers.slice(0, paperQuota), ...others.slice(0, otherQuota)]

  const itemsToSubmit = prioritized.map(i => ({
    title: i.title,
    link: i.link,
    summary: i.summary.length > 500 ? i.summary.substring(0, 500) + '...' : i.summary
  }))
  
  const prompt = `你是一个科研与技术情报分析员。
请根据以下今日搜集的 ${itemsToSubmit.length} 条文献/资讯，生成一份高质量的结构化中文分析简报。
任务名称：${task.name}
重点关注关键词：${(task.keywords || []).join(', ')}

要求：
1. 优先分析论文和学术内容，视频仅作为补充。提取最有价值的信息，分为"核心发现"、"重要发布/更新"、"值得关注"三个板块（如果没有相关内容可以省略某个板块）
2. 只在首次提及某文献时使用一次 Markdown 链接，例如：[文献名称](链接)。后续引用同一文献时直接使用名称，不要重复链接。教学视频的链接可以省略
3. 简报开头要有1-2句话的"本日摘要"
4. 末尾给出"综合评估"（3-5句话即可，简洁有力）
5. 使用规范的 Markdown 格式，层级清晰，避免冗长段落
6. 必须是中文回答。如果文献标题或摘要是英文，请翻译为中文后再分析
7. 简报总长度控制在 1500 字以内，重质不重量

今日搜集内容：
${JSON.stringify(itemsToSubmit, null, 2)}`

  // Call the local OpenClaw Gateway API
  console.log(`[generate-briefing] Sending to Gateway on port ${port}...`)
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120000) // 2 min timeout
    
    // Read the user openclaw.json to pass auth if needed
    let apiKey = 'sk-local' // Fallback
    try {
      const configPath = join(homedir(), '.ncutclaw/openclaw.json')
      if (existsSync(configPath)) {
        const userConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
        // Assume default provider logic inside gateway won't strict check API key if it's openclaw,
        // but passing whatever they have setup might help
        if (userConfig.session?.apiKey) {
          apiKey = userConfig.session.apiKey
        }
      }
    } catch(e) { /* ignore */ }
    
    const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'openclaw', // Gateway requires 'openclaw' or 'openclaw/<agentId>'
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 4000
      }),
      signal: controller.signal
    })
    
    clearTimeout(timeout)
    
    if (!resp.ok) {
      const err = await resp.text().catch(()=>'')
      throw new Error(`Gateway HTTP ${resp.status}: ${err}`)
    }
    
    const result = await resp.json()
    const content = result.choices?.[0]?.message?.content
    
    if (content) {
      const outPath = join(dataDir, 'briefing.md')
      // Append header
      const finalMarkdown = `# 📚 ${task.name} 每日简报\n> 生成时间: ${new Date().toLocaleString('zh-CN')}\n> 来源总数: ${allItems.length} 条资讯\n\n---\n\n${content}`
      writeFileSync(outPath, finalMarkdown, 'utf-8')
      console.log(`[generate-briefing] Briefing saved to ${outPath}`)
    } else {
      console.log('[generate-briefing] Empty response from Gateway')
    }
  } catch(e) {
    console.error('[generate-briefing] Failed to generate briefing:', e.message)
    // If Gateway is totally dead, at least write a raw dump so they get something
    const fallbackPath = join(dataDir, 'briefing.md')
    const fallbackMarkdown = `# ⚠️ ${task.name} 数据报告 (汇总)\n> AI 分析服务无响应，以下为原始抓取数据汇总\n\n` + 
      itemsToSubmit.map((i, idx) => `### ${idx+1}. ${i.title}\n[链接](${i.link})\n> ${i.summary}`).join('\n\n')
    writeFileSync(fallbackPath, fallbackMarkdown, 'utf-8')
    console.log(`[generate-briefing] Wrote raw fallback briefing to ${fallbackPath}`)
  }
}

main().catch(console.error)
