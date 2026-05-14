#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const README_TABLE_HEADER = '| Skill | 简介 | 适用场景 | 对应文件 |'
const README_ROW_TEMPLATE = '| `{name}` | {description} | {scenario} | `skills/{name}/SKILL.md` |'
const DEFAULT_SCENARIO = 'skill 定稿后的多端同步'
const README_SECTION_HEADINGS = {
  main: '### 面向大多数使用者',
  review: '### 审查类 skill',
  maintenance: '### 仓库维护工具',
}
const CLAUDE_ARGUMENT_BLOCK = '\n用户输入：\n$ARGUMENTS\n\n'
const BUNDLED_RESOURCE_DIRS = ['references', 'assets', 'scripts']
const VALIDATED_TEXT_EXTENSIONS = new Set(['.md'])
const SOURCE_VALIDATION_RULES = {
  odai: {
    requiredRelativePaths: [
      'references/dao/terminology-baseline.md',
      'references/dao/parallel-consensus-playbook.md',
      'references/dao/model-selection-baseline.md',
      'assets/dao/subagent-execution-template.md',
    ],
    requiredReadmeHeadings: ['### 面向大多数使用者', '### 2. 手动安装', '### 维护流程', '## 目录说明'],
    requiredReadmeSnippets: ['标准安装入口：', '`skills/odai/SKILL.md`', 'skills/odai/           统一入口 source skill'],
    bannedPhrases: [
      {
        phrase: '问题定义候选',
        guidance: '改成“已知事实 / 未确认点 / 冲突点 / 必须确认的问题”',
      },
      {
        phrase: '目标候选',
        guidance: '改成“已知事实”或“待确认点”',
      },
      {
        phrase: '候选理解',
        guidance: '改成“未确认点”或直接提问，不要代替用户确认',
      },
      {
        phrase: '候选路线',
        guidance: '改成“已确认路径 / 待确认路径”',
      },
      {
        phrase: '候选路径',
        guidance: '改成“已确认路径 / 待确认路径”',
      },
      {
        phrase: '候选选项',
        guidance: '改成“待确认问题、待验证项或风险项”',
      },
      {
        phrase: '推荐路径',
        guidance: '改成“已确认路径 / 待确认路径”',
      },
      {
        phrase: '推荐方向',
        guidance: '改成“待确认路径”或“必须确认的问题”',
      },
      {
        phrase: '推荐默认项',
        guidance: '改成“必须确认的问题”，不要预设默认答案',
      },
      {
        phrase: '推荐方案',
        guidance: '改成“已确认方案”或“待确认方案草案”',
      },
      {
        phrase: '推荐指令草稿',
        guidance: '改成“续执行指令骨架”或“后续指令模板”',
      },
      {
        phrase: '默认路线',
        guidance: '改成“未经确认的继续方向”或“继续依据”',
      },
      {
        phrase: '推断项',
        guidance: '改成“待验证项 / 待确认项 / 风险项”',
      },
      {
        phrase: '退回文本提问',
        guidance: '改成“先明确说明‘当前环境未暴露提问工具’，再改用文字提问”',
      },
      {
        phrase: '不降级为零碎文本盘问',
        guidance: '改成“先明确说明‘当前环境未暴露提问工具’，再改用文字提问”',
      },
      {
        phrase: '结构化提问（即调用 `vscode_askQuestions`）',
        guidance: '改成“结构化提问（调用宿主提问工具）”，并把 VS Code 示例留在宿主映射里',
      },
      {
        phrase: '结构化提问专指调用 `vscode_askQuestions`',
        guidance: '改成“结构化提问专指调用宿主提问工具”',
      },
      {
        phrase: '结构化提问即调用 `vscode_askQuestions`',
        guidance: '改成“结构化提问即调用宿主提问工具”',
      },
      {
        phrase: '必须调用 `vscode_askQuestions`',
        guidance: '改成“宿主提问工具可用且获准时调用；不可用或上层不允许时文字成组问”',
      },
      {
        phrase: '可用时调用 `vscode_askQuestions`',
        guidance: '改成“宿主提问工具可用且获准时调用；不可用或上层不允许时文字成组问”',
      },
      {
        phrase: '凡应问者必须调宿主提问工具',
        guidance: '改成“可用且获准时调用；不可用或上层不允许时文字成组问”',
      },
      {
        phrase: '必须调用宿主提问工具',
        pattern: /(?<![不无否])必须调用宿主提问工具/,
        guidance: '改成“可用且获准时调用；不可用或上层不允许时文字成组问”',
      },
      {
        phrase: '默认先调用宿主提问工具',
        pattern: /(?<![不无否])默认先调用宿主提问工具/,
        guidance: '改成“先成组提问；工具可用且获准时才调用”',
      },
    ],
  },
}
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
const DEFAULT_SKILL_NAMES = ['odai']
const USAGE_ERROR = '错误：skill 名称必须是非空且不含空格的单个标识，例如：skill-sync odai'

