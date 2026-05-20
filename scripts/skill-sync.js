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
const CHECK_FLAGS = new Set(['--check', '--dry-run'])
const README_MODULE_REFERENCE_PATTERN = /`(skills\/odai\/references\/modules\/[^`]+\.md)`/g
const ROUTE_MAP_OUTPUT_PATH = path.join('plans', 'odai-route-map.md')
const MODULE_ROUTE_ORDER = [
  'dao',
  'harness-dev',
  'game-plan',
  'game-design',
  'feature-plan',
  'design-spec',
  'implement-code',
  'project-guide',
  'review-sslb',
  'ribao',
]
const SOURCE_VALIDATION_RULES = {
  odai: {
    requiredRelativePaths: [
      'references/dao/terminology-baseline.md',
      'references/dao/interaction-contract.md',
      'references/dao/parallel-consensus-trigger.md',
      'references/dao/parallel-consensus-playbook.md',
      'references/dao/model-selection-baseline.md',
      'assets/dao/subagent-execution-template.md',
    ],
    requiredReadmeHeadings: ['### 面向大多数使用者', '### 仓库维护工具', '### 2. 手动安装', '### 维护流程', '## 目录说明'],
    requiredReadmeSnippets: [
      '标准安装入口：',
      '`skills/odai/SKILL.md`',
      '`skills/skill-author/SKILL.md`',
      '`skills/skill-sync/SKILL.md`',
      'skills/odai/           统一入口 source skill',
    ],
    bannedReadmePhrases: [
      {
        phrase: 'review-hgsc',
        guidance: '改成当前统一审查入口 `review-sslb`，旧多风格审查不要留在 main 分支 README',
      },
      {
        phrase: 'review-gal',
        guidance: '改成当前统一审查入口 `review-sslb`，旧多风格审查不要留在 main 分支 README',
      },
      {
        phrase: 'review-band',
        guidance: '改成当前统一审查入口 `review-sslb`，旧多风格审查不要留在 main 分支 README',
      },
      {
        phrase: 'review-anime',
        guidance: '改成当前统一审查入口 `review-sslb`，旧多风格审查不要留在 main 分支 README',
      },
    ],
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
      {
        phrase: '先立四格：确定、待验、待定、风险',
        guidance: '改成“已验、待验、待定、风险”，与 terminology-baseline 保持一致',
      },
      {
        phrase: '已知、已验、未确认、冲突、必问',
        guidance: '改成“已知事实、已验证事实、未确认点、冲突点、必须确认的问题”，与 terminology-baseline 保持一致',
      },
      {
        phrase: '今判、所求、所重、确定/待验/待定、目标与非目标',
        guidance: '改成“今判、所求、所重、已验/待验/待定/相左、目标与非目标”',
      },
      {
        phrase: '需要提问时，若宿主提问工具在当前模式可用且上层规则允许，调用宿主提问工具；否则直接文字成组问。',
        guidance: '改成“提问通道与文字兜底统承 terminology-baseline；此处只补本文件新增规则”',
      },
      {
        phrase: '若当前环境未暴露提问工具，或当前模式/上层规则不允许调用，直接改用文字提问；同层问题仍应一次成组问完，不拆成零碎盘问。',
        guidance: '改成“提问通道与文字兜底统承 terminology-baseline”，避免在 dao-shu-fa-playbook 重写全局兜底',
      },
      {
        phrase: '默认一句可了，不出二句；非必要不外显三层。',
        guidance: '改成“短式字段、语体与展开口径统承 terminology-baseline；此处只补三态折法”',
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
const DEFAULT_SKILL_NAMES = ['odai', 'skill-author', 'skill-sync']
const ROUTE_MAP_SKILL_NAMES = ['odai']
const USAGE_ERROR = '错误：skill 名称必须是非空且不含空格的单个标识，例如：skill-sync odai、skill-sync --check skill-author、skill-sync --stats odai'

function main() {
  const { skillNames, checkOnly, printStats, writeRouteMap } = parseCliArgs(process.argv.slice(2))

  const repoRoot = path.resolve(__dirname, '..')
  const readmePath = path.join(repoRoot, 'README.md')
  const skillPayloads = skillNames.map((skillName) => loadSkillPayload(repoRoot, skillName))

  if (printStats || writeRouteMap) {
    for (const payload of skillPayloads) {
      if (printStats) {
        printSkillStats(payload)
      }
      if (writeRouteMap) {
        writeSkillRouteMap({ repoRoot, payload })
      }
    }
    return
  }

  for (const payload of skillPayloads) {
    if (checkOnly) {
      checkSkillPayloadSync({ repoRoot, readmePath, payload })
      continue
    }

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

function parseCliArgs(args) {
  const skillArgs = []
  let checkOnly = false
  let printStats = false
  let writeRouteMap = false

  for (const arg of args) {
    if (CHECK_FLAGS.has(arg)) {
      checkOnly = true
      continue
    }
    if (arg === '--stats') {
      printStats = true
      continue
    }
    if (arg === '--route-map') {
      writeRouteMap = true
      continue
    }
    if (arg.startsWith('--')) {
      fail(`错误：未知参数 ${arg}。可用参数：--check、--dry-run、--stats、--route-map`)
    }
    skillArgs.push(arg)
  }

  return {
    skillNames: parseSkillNames(skillArgs, writeRouteMap ? ROUTE_MAP_SKILL_NAMES : DEFAULT_SKILL_NAMES),
    checkOnly,
    printStats,
    writeRouteMap,
  }
}

function parseSkillNames(args, defaultSkillNames) {
  if (args.length === 0) {
    return [...defaultSkillNames]
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

function checkSkillPayloadSync({ repoRoot, readmePath, payload }) {
  const problems = []

  for (const target of TARGETS) {
    const targetRoot = path.join(repoRoot, ...target.rootSegments)
    const targetSkillDir = path.join(targetRoot, target.resourceBaseDir(payload.skillName))
    const entryRelativePath = target.entryRelativePath(payload.skillName)
    const entryPath = path.join(targetRoot, entryRelativePath)
    const resourcePrefix = target.rewriteResourcePaths ? `${payload.skillName}/` : ''
    const rewriteOptions = {
      skillName: payload.skillName,
      entryReferencePath: path.basename(entryRelativePath),
      resourcePrefix,
      bundledResourceDirs: payload.bundledResourceDirs,
    }
    const targetBody = rewriteInstallPathReferences(payload.sourceBody, rewriteOptions)
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

    const expectedFiles = new Map()
    const expectedAbsentPaths = []
    addExpectedTextFile(expectedFiles, entryPath, content)

    for (const relativePath of target.legacyEntryRelativePaths(payload.skillName)) {
      expectedAbsentPaths.push(path.join(targetRoot, relativePath))
    }
    for (const replacedSkillName of payload.replaces) {
      expectedAbsentPaths.push(path.join(targetRoot, target.entryRelativePath(replacedSkillName)))
      for (const relativePath of target.legacyEntryRelativePaths(replacedSkillName)) {
        expectedAbsentPaths.push(path.join(targetRoot, relativePath))
      }
      const resourceBaseDir = target.resourceBaseDir(replacedSkillName)
      if (resourceBaseDir) {
        expectedAbsentPaths.push(path.join(targetRoot, resourceBaseDir))
      }
    }

    for (const dirName of BUNDLED_RESOURCE_DIRS) {
      const sourceResourceDir = path.join(payload.sourceDir, dirName)
      const targetResourceDir = path.join(targetSkillDir, dirName)
      if (!fs.existsSync(sourceResourceDir)) {
        expectedAbsentPaths.push(targetResourceDir)
        continue
      }

      for (const sourceFilePath of walkFiles(sourceResourceDir)) {
        const relativePath = path.relative(sourceResourceDir, sourceFilePath)
        const targetFilePath = path.join(targetResourceDir, relativePath)
        if (VALIDATED_TEXT_EXTENSIONS.has(path.extname(sourceFilePath))) {
          const rewritten = rewriteInstallPathReferences(readNormalized(sourceFilePath), rewriteOptions)
          addExpectedTextFile(expectedFiles, targetFilePath, rewritten)
        } else {
          expectedFiles.set(targetFilePath, {
            type: 'binary',
            content: fs.readFileSync(sourceFilePath),
          })
        }
      }
    }

    const expectedPathSet = new Set(expectedFiles.keys())
    for (const dirName of BUNDLED_RESOURCE_DIRS) {
      const targetResourceDir = path.join(targetSkillDir, dirName)
      if (!fs.existsSync(targetResourceDir)) {
        continue
      }
      for (const currentFilePath of walkFiles(targetResourceDir)) {
        if (!expectedPathSet.has(currentFilePath)) {
          problems.push(`多余安装资源：${path.relative(repoRoot, currentFilePath)}`)
        }
      }
    }

    for (const [expectedPath, expected] of expectedFiles.entries()) {
      if (!fs.existsSync(expectedPath)) {
        problems.push(`缺少安装文件：${path.relative(repoRoot, expectedPath)}`)
        continue
      }
      if (expected.type === 'text') {
        const current = normalizeComparableText(readNormalized(expectedPath))
        if (current !== expected.content) {
          problems.push(`安装文件未同步：${path.relative(repoRoot, expectedPath)}`)
        }
        continue
      }
      if (!fs.readFileSync(expectedPath).equals(expected.content)) {
        problems.push(`安装二进制资源未同步：${path.relative(repoRoot, expectedPath)}`)
      }
    }

    for (const absentPath of expectedAbsentPaths) {
      if (fs.existsSync(absentPath)) {
        problems.push(`旧安装产物未清理：${path.relative(repoRoot, absentPath)}`)
      }
    }
  }

  const readmeStatus = syncReadme(
    readmePath,
    payload.skillName,
    payload.description,
    payload.sourceScenario,
    payload.readmeSection,
    payload.replaces,
    { write: false }
  )
  if (readmeStatus.changed) {
    problems.push(`README.md 需要同步：${readmeStatus.message}`)
  }

  if (problems.length > 0) {
    fail(`错误：skills/${payload.skillName}/ 同步检查未通过。\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
  }

  console.log(`检查通过：skills/${payload.skillName}/ 与安装产物一致。`)
}

