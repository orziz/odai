#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const README_TABLE_HEADER = '| Skill | 简介 | 适用场景 | 对应文件 |'
const README_ROW_TEMPLATE = '| `{name}` | {description} | {scenario} | `skills/{name}/SKILL.md` |'
const DEFAULT_SCENARIO = 'skill 定稿后的多端同步'
const CLAUDE_ARGUMENT_BLOCK = '\n用户输入：\n$ARGUMENTS\n\n'
const BUNDLED_RESOURCE_DIRS = ['references', 'assets', 'scripts']
const TARGETS = [
  {
    key: 'claude',
    rootSegments: ['.claude', 'commands'],
    entryRelativePath: (skillName) => `${skillName}.md`,
    resourceBaseDir: (skillName) => skillName,
    kind: 'claude',
    rewriteResourcePaths: true,
    legacyEntryRelativePaths: () => [],
  },
  {
    key: 'github',
    rootSegments: ['.github', 'skills'],
    entryRelativePath: (skillName) => path.join(skillName, 'SKILL.md'),
    resourceBaseDir: (skillName) => skillName,
    kind: 'generic',
    rewriteResourcePaths: false,
    legacyEntryRelativePaths: (skillName) => [`${skillName}.md`],
  },
  {
    key: 'trae-skills',
    rootSegments: ['.trae', 'skills'],
    entryRelativePath: (skillName) => `${skillName}.md`,
    resourceBaseDir: (skillName) => skillName,
    kind: 'generic',
    rewriteResourcePaths: true,
    legacyEntryRelativePaths: () => [],
  },
  {
    key: 'trae-rules',
    rootSegments: ['.trae', 'rules'],
    entryRelativePath: (skillName) => `${skillName}.md`,
    resourceBaseDir: (skillName) => skillName,
    kind: 'generic',
    rewriteResourcePaths: true,
    legacyEntryRelativePaths: () => [],
  },
]
const MISSING_SOURCE_TEMPLATE = '错误：skills/{name}/SKILL.md 不存在，无法生成手动安装版本。'
const USAGE_ERROR = '错误：请至少传入一个 skill 名称，例如：skill-sync review-sslb harness-sslb'

function main() {
  const skillNames = parseSkillNames(process.argv.slice(2))
  if (skillNames.length === 0) {
    fail(USAGE_ERROR)
  }

  const repoRoot = path.resolve(__dirname, '..')
  const readmePath = path.join(repoRoot, 'README.md')
  const skillPayloads = skillNames.map((skillName) => loadSkillPayload(repoRoot, skillName))

  for (const payload of skillPayloads) {
    const outputs = new Map()
    const resourceOutputs = []

    for (const target of TARGETS) {
      const targetRoot = path.join(repoRoot, ...target.rootSegments)
      const entryRelativePath = target.entryRelativePath(payload.skillName)
      const entryPath = path.join(targetRoot, entryRelativePath)
      const targetBody = target.rewriteResourcePaths
        ? rewriteBundledResourcePaths(payload.sourceBody, `${payload.skillName}/`, payload.bundledResourceDirs)
        : payload.sourceBody

      const content =
        target.kind === 'claude'
          ? buildClaudeTarget({
              name: payload.sourceName,
              description: payload.description,
              body: targetBody,
              existingClaude: payload.existingClaude,
            })
          : buildGenericTarget({
              name: payload.sourceName,
              description: payload.description,
              body: targetBody,
            })

      removeLegacyEntries(targetRoot, payload.skillName, target.legacyEntryRelativePaths(payload.skillName))
      fs.mkdirSync(path.dirname(entryPath), { recursive: true })
      writeFile(entryPath, content)
      outputs.set(entryPath, content)

      resourceOutputs.push(
        ...syncBundledResourcesForTarget({
          repoRoot,
          sourceDir: payload.sourceDir,
          skillName: payload.skillName,
          bundledResourceDirs: payload.bundledResourceDirs,
          targetRoot,
          targetSkillDir: path.join(targetRoot, target.resourceBaseDir(payload.skillName)),
        })
      )
    }

    const readmeStatus = syncReadme(readmePath, payload.skillName, payload.description, payload.sourceScenario)

    console.log(`源文件：skills/${payload.skillName}/SKILL.md`)
    console.log('已更新：')
    for (const filePath of outputs.keys()) {
      console.log(`- ${path.relative(repoRoot, filePath)}`)
    }
    for (const resourcePath of resourceOutputs) {
      console.log(`- ${resourcePath}`)
    }
    console.log(`- README：${readmeStatus}`)
    console.log('已按最小必要范围完成同步。')
  }
}

function parseSkillNames(args) {
  const parsed = []
  const seen = new Set()

  for (const rawArg of args) {
    const skillName = rawArg.trim()
    if (!skillName || /\s/.test(skillName)) {
      fail(USAGE_ERROR)
    }
    if (seen.has(skillName)) {
      continue
    }
    seen.add(skillName)
    parsed.push(skillName)
  }

  return parsed
}