function main() {
  const skillNames = parseSkillNames(process.argv.slice(2))

  const repoRoot = path.resolve(__dirname, '..')
  const readmePath = path.join(repoRoot, 'README.md')
  const skillPayloads = skillNames.map((skillName) => loadSkillPayload(repoRoot, skillName))

  for (const payload of skillPayloads) {
    const outputs = new Map()
    const resourceOutputs = []
    const cleanupOutputs = []

    for (const target of TARGETS) {
      const targetRoot = path.join(repoRoot, ...target.rootSegments)
      const entryRelativePath = target.entryRelativePath(payload.skillName)
      const entryPath = path.join(targetRoot, entryRelativePath)
      const resourcePrefix = target.rewriteResourcePaths ? `${payload.skillName}/` : ''
      const targetBody = rewriteInstallPathReferences(payload.sourceBody, {
        skillName: payload.skillName,
        entryReferencePath: path.basename(entryRelativePath),
        resourcePrefix,
        bundledResourceDirs: payload.bundledResourceDirs,
      })

      const content =
        target.kind === 'claude'
          ? buildClaudeTarget({
              name: payload.sourceName,
              description: payload.description,
              body: targetBody,
              claudeConfig: payload.claudeConfig,
            })
          : buildGenericTarget({
              name: payload.sourceName,
              description: payload.description,
              body: targetBody,
            })

      cleanupOutputs.push(...removeLegacyEntries(targetRoot, target.legacyEntryRelativePaths(payload.skillName), repoRoot))
      cleanupOutputs.push(
        ...removeReplacedSkillArtifacts({
          repoRoot,
          targetRoot,
          target,
          replacedSkillNames: payload.replaces,
        })
      )
      fs.mkdirSync(path.dirname(entryPath), { recursive: true })
      writeFile(entryPath, content)
      outputs.set(entryPath, content)

      resourceOutputs.push(
        ...syncBundledResourcesForTarget({
          repoRoot,
          sourceDir: payload.sourceDir,
          skillName: payload.skillName,
          bundledResourceDirs: payload.bundledResourceDirs,
          entryReferencePath: path.basename(entryRelativePath),
          resourcePrefix,
          targetRoot,
          targetSkillDir: path.join(targetRoot, target.resourceBaseDir(payload.skillName)),
        })
      )
    }

    const readmeStatus = syncReadme(
      readmePath,
      payload.skillName,
      payload.description,
      payload.sourceScenario,
      payload.readmeSection,
      payload.replaces
    )

    console.log(`源文件：skills/${payload.skillName}/SKILL.md`)
    console.log('已更新：')
    for (const filePath of outputs.keys()) {
      console.log(`- ${path.relative(repoRoot, filePath)}`)
    }
    for (const resourcePath of resourceOutputs) {
      console.log(`- ${resourcePath}`)
    }
    if (cleanupOutputs.length > 0) {
      console.log('已清理：')
      for (const relativePath of cleanupOutputs) {
        console.log(`- ${relativePath}`)
      }
    }
    console.log(`- README：${readmeStatus.message}`)
    console.log('已按最小必要范围完成同步。')
  }
}