function addExpectedTextFile(expectedFiles, filePath, content) {
  expectedFiles.set(filePath, {
    type: 'text',
    content: normalizeComparableText(content),
  })
}

function normalizeComparableText(text) {
  return ensureTrailingNewline(text).replace(/\r\n/g, '\n')
}

function printSkillStats(payload) {
  const markdownFiles = walkFiles(payload.sourceDir).filter((filePath) => path.extname(filePath) === '.md')
  const stats = summarizeMarkdownFiles(markdownFiles)
  const skillBytes = fs.statSync(path.join(payload.sourceDir, 'SKILL.md')).size
  const referencesBytes = summarizeMarkdownFiles(markdownFiles.filter((filePath) => isInsideDir(filePath, payload.sourceDir, 'references'))).bytes
  const assetsBytes = summarizeMarkdownFiles(markdownFiles.filter((filePath) => isInsideDir(filePath, payload.sourceDir, 'assets'))).bytes

  console.log(`统计：skills/${payload.skillName}/`)
  console.log(`- Markdown 文件：${stats.files}`)
  console.log(`- Markdown 行数：${stats.lines}`)
  console.log(`- Markdown 字节：${stats.bytes}`)
  console.log(`- SKILL.md 字节：${skillBytes}`)
  console.log(`- references/ 字节：${referencesBytes}`)
  console.log(`- assets/ Markdown 字节：${assetsBytes}`)
}

