const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const suitePath = path.join(repoRoot, 'plans/odai-skill-test-suite.csv')
const suiteDocPath = path.join(repoRoot, 'plans/odai-skill-test-suite.md')
const skillRoot = path.join(repoRoot, 'skills/odai')

const header = [
  'id',
  'code',
  'bucket',
  'complexity',
  'setup',
  'route',
  'user_prompt',
  'ask',
  'exec',
  'done',
  'clean',
  'focus',
]

const allowed = {
  complexity: new Set(['L', 'M', 'H']),
  ask: new Set(['Q0', 'Q1', 'Q2', 'Q3', 'Q4']),
  exec: new Set(['E0', 'E1', 'E2', 'E3', 'E4']),
  done: new Set(['D0', 'D1', 'D2', 'D3', 'D4']),
  clean: new Set(['C0', 'C1', 'C2', 'C3', 'C4']),
  route: new Set([
    'dao',
    'dao->fp',
    'dao->ds',
    'dao->ic',
    'dao->pg',
    'dao->gd',
    'dao->sslb',
    'dao->feature-plan',
    'dao->design-spec',
    'dao->implement-code',
    'dao->project-guide',
    'dao->game-design',
    'dao->review-sslb',
    'dao->harness-dev',
    'dao->skill-author',
    'dao->skill-sync',
  ]),
}

const staleSourcePatterns = [
  /成本层级/,
  /强触发方探/,
  /立即降档/,
  /当前环境不支持/,
  /真实增强自测/,
  /少文/,
  /先报/,
  /先给今判/,
  /先给已知/,
  /先给出今判/,
  /复述你/,
  /完整判断依据/,
  /候选理解/,
  /推荐默认/,
]

const staleCopilotPattern = /Copilot|copilot/
const requiredCoverage = [
  /非 Copilot/,
  /同一模型/,
  /需额外付费/,
  /强触发/,
  /第二视角/,
  /额度拒绝/,
  /Copilot 专属/,
]
const requiredShortOutputSnippets = [
  '能一句不二句',
  '不出二句',
  '不预设默认答案',
  '普通对话不先复述',
  '对外仍短报结论',
  '默认短审',
  '输出形态互斥',
  '当前对话啰嗦',
  '某产品、技能或助手',
  '最低信息量',
  '工具失败、权限不足或环境限制',
  '静默伪成成功',
]

function fail(message) {
  throw new Error(message)
}

function parseCsv(text) {
  const rows = []
  let field = ''
  let row = []
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      field = ''
      row = []
    } else if (char !== '\r') {
      field += char
    }
  }

  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((entry) => entry.some((cell) => cell.length))
}

function walk(dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      out.push(...walk(full))
    } else {
      out.push(full)
    }
  }
  return out
}

function checkSuite() {
  const rows = parseCsv(fs.readFileSync(suitePath, 'utf8'))
  const actualHeader = rows.shift()
  if (actualHeader.join('\0') !== header.join('\0')) {
    fail(`bad csv header: ${actualHeader.join(',')}`)
  }

  const seen = new Set()
  const buckets = new Map()
  const blob = rows.map((row) => row.join(' ')).join('\n')

  rows.forEach((row, index) => {
    if (row.length !== header.length) {
      fail(`row ${index + 2}: expected ${header.length} fields, got ${row.length}`)
    }

    const item = Object.fromEntries(header.map((key, col) => [key, row[col]]))
    const expectedId = String(index + 1).padStart(3, '0')
    if (item.id !== expectedId) {
      fail(`row ${index + 2}: id ${item.id} should be ${expectedId}`)
    }
    if (seen.has(item.id)) {
      fail(`duplicate id ${item.id}`)
    }
    seen.add(item.id)

    for (const key of ['complexity', 'ask', 'exec', 'done']) {
      if (!allowed[key].has(item[key])) {
        fail(`row ${item.id}: bad ${key} ${item[key]}`)
      }
    }

    for (const token of item.clean.split('+')) {
      if (!allowed.clean.has(token)) {
        fail(`row ${item.id}: bad clean token ${token}`)
      }
    }

    if (!allowed.route.has(item.route)) {
      fail(`row ${item.id}: bad route ${item.route}`)
    }

    for (const key of header) {
      if (!item[key]) {
        fail(`row ${item.id}: empty ${key}`)
      }
    }

    buckets.set(item.bucket, (buckets.get(item.bucket) || 0) + 1)
  })

  const suiteDoc = fs.readFileSync(suiteDocPath, 'utf8')
  const totalMatch = suiteDoc.match(/总数：(\d+)/)
  if (!totalMatch) {
    fail('suite doc missing total count')
  }
  const documentedTotal = Number(totalMatch[1])
  if (documentedTotal !== rows.length) {
    fail(`suite doc total ${documentedTotal} != csv rows ${rows.length}`)
  }

  for (const marker of ['fp=feature-plan', 'ds=design-spec', 'ic=implement-code', 'pg=project-guide', 'sslb=review-sslb', 'gd=game-design']) {
    if (!suiteDoc.includes(marker)) {
      fail(`suite doc missing route alias ${marker}`)
    }
  }

  for (const pattern of requiredCoverage) {
    if (!pattern.test(blob)) {
      fail(`suite missing coverage marker ${pattern}`)
    }
  }

  return { rows, buckets }
}

function checkSourceReferences() {
  const files = walk(skillRoot).filter((file) => file.endsWith('.md'))
  const missing = []
  const sourceBlob = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n')

  for (const file of files) {
    const rel = path.relative(skillRoot, file)
    const text = fs.readFileSync(file, 'utf8')
    for (const pattern of staleSourcePatterns) {
      if (pattern.test(text)) {
        fail(`${rel}: stale phrase ${pattern}`)
      }
    }
    if (staleCopilotPattern.test(text)) {
      fail(`${rel}: Copilot-specific source wording remains`)
    }

    const refs = text.matchAll(/`((?:references|assets|scripts)\/[^`]+)`/g)
    for (const match of refs) {
      const ref = match[1]
      if (ref.includes('<') || ref.includes('>')) {
        continue
      }
      const skillLocal = path.join(skillRoot, ref)
      const repoLocal = path.join(repoRoot, ref)
      if (!fs.existsSync(skillLocal) && !fs.existsSync(repoLocal)) {
        missing.push(`${rel} -> ${ref}`)
      }
    }
  }

  if (missing.length) {
    fail(`missing skill references:\n${missing.join('\n')}`)
  }

  const missingShortOutputSnippets = requiredShortOutputSnippets.filter((snippet) => !sourceBlob.includes(snippet))
  if (missingShortOutputSnippets.length) {
    fail(`missing short-output contract snippets:\n${missingShortOutputSnippets.join('\n')}`)
  }
}

function main() {
  const { rows, buckets } = checkSuite()
  checkSourceReferences()

  const summary = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}:${count}`)
    .join(' ')

  console.log(`odai suite ok: rows=${rows.length}`)
  console.log(`buckets ${summary}`)
}

main()