function parseSkillNames(args) {
  if (args.length === 0) {
    return [...DEFAULT_SKILL_NAMES]
  }

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

  if (!fs.existsSync(sourcePath)) {
    fail(MISSING_SOURCE_TEMPLATE.replace('{name}', skillName))
  }

  const sourceText = readNormalized(sourcePath)
  const { frontmatter: sourceFrontmatter, body: sourceBody } = splitFrontmatter(sourceText)
  const sourceName = getFrontmatterValue(sourceFrontmatter, 'name') || skillName
  const description = getFrontmatterValue(sourceFrontmatter, 'description') || ''
  const sourceScenario = getFrontmatterValue(sourceFrontmatter, 'scenario')
  const readmeSection = getFrontmatterValue(sourceFrontmatter, 'readme-section')
  const replaces = getFrontmatterList(sourceFrontmatter, 'replaces').filter((name) => name !== skillName)
  const bundledResourceDirs = getBundledResourceDirs(sourceDir)
  const claudeConfig = {
    allowedTools: getFrontmatterValue(sourceFrontmatter, 'claude-allowed-tools'),
    argumentHint: getFrontmatterValue(sourceFrontmatter, 'claude-argument-hint'),
  }

  validateSkillSource({ repoRoot, skillName, sourceDir })
  validateReadmeContract({ repoRoot, skillName })

  return {
    skillName,
    sourceDir,
    sourceBody,
    sourceName,
    description,
    sourceScenario,
    readmeSection,
    replaces,
    bundledResourceDirs,
    claudeConfig,
  }
}

function validateSkillSource({ repoRoot, skillName, sourceDir }) {
  const rules = SOURCE_VALIDATION_RULES[skillName]
  if (!rules) {
    return
  }

  const missingPaths = (rules.requiredRelativePaths || []).filter(
    (relativePath) => !fs.existsSync(path.join(sourceDir, relativePath))
  )
  const violations = collectSourceValidationViolations({
    repoRoot,
    sourceDir,
    bannedPhrases: rules.bannedPhrases || [],
  })

  if (missingPaths.length === 0 && violations.length === 0) {
    return
  }

  const messageLines = [`错误：skills/${skillName}/ 下的源文件未通过同步前校验。`]

  if (missingPaths.length > 0) {
    messageLines.push('缺少必备文件：')
    for (const relativePath of missingPaths) {
      messageLines.push(`- skills/${skillName}/${relativePath}`)
    }
  }

  if (violations.length > 0) {
    messageLines.push('命中禁用旧口径：')
    for (const violation of violations) {
      messageLines.push(
        `- ${violation.relativePath}:${violation.lineNumber} 含“${violation.phrase}”，请${violation.guidance}`
      )
    }
  }

  fail(messageLines.join('\n'))
}

function validateReadmeContract({ repoRoot, skillName }) {
  const rules = SOURCE_VALIDATION_RULES[skillName]
  if (!rules) {
    return
  }

  const requiredHeadings = rules.requiredReadmeHeadings || []
  const requiredSnippets = rules.requiredReadmeSnippets || []
  if (requiredHeadings.length === 0 && requiredSnippets.length === 0) {
    return
  }

  const readmePath = path.join(repoRoot, 'README.md')
  if (!fs.existsSync(readmePath)) {
    fail('错误：README.md 不存在，无法完成同步。')
  }

  const text = readNormalized(readmePath)
  const lines = text.split('\n')
  const missingHeadings = requiredHeadings.filter((heading) => !lines.includes(heading))
  const missingSnippets = requiredSnippets.filter((snippet) => !text.includes(snippet))

  if (missingHeadings.length === 0 && missingSnippets.length === 0) {
    return
  }

  const messageLines = ['错误：README.md 未通过同步前校验。']

  if (missingHeadings.length > 0) {
    messageLines.push('缺少关键分节：')
    for (const heading of missingHeadings) {
      messageLines.push(`- ${heading}`)
    }
  }

  if (missingSnippets.length > 0) {
    messageLines.push('缺少关键锚点：')
    for (const snippet of missingSnippets) {
      messageLines.push(`- ${snippet}`)
    }
  }

  fail(messageLines.join('\n'))
}

