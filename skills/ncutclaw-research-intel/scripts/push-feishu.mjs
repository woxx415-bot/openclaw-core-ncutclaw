import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

async function getTenantAccessToken(appId, appSecret) {
  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  })
  if (!resp.ok) throw new Error(`Feishu auth failed ${resp.status}`)
  const data = await resp.json()
  if (data.code !== 0) throw new Error(`Feishu auth error: ${data.msg}`)
  return data.tenant_access_token
}

async function sendInteractiveMessage(token, receiveId, msgType, receiveIdType, elements, headerTitle) {
  const payload = {
    receive_id: receiveId,
    content: JSON.stringify({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: headerTitle },
        template: "blue"
      },
      elements: elements
    }),
    msg_type: 'interactive'
  }

  const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  })
  
  if (!resp.ok) throw new Error(`Feishu send failed ${resp.status}: ${await resp.text()}`)
  const data = await resp.json()
  if (data.code !== 0) throw new Error(`Feishu send error: ${data.msg}`)
  return data
}

// Convert simple markdown string to Feishu block elements (handles basic truncation)
function createFeishuElementsFromMarkdown(markdown) {
  const elements = []
  
  // Truncate if too long (Feishu limits card size to 30KB)
  let content = markdown
  if (content.length > 5000) {
    content = content.substring(0, 5000) + '\n\n... (内容过长已截断)'
  }
  
  elements.push({
    tag: "div",
    text: {
      content: content,
      tag: "lark_md" // Note: Feishu markdown is very restricted compared to real markdown
    }
  })
  
  // Add a footer
  elements.push({
    tag: "hr"
  })
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: `由 NCUTclaw 科研助理生成 • ${new Date().toLocaleString('zh-CN')}`
      }
    ]
  })
  
  return elements
}

async function main() {
  const taskIdx = process.argv.indexOf('--task')
  if (taskIdx === -1) {
    console.error('Usage: node push-feishu.mjs --task <path/to/task.json>')
    process.exit(1)
  }
  
  const taskPath = process.argv[taskIdx + 1]
  const task = JSON.parse(readFileSync(taskPath, 'utf-8'))
  
  if (!task.feishuTarget || task.feishuTarget.type === 'none') {
    console.log('[push-feishu] No Feishu push target configured')
    return
  }
  
  // Read openclaw config for Feishu App ID & Secret
  const configPath = join(homedir(), '.ncutclaw/openclaw.json')
  if (!existsSync(configPath)) {
    console.error('[push-feishu] openclaw.json not found')
    return
  }
  
  const userConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
  const feishuCfg = userConfig.channels?.feishu
  
  if (!feishuCfg?.enabled || !feishuCfg?.appId || !feishuCfg?.appSecret) {
    console.error('[push-feishu] Feishu channel is not fully configured or not enabled in Settings')
    return
  }
  
  // Find today's briefing
  const today = new Date().toISOString().slice(0, 10)
  let storageDir = task.storageDir
  if (storageDir && storageDir.startsWith('~')) {
    storageDir = join(homedir(), storageDir.slice(1))
  } else if (!storageDir) {
    storageDir = join(homedir(), '.ncutclaw/workspace/research-data', task.id)
  }
  
  const briefingPath = join(storageDir, today, 'briefing.md')
  if (!existsSync(briefingPath)) {
    console.log(`[push-feishu] Today's briefing not found at ${briefingPath}`)
    return
  }
  
  const markdown = readFileSync(briefingPath, 'utf-8')
  
  try {
    console.log('[push-feishu] Getting access token...')
    const token = await getTenantAccessToken(feishuCfg.appId, feishuCfg.appSecret)
    
    if (task.feishuTarget.type === 'feishu_group' && task.feishuTarget.chatId) {
      console.log(`[push-feishu] Pushing to group ${task.feishuTarget.chatId}...`)
      // Convert markdown to card elements
      // Remove the top level # TaskName that we added in generate-briefing, as it goes to card header
      let cleanedMd = markdown.replace(/^# .*每日简报\n/, '').replace(/^> 生成时间:.*\n/, '').replace(/^> 来源总数:.*\n/, '').replace(/^---\n/, '').trim()
      
      const elements = createFeishuElementsFromMarkdown(cleanedMd)
      await sendInteractiveMessage(
        token, 
        task.feishuTarget.chatId, 
        'interactive', 
        'chat_id', 
        elements, 
        `📚 ${task.name} 每日简报`
      )
      console.log('[push-feishu] Successfully pushed to Feishu group')
    } else {
      console.log('[push-feishu] Target type ' + task.feishuTarget.type + ' not fully supported in this version or missing auth credentials.')
    }
  } catch (err) {
    console.error('[push-feishu] Feishu push failed:', err.message)
  }
}

main().catch(console.error)