function summarizeMarkdownFiles(filePaths) {
  return filePaths.reduce(
    (summary, filePath) => {
      const text = readNormalized(filePath)
      return {
        files: summary.files + 1,
        lines: summary.lines + countLines(text),
        bytes: summary.bytes + fs.statSync(filePath).size,
      }
    },
    { files: 0, lines: 0, bytes: 0 }
  )
}

function countLines(text) {
  if (!text) {
    return 0
  }
  return text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length
}

function isInsideDir(filePath, sourceDir, dirName) {
  const relativePath = path.relative(path.join(sourceDir, dirName), filePath)
  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

function writeSkillRouteMap({ repoRoot, payload }) {
  const outputPath = path.join(repoRoot, ROUTE_MAP_OUTPUT_PATH)
  const content = buildSkillRouteMap(payload)
  writeFile(outputPath, content)
  console.log(`已生成：${ROUTE_MAP_OUTPUT_PATH}`)
}

function buildSkillRouteMap(payload) {
  const moduleDir = path.join(payload.sourceDir, 'references', 'modules')
  if (!fs.existsSync(moduleDir)) {
    fail(`错误：skills/${payload.skillName}/ 不包含 references/modules/，无法生成模块路由维护表。`)
  }
  const moduleFiles = fs
    .readdirSync(moduleDir)
    .filter((name) => name.endsWith('.md'))
    .sort((left, right) => moduleSortIndex(left) - moduleSortIndex(right) || left.localeCompare(right))

  const lines = [
    '# odai 模块路由维护表',
    '',
    '本文件由 `node scripts/skill-sync.js --route-map` 根据 `skills/odai/references/modules/` 自动生成。',
    '',
    '| 模块 | 触发语义 | 最小产物 / 裁决 | 必读 support files |',
    '| --- | --- | --- | --- |',
  ]

  for (const fileName of moduleFiles) {
    const filePath = path.join(moduleDir, fileName)
    const text = readNormalized(filePath)
    const { frontmatter, body } = splitFrontmatter(text)
    const moduleName = getFrontmatterValue(frontmatter, 'name') || path.basename(fileName, '.md')
    const trigger = getFrontmatterValue(frontmatter, 'scenario') || getFrontmatterValue(frontmatter, 'description') || '-'
    const outputs = extractMinimalOutputs(body, moduleName)
    const supportFiles = extractSupportFiles(body)
    lines.push(
      `| \`${moduleName}\` | ${escapeMarkdownTableCell(trigger)} | ${escapeMarkdownTableCell(outputs)} | ${escapeMarkdownTableCell(supportFiles)} |`
    )
  }

  return `${lines.join('\n')}\n`
}

function moduleSortIndex(fileName) {
  const moduleName = path.basename(fileName, '.md')
  const index = MODULE_ROUTE_ORDER.indexOf(moduleName)
  return index === -1 ? MODULE_ROUTE_ORDER.length : index
}

function extractMinimalOutputs(body, moduleName) {
  const currentDecisionMatch = body.match(/当前裁决：([^\n]+)/)
  if (currentDecisionMatch) {
    return currentDecisionMatch[1].trim()
  }

  const fallbackOutputs = {
    'review-sslb': '审查范围、六部意见、门下省终审、锦衣卫监察密报',
    ribao: '日报 / commit message / PR message 的结构化成果描述',
  }
  return fallbackOutputs[moduleName] || '当前理解、待确认项、下一步或对应交付草案'
}

function extractSupportFiles(body) {
  const matches = body.match(/`((?:references|assets|scripts)\/[^`]+)`/g) || []
  const supportFiles = normalizeListValues(matches.map((match) => match.slice(1, -1))).filter(
    (filePath) => !filePath.includes('<') && !filePath.includes('{')
  )
  return supportFiles.length > 0 ? supportFiles.map((filePath) => `\`${filePath}\``).join('<br>') : '无'
}

function escapeMarkdownTableCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>')
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
  const bannedReadmePhrases = rules.bannedReadmePhrases || []
  if (requiredHeadings.length === 0 && requiredSnippets.length === 0 && bannedReadmePhrases.length === 0) {
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
  const readmeViolations = collectReadmeValidationViolations(lines, bannedReadmePhrases)
  const missingModuleReferences = collectMissingReadmeModuleReferences(repoRoot, text)

  if (
    missingHeadings.length === 0 &&
    missingSnippets.length === 0 &&
    readmeViolations.length === 0 &&
    missingModuleReferences.length === 0
  ) {
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

  if (readmeViolations.length > 0) {
    messageLines.push('命中 README 禁用旧口径：')
    for (const violation of readmeViolations) {
      messageLines.push(`- README.md:${violation.lineNumber} 含“${violation.phrase}”，请${violation.guidance}`)
    }
  }

  if (missingModuleReferences.length > 0) {
    messageLines.push('README 引用了不存在的内部模块文件：')
    for (const relativePath of missingModuleReferences) {
      messageLines.push(`- ${relativePath}`)
    }
  }

  fail(messageLines.join('\n'))
}

function collectReadmeValidationViolations(lines, bannedReadmePhrases) {
  const violations = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const rule of bannedReadmePhrases) {
      const hit = rule.pattern ? rule.pattern.test(line) : line.includes(rule.phrase)
      if (!hit) {
        continue
      }
      violations.push({
        lineNumber: index + 1,
        phrase: rule.phrase,
        guidance: rule.guidance,
      })
    }
  }
  return violations
}