function collectSourceValidationViolations({ repoRoot, sourceDir, bannedPhrases }) {
  if (bannedPhrases.length === 0) {
    return []
  }

  const violations = []
  for (const filePath of walkFiles(sourceDir)) {
    if (!VALIDATED_TEXT_EXTENSIONS.has(path.extname(filePath))) {
      continue
    }

    const lines = readNormalized(filePath).split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      for (const rule of bannedPhrases) {
        const hit = rule.pattern ? rule.pattern.test(line) : line.includes(rule.phrase)
        if (!hit) {
          continue
        }

        violations.push({
          relativePath: path.relative(repoRoot, filePath),
          lineNumber: index + 1,
          phrase: rule.phrase,
          guidance: rule.guidance,
        })
      }
    }
  }

  return violations
}

function walkFiles(dirPath) {
  const files = []
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath))
      continue
    }
    if (entry.isFile()) {
      files.push(fullPath)
    }
  }
  return files
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function readNormalized(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
}

function writeFile(filePath, content) {
  const eol = detectLineEnding(filePath)
  const normalized = ensureTrailingNewline(content)
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, eol)
  fs.writeFileSync(filePath, normalized, 'utf8')
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

function getFrontmatterList(frontmatter, key) {
  const value = frontmatter[key]
  if (typeof value !== 'string') {
    return []
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return normalizeListValues(trimmed.slice(1, -1).split(','))
  }

  const multilineItems = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (multilineItems.length > 0 && multilineItems.every((line) => line.startsWith('- '))) {
    return normalizeListValues(multilineItems.map((line) => line.slice(2)))
  }

  return normalizeListValues([trimmed])
}

function normalizeListValues(values) {
  const normalized = []
  const seen = new Set()

  for (const rawValue of values) {
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '')
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    normalized.push(value)
  }

  return normalized
}

function getBundledResourceDirs(sourceDir) {
  return BUNDLED_RESOURCE_DIRS.filter((dirName) => {
    const fullPath = path.join(sourceDir, dirName)
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()
  })
}

function rewriteInstallPathReferences(text, { skillName, entryReferencePath, resourcePrefix, bundledResourceDirs }) {
  let result = rewriteSourceSkillEntryPath(text, skillName, entryReferencePath)

  for (const dirName of BUNDLED_RESOURCE_DIRS) {
    result = rewriteSourceSkillResourcePathPrefix(result, skillName, resourcePrefix, dirName)
  }

  return rewriteBundledResourcePaths(result, resourcePrefix, bundledResourceDirs)
}

function rewriteSourceSkillEntryPath(text, skillName, entryReferencePath) {
  return text
    .replaceAll(`./skills/${skillName}/SKILL.md`, entryReferencePath)
    .replaceAll(`skills/${skillName}/SKILL.md`, entryReferencePath)
}