function loadSkillPayload(repoRoot, skillName) {
  const sourceDir = path.join(repoRoot, 'skills', skillName)
  const sourcePath = path.join(sourceDir, 'SKILL.md')
  const existingClaudePath = path.join(repoRoot, '.claude', 'commands', `${skillName}.md`)

  if (!fs.existsSync(sourcePath)) {
    fail(MISSING_SOURCE_TEMPLATE.replace('{name}', skillName))
  }

  const sourceText = readNormalized(sourcePath)
  const { frontmatter: sourceFrontmatter, body: sourceBody } = splitFrontmatter(sourceText)
  const sourceName = getFrontmatterValue(sourceFrontmatter, 'name') || skillName
  const description = getFrontmatterValue(sourceFrontmatter, 'description') || ''
  const sourceScenario = getFrontmatterValue(sourceFrontmatter, 'scenario')
  const bundledResourceDirs = getBundledResourceDirs(sourceDir)
  const existingClaudeText = fs.existsSync(existingClaudePath) ? readNormalized(existingClaudePath) : null
  const existingClaude = existingClaudeText ? splitClaudeWrapper(existingClaudeText) : null

  return {
    skillName,
    sourceDir,
    sourceBody,
    sourceName,
    description,
    sourceScenario,
    bundledResourceDirs,
    existingClaude,
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function readNormalized(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, ensureTrailingNewline(content).replace(/\r\n/g, '\n'), 'utf8')
}

function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) {
    return { frontmatter: {}, body: text }
  }

  const closingIndex = text.indexOf('\n---\n', 4)
  if (closingIndex === -1) {
    return { frontmatter: {}, body: text }
  }

  const rawFrontmatter = text.slice(4, closingIndex)
  const body = text.slice(closingIndex + 5)
  const frontmatter = {}
  let currentKey = null
  let buffer = []

  for (const line of rawFrontmatter.split('\n')) {
    if (/^[A-Za-z0-9_-]+:\s*/.test(line)) {
      if (currentKey !== null) {
        frontmatter[currentKey] = buffer.join('\n').replace(/\s+$/, '')
      }
      const separatorIndex = line.indexOf(':')
      currentKey = line.slice(0, separatorIndex).trim()
      buffer = [line.slice(separatorIndex + 1).trimStart()]
    } else if (currentKey !== null) {
      buffer.push(line)
    }
  }

  if (currentKey !== null) {
    frontmatter[currentKey] = buffer.join('\n').replace(/\s+$/, '')
  }

  return { frontmatter, body }
}

function getFrontmatterValue(frontmatter, key) {
  const value = frontmatter[key]
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

function splitClaudeWrapper(text) {
  const { frontmatter, body } = splitFrontmatter(text)
  const prefixed = body.startsWith('用户输入：\n$ARGUMENTS\n\n') ? body : body.startsWith('\n用户输入：\n$ARGUMENTS\n\n') ? body.slice(1) : null

  if (!prefixed) {
    return {
      frontmatter,
      preamble: '',
      body,
    }
  }

  const rest = prefixed.slice('用户输入：\n$ARGUMENTS\n\n'.length)
  const sourceStart = findBodyStart(rest)
  if (sourceStart === -1) {
    return {
      frontmatter,
      preamble: rest,
      body: '',
    }
  }

  const candidatePreamble = rest.slice(0, sourceStart)
  const candidateBody = rest.slice(sourceStart)
  const normalizedCandidateBody = normalizeContentBody(candidateBody)

  return {
    frontmatter,
    preamble: normalizedCandidateBody ? candidatePreamble : '',
    body: normalizedCandidateBody ? candidateBody : rest,
  }
}

function findBodyStart(text) {
  const prefixes = ['你是', '若未', '## ', '# ', '用户提供', '日报、', '1. ']
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      return 0
    }
  }

  const patterns = [
    '\n你是',
    '\n若未',
    '\n## ',
    '\n# ',
    '\n用户提供',
    '\n日报、',
    '\n1. ',
  ]
  let index = -1
  for (const pattern of patterns) {
    const found = text.indexOf(pattern)
    if (found !== -1 && (index === -1 || found < index)) {
      index = found
    }
  }
  return index === -1 ? -1 : index + 1
}

function normalizeContentBody(text) {
  return text
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
}

function getBundledResourceDirs(sourceDir) {
  return BUNDLED_RESOURCE_DIRS.filter((dirName) => {
    const fullPath = path.join(sourceDir, dirName)
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()
  })
}

function rewriteBundledResourcePaths(text, resourcePrefix, bundledResourceDirs) {
  let result = text

  for (const dirName of bundledResourceDirs) {
    result = rewriteBundledResourcePathPrefix(result, resourcePrefix, dirName)
  }

  return result
}

function rewriteBundledResourcePathPrefix(text, resourcePrefix, dirName) {
  const boundary = '(^|[\\s`"\'(\\[])'

  return text
    .replace(new RegExp(`${boundary}\\./${dirName}/`, 'g'), `$1${resourcePrefix}${dirName}/`)
    .replace(new RegExp(`${boundary}${dirName}/`, 'g'), `$1${resourcePrefix}${dirName}/`)
}