function collectMissingReadmeModuleReferences(repoRoot, text) {
  const missing = []
  const seen = new Set()
  for (const match of text.matchAll(README_MODULE_REFERENCE_PATTERN)) {
    const relativePath = match[1]
    if (relativePath.includes('<') || relativePath.includes('{')) {
      continue
    }
    if (seen.has(relativePath)) {
      continue
    }
    seen.add(relativePath)
    if (!fs.existsSync(path.join(repoRoot, relativePath))) {
      missing.push(relativePath)
    }
  }
  return missing
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

function syncReadme(readmePath, skillName, description, scenario, readmeSection, replaces = [], options = {}) {
  const shouldWrite = options.write !== false
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
        if (shouldWrite) {
          writeFile(readmePath, lines.join('\n'))
        }
      }
      return {
        message: formatReadmeStatus('已存在', removedSkills),
        removedSkills,
        changed: normalizedExistingRows || removedSkills.length > 0,
      }
    }
    if (isReadmeRowInSection(lines, existingRowIndex, targetSection)) {
      lines[existingRowIndex] = row
      if (shouldWrite) {
        writeFile(readmePath, lines.join('\n'))
      }
      return {
        message: formatReadmeStatus('已更新', removedSkills),
        removedSkills,
        changed: true,
      }
    }

    lines.splice(existingRowIndex, 1)
    const relocatedHeaderIndex = findReadmeTableHeaderIndex(lines, targetSection)
    const insertAt = findReadmeTableInsertIndex(lines, relocatedHeaderIndex)
    lines.splice(insertAt, 0, row)
    if (shouldWrite) {
      writeFile(readmePath, lines.join('\n'))
    }
    return {
      message: formatReadmeStatus('已更新（已移动到对应分组）', removedSkills),
      removedSkills,
      changed: true,
    }
  }

  const row = buildReadmeRow({
    skillName,
    description,
    scenario: scenario || DEFAULT_SCENARIO,
  })

  const insertAt = findReadmeTableInsertIndex(lines, headerIndex)
  lines.splice(insertAt, 0, row)
  if (shouldWrite) {
    writeFile(readmePath, lines.join('\n'))
  }
  return {
    message: formatReadmeStatus('已追加', removedSkills),
    removedSkills,
    changed: true,
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