function rewriteSourceSkillResourcePathPrefix(text, skillName, resourcePrefix, dirName) {
  return text
    .replaceAll(`./skills/${skillName}/${dirName}/`, `${resourcePrefix}${dirName}/`)
    .replaceAll(`skills/${skillName}/${dirName}/`, `${resourcePrefix}${dirName}/`)
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

function buildClaudeTarget({ name, description, body, claudeConfig }) {
  const lines = ['---', `name: ${name}`, `description: ${description || ''}`]

  if (claudeConfig?.allowedTools) {
    lines.push(`allowed-tools: ${claudeConfig.allowedTools}`)
  }
  if (claudeConfig?.argumentHint) {
    lines.push(`argument-hint: ${claudeConfig.argumentHint}`)
  }

  lines.push('---')

  const content = `${lines.join('\n')}\n${CLAUDE_ARGUMENT_BLOCK}${body.replace(/^\n+/, '')}`
  return ensureTrailingNewline(content)
}

function buildGenericTarget({ name, description, body }) {
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.replace(/^\n+/, '')}`
  return ensureTrailingNewline(content)
}

function syncBundledResourcesForTarget({
  repoRoot,
  sourceDir,
  skillName,
  bundledResourceDirs,
  entryReferencePath,
  resourcePrefix,
  targetRoot,
  targetSkillDir,
}) {
  const written = []

  for (const dirName of BUNDLED_RESOURCE_DIRS) {
    removeManagedDir(path.join(targetSkillDir, dirName))
  }

  for (const dirName of bundledResourceDirs) {
    const sourceResourceDir = path.join(sourceDir, dirName)
    const targetResourceDir = path.join(targetSkillDir, dirName)
    fs.mkdirSync(path.dirname(targetResourceDir), { recursive: true })
    fs.cpSync(sourceResourceDir, targetResourceDir, { recursive: true })
    rewriteInstallPathReferencesInDir(targetResourceDir, {
      skillName,
      entryReferencePath,
      resourcePrefix,
      bundledResourceDirs,
    })
    written.push(path.relative(repoRoot, targetResourceDir))
  }

  if (fs.existsSync(targetSkillDir) && fs.readdirSync(targetSkillDir).length === 0) {
    fs.rmdirSync(targetSkillDir)
  }

  return written
}

function removeLegacyEntries(targetRoot, legacyEntryRelativePaths, repoRoot) {
  return removeManagedPaths(targetRoot, legacyEntryRelativePaths, repoRoot)
}

function removeReplacedSkillArtifacts({ repoRoot, targetRoot, target, replacedSkillNames }) {
  const relativePaths = []

  for (const replacedSkillName of replacedSkillNames) {
    relativePaths.push(target.entryRelativePath(replacedSkillName))
    relativePaths.push(...target.legacyEntryRelativePaths(replacedSkillName))

    const resourceBaseDir = target.resourceBaseDir(replacedSkillName)
    if (resourceBaseDir) {
      relativePaths.push(resourceBaseDir)
    }
  }

  return removeManagedPaths(targetRoot, relativePaths, repoRoot)
}

function removeManagedPaths(rootPath, relativePaths, repoRoot) {
  const targets = normalizeListValues(relativePaths)
    .map((relativePath) => ({
      relativePath,
      absolutePath: path.join(rootPath, relativePath),
      depth: relativePath.split(/[\\/]/).length,
    }))
    .sort((left, right) => right.depth - left.depth || right.relativePath.length - left.relativePath.length)

  const removed = []

  for (const target of targets) {
    if (!fs.existsSync(target.absolutePath)) {
      continue
    }

    fs.rmSync(target.absolutePath, { recursive: true, force: true })
    if (repoRoot) {
      removed.push(path.relative(repoRoot, target.absolutePath))
    }
  }

  return removed
}

function removeManagedDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true })
  }
}

function rewriteInstallPathReferencesInDir(dirPath, options) {
  for (const filePath of walkFiles(dirPath)) {
    if (!VALIDATED_TEXT_EXTENSIONS.has(path.extname(filePath))) {
      continue
    }

    const rewritten = rewriteInstallPathReferences(readNormalized(filePath), options)
    writeFile(filePath, rewritten)
  }
}

function syncReadme(readmePath, skillName, description, scenario, readmeSection, replaces = []) {
  const text = readNormalized(readmePath)
  const lines = text.split('\n')
  const removedSkills = removeReadmeRows(lines, replaces)
  const targetSection = resolveReadmeSection(skillName, readmeSection)
  const headerIndex = findReadmeTableHeaderIndex(lines, targetSection)
  if (headerIndex === -1) {
    const sectionLabel = README_SECTION_HEADINGS[targetSection] || targetSection
    fail(`错误：README.md 未通过同步前校验。\n- 缺少 ${sectionLabel} 分组下的 Skills 表头：${README_TABLE_HEADER}`)
  }

  const skillPathToken = `\`skills/${skillName}/SKILL.md\``
  let normalizedExistingRows = false
  const existingRowIndices = lines
    .map((line, index) => (line.startsWith('|') && line.includes(skillPathToken) ? index : -1))
    .filter((index) => index !== -1)

  if (existingRowIndices.length > 1) {
    const preferredIndex =
      existingRowIndices.find((index) => isReadmeRowInSection(lines, index, targetSection)) ?? existingRowIndices[0]

    for (let index = existingRowIndices.length - 1; index >= 0; index -= 1) {
      const rowIndex = existingRowIndices[index]
      if (rowIndex === preferredIndex) {
        continue
      }
      lines.splice(rowIndex, 1)
      normalizedExistingRows = true
    }
  }

  const existingRowIndex = lines.findIndex((line) => line.startsWith('|') && line.includes(skillPathToken))
  if (existingRowIndex !== -1) {
    const existingRow = parseReadmeRow(lines[existingRowIndex])
    const row = buildReadmeRow({
      skillName,
      description: description || existingRow?.description || '',
      scenario: scenario || existingRow?.scenario || DEFAULT_SCENARIO,
    })
    if (lines[existingRowIndex] === row && isReadmeRowInSection(lines, existingRowIndex, targetSection)) {
      if (normalizedExistingRows || removedSkills.length > 0) {
        writeFile(readmePath, lines.join('\n'))
      }
      return {
        message: formatReadmeStatus('已存在', removedSkills),
        removedSkills,
      }
    }
    if (isReadmeRowInSection(lines, existingRowIndex, targetSection)) {
      lines[existingRowIndex] = row
      writeFile(readmePath, lines.join('\n'))
      return {
        message: formatReadmeStatus('已更新', removedSkills),
        removedSkills,
      }
    }

    lines.splice(existingRowIndex, 1)
    const relocatedHeaderIndex = findReadmeTableHeaderIndex(lines, targetSection)
    const insertAt = findReadmeTableInsertIndex(lines, relocatedHeaderIndex)
    lines.splice(insertAt, 0, row)
    writeFile(readmePath, lines.join('\n'))
    return {
      message: formatReadmeStatus('已更新（已移动到对应分组）', removedSkills),
      removedSkills,
    }
  }

  const row = buildReadmeRow({
    skillName,
    description,
    scenario: scenario || DEFAULT_SCENARIO,
  })

  const insertAt = findReadmeTableInsertIndex(lines, headerIndex)
  lines.splice(insertAt, 0, row)
  writeFile(readmePath, lines.join('\n'))
  return {
    message: formatReadmeStatus('已追加', removedSkills),
    removedSkills,
  }
}