function buildClaudeTarget({ name, description, body, existingClaude }) {
  const lines = ['---']

  if (existingClaude) {
    const existingName = getFrontmatterValue(existingClaude.frontmatter, 'name')
    const existingDescription = getFrontmatterValue(existingClaude.frontmatter, 'description')
    const allowedTools = getFrontmatterValue(existingClaude.frontmatter, 'allowed-tools')
    const argumentHint = getFrontmatterValue(existingClaude.frontmatter, 'argument-hint')

    if (existingName) {
      lines.push(`name: ${name}`)
    }
    lines.push(`description: ${description || existingDescription || ''}`)
    if (allowedTools) {
      lines.push(`allowed-tools: ${allowedTools}`)
    }
    if (argumentHint) {
      lines.push(`argument-hint: ${argumentHint}`)
    }
  } else {
    lines.push(`name: ${name}`)
    lines.push(`description: ${description}`)
  }

  lines.push('---')

  const normalizedSourceBody = normalizeContentBody(body)
  const normalizedExistingBody = existingClaude ? normalizeContentBody(existingClaude.body) : ''
  const preamble = existingClaude && normalizedExistingBody === normalizedSourceBody ? existingClaude.preamble : ''

  let content = `${lines.join('\n')}\n${CLAUDE_ARGUMENT_BLOCK}`
  if (preamble) {
    content += preamble.replace(/^\n+/, '')
    if (!content.endsWith('\n\n')) {
      content = content.replace(/\n*$/, '\n\n')
    }
  }
  content += body.replace(/^\n+/, '')
  return ensureTrailingNewline(content)
}

function buildGenericTarget({ name, description, body }) {
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.replace(/^\n+/, '')}`
  return ensureTrailingNewline(content)
}

function syncBundledResourcesForTarget({ repoRoot, sourceDir, skillName, bundledResourceDirs, targetRoot, targetSkillDir }) {
  const written = []

  for (const dirName of BUNDLED_RESOURCE_DIRS) {
    removeManagedDir(path.join(targetSkillDir, dirName))
  }

  for (const dirName of bundledResourceDirs) {
    const sourceResourceDir = path.join(sourceDir, dirName)
    const targetResourceDir = path.join(targetSkillDir, dirName)
    fs.mkdirSync(path.dirname(targetResourceDir), { recursive: true })
    fs.cpSync(sourceResourceDir, targetResourceDir, { recursive: true })
    written.push(path.relative(repoRoot, targetResourceDir))
  }

  if (fs.existsSync(targetSkillDir) && fs.readdirSync(targetSkillDir).length === 0) {
    fs.rmdirSync(targetSkillDir)
  }

  return written
}

function removeLegacyEntries(targetRoot, skillName, legacyEntryRelativePaths) {
  for (const relativePath of legacyEntryRelativePaths) {
    if (!relativePath) {
      continue
    }

    const absolutePath = path.join(targetRoot, relativePath)
    if (fs.existsSync(absolutePath)) {
      fs.rmSync(absolutePath, { recursive: true, force: true })
    }
  }
}

function removeManagedDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true })
  }
}

function syncReadme(readmePath, skillName, description, scenario) {
  const text = readNormalized(readmePath)
  const lines = text.split('\n')
  const headerIndex = lines.indexOf(README_TABLE_HEADER)
  if (headerIndex === -1) {
    return '未更新（未找到 Skills 表头）'
  }

  const skillPathToken = `\`skills/${skillName}/SKILL.md\``
  const existingRowIndex = lines.findIndex((line, index) => index > headerIndex && line.includes(skillPathToken))
  if (existingRowIndex !== -1) {
    const existingRow = parseReadmeRow(lines[existingRowIndex])
    const row = buildReadmeRow({
      skillName,
      description: description || existingRow?.description || '',
      scenario: scenario || existingRow?.scenario || DEFAULT_SCENARIO,
    })
    if (lines[existingRowIndex] === row) {
      return '已存在'
    }
    lines[existingRowIndex] = row
    writeFile(readmePath, lines.join('\n'))
    return '已更新'
  }

  const row = buildReadmeRow({
    skillName,
    description,
    scenario: scenario || DEFAULT_SCENARIO,
  })

  let insertAt = headerIndex + 2
  while (insertAt < lines.length && lines[insertAt].startsWith('|')) {
    insertAt += 1
  }

  lines.splice(insertAt, 0, row)
  writeFile(readmePath, lines.join('\n'))
  return '已追加'
}

function buildReadmeRow({ skillName, description, scenario }) {
  return README_ROW_TEMPLATE
    .replaceAll('{name}', skillName)
    .replace('{description}', description)
    .replace('{scenario}', scenario)
}

function parseReadmeRow(line) {
  const cells = line.split('|').map((cell) => cell.trim())
  if (cells.length < 5) {
    return null
  }

  return {
    name: cells[1] || '',
    description: cells[2] || '',
    scenario: cells[3] || '',
    path: cells[4] || '',
  }
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`
}

main()