function removeReadmeRows(lines, skillNames) {
  const removed = []

  for (const skillName of normalizeListValues(skillNames)) {
    const skillPathToken = `\`skills/${skillName}/SKILL.md\``
    let removedCurrentSkill = false
    let rowIndex = lines.findIndex((line) => line.startsWith('|') && line.includes(skillPathToken))

    while (rowIndex !== -1) {
      lines.splice(rowIndex, 1)
      removedCurrentSkill = true
      rowIndex = lines.findIndex((line) => line.startsWith('|') && line.includes(skillPathToken))
    }

    if (removedCurrentSkill) {
      removed.push(skillName)
    }
  }

  return removed
}

function formatReadmeStatus(status, removedSkills) {
  if (removedSkills.length === 0) {
    return status
  }
  return `${status}；已移除旧 skill 条目：${removedSkills.join('、')}`
}

function resolveReadmeSection(skillName, readmeSection) {
  if (readmeSection && Object.prototype.hasOwnProperty.call(README_SECTION_HEADINGS, readmeSection)) {
    return readmeSection
  }
  if (skillName.startsWith('review-')) {
    return 'review'
  }
  if (skillName.startsWith('skill-')) {
    return 'maintenance'
  }
  return 'main'
}

function findReadmeTableHeaderIndex(lines, section) {
  const heading = README_SECTION_HEADINGS[section]
  const headingIndex = heading ? lines.indexOf(heading) : -1
  if (headingIndex === -1) {
    return lines.indexOf(README_TABLE_HEADER)
  }
  return lines.findIndex((line, index) => index > headingIndex && line === README_TABLE_HEADER)
}

function findReadmeTableInsertIndex(lines, headerIndex) {
  let insertAt = headerIndex + 2
  while (insertAt < lines.length && lines[insertAt].startsWith('|')) {
    insertAt += 1
  }
  return insertAt
}

function isReadmeRowInSection(lines, rowIndex, section) {
  const headerIndex = findReadmeTableHeaderIndex(lines, section)
  if (headerIndex === -1) {
    return false
  }
  return rowIndex >= headerIndex + 2 && rowIndex < findReadmeTableInsertIndex(lines, headerIndex)
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

function detectLineEnding(filePath) {
  if (fs.existsSync(filePath)) {
    const text = fs.readFileSync(filePath, 'utf8')
    if (text.includes('\r\n')) {
      return '\r\n'
    }
  }
  return process.platform === 'win32' ? '\r\n' : '\n'
}

main()
