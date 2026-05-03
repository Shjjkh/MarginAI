import {
  App,
  Editor,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  addIcon,
  normalizePath,
  requestUrl,
  setIcon
} from 'obsidian'

const VIEW_TYPE_ANNOTATIONS = 'margin-ai-annotations'
const MARGIN_AI_ICON = `<path fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" d="M16 22h68v62H16z"/>
<path fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" d="M30 70V36l20 26 20-26v34"/>
<path fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" d="M82 10v18"/>
<path fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" d="M73 19h18"/>`

type ChatRole = 'system' | 'user' | 'assistant'
type AnnotationIntent = string
type AnnotationMode = 'ai' | 'note'
type WebSearchProvider = 'tavily' | 'custom'
type AnswerSkillId = string

interface ChatMessage {
  role: ChatRole
  content: string
}

interface MarginAISettings {
  annotationsFolder: string
  apiBaseUrl: string
  apiKey: string
  model: string
  webSearchEnabled: boolean
  webSearchProvider: WebSearchProvider
  webSearchEndpointTemplate: string
  webSearchApiKey: string
  webSearchResultLimit: number
  customSkillsFolder: string
}

interface MarginAIAnnotation {
  id: string
  sourcePath: string
  generatedNotePath?: string
  sidecarPath?: string
  sourceBlockId?: string
  quote: string
  anchorOffset: number
  question: string
  answer: string
  createdAt: number
  mode?: AnnotationMode
  intent?: AnnotationIntent
}

interface MarginAIData {
  settings: MarginAISettings
  annotations: MarginAIAnnotation[]
}

interface PendingQuestion {
  file: TFile
  quote: string
  anchorOffset: number
}

interface AnswerSkill {
  intent: AnnotationIntent
  id: AnswerSkillId
  match: string[]
  goal: string
  boundaries: string[]
  process: string[]
  finalOutput: string[]
  includeContext: boolean
  allowBackgroundKnowledge: boolean
  lengthHint: string
}

interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

const DEFAULT_SETTINGS: MarginAISettings = {
  annotationsFolder: 'MarginAI/Annotations',
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  webSearchEnabled: false,
  webSearchProvider: 'tavily',
  webSearchEndpointTemplate: '',
  webSearchApiKey: '',
  webSearchResultLimit: 5,
  customSkillsFolder: 'MarginAI/Skills'
}

const OUTPUT_RULES = `输出会直接保存到用户选中文本旁边的批注里。

通用输出规则：
- 只输出批注正文，不要输出任务说明、标签或元信息。
- 回复语言跟随用户问题。
- 不要寒暄，不要说”好的/当然/总结一下/希望有帮助”。
- 不要复述用户问题，不要复述”已选原文/用户问题”等标签。
- 不要输出 JSON、XML、HTML、代码围栏或表格。
- 使用简单 Markdown：短段落，或一级项目符号”- 要点”。
- 需要分段时，可以使用独立一行加粗小标题，例如”**核心解释**”，下一行再写正文；不要为了套格式而强行增加小节。
- 小标题只用加粗文本，不要使用 Markdown 标题符号 #。
- 如果用户要求推测、猜测、分析分工或具体工作，重点输出基于原文的增量推断，不要大段复述原文清单。
- 做推断时要标明确定性：哪些是原文直接支持，哪些是合理推断，哪些只是可能方向。
- 如果需要给出判断，在第一个小节中先给结论。`

const FALLBACK_SKILL: AnswerSkill = {
  intent: 'discussion',
  id: 'fallback-discussion',
  match: [],
  goal: '围绕用户选中的原文回答问题。',
  boundaries: [
    '优先依据已选原文和提供的上下文。',
    '如果使用背景知识或推断，必须和原文直接信息区分。',
    '不要编造原文没有的信息。'
  ],
  process: [
    '先理解用户问题。',
    '再找出原文能支持的回答依据。',
    '最后给出清楚、有帮助的批注正文。'
  ],
  finalOutput: [
    '先给核心回答。',
    '再补充必要解释。',
    '如果依据不足，明确说明不确定。'
  ],
  includeContext: true,
  allowBackgroundKnowledge: true,
  lengthHint: '默认中等篇幅，避免空泛。'
}

const WRAPPED_MARKDOWN_RE = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i
const LEADING_LABEL_RE = /^(?:answer|assistant|回复|回答|答案|分析|结论|批注|response)\s*[:：]\s*/i
const ECHOED_LABEL_RE = /^(?:已选原文|用户问题|passage|question)\s*[:：].*$/i
const TEMPLATE_PREFIX_RE = /^(?:根据(?:你|您)?(?:提供的|给出的)?(?:文本|原文|内容|选文)[，,：:\s]*|从(?:这段|原文|文本|内容)来看[，,：:\s]*|这段(?:文本|原文|内容)(?:主要)?(?:说明|表达|讲述|讨论)了[，,：:\s]*)/
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/
const STANDALONE_BOLD_HEADING_RE = /^\s*\*\*([^*\n]{2,60})\*\*\s*$/
const LISTED_BOLD_HEADING_RE = /^\s*(?:[-*+]|\d+[.)])\s+\*\*([^*\n]{2,60})\*\*\s*$/
const INTENT_CLASS_NAMES: Record<AnnotationIntent, string> = {
  concept: 'is-concept',
  confusion: 'is-confusion',
  discussion: 'is-discussion',
  inference: 'is-discussion',
  summary: 'is-summary',
  translation: 'is-translation',
  writing: 'is-writing'
}

const BUILTIN_SKILL_FILES = [
  'translation.json',
  'summary.json',
  'writing.json',
  'inference.json',
  'concept.json',
  'confusion.json',
  'discussion.json'
]

function normalizeAiAnswer(answer: string): string {
  let normalized = answer.replace(/\r\n/g, '\n').trim()
  const fenced = normalized.match(WRAPPED_MARKDOWN_RE)
  if (fenced) normalized = fenced[1].trim()

  normalized = normalized
    .split('\n')
    .filter(line => !ECHOED_LABEL_RE.test(line.trim()))
    .join('\n')
    .trim()

  normalized = normalized
    .replace(LEADING_LABEL_RE, '')
    .replace(TEMPLATE_PREFIX_RE, '')
    .trim()
  normalized = normalizeMarkdownStructure(normalized)
  normalized = compactMarkdownSpacing(normalized)
  return normalized || answer.trim()
}

function normalizeMarkdownStructure(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const normalized: string[] = []

  for (const line of lines) {
    const listedHeading = line.match(LISTED_BOLD_HEADING_RE)
    const nextLine = listedHeading ? `**${listedHeading[1].trim()}**` : line
    const isHeading = STANDALONE_BOLD_HEADING_RE.test(nextLine)
    const previous = normalized.at(-1)

    if (isHeading && previous && previous.trim() !== '' && !STANDALONE_BOLD_HEADING_RE.test(previous)) {
      normalized.push('')
    }
    normalized.push(nextLine)
  }

  return normalized.join('\n').trim()
}

function compactMarkdownSpacing(markdown: string): string {
  const lines = markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())

  const compacted: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const isBlank = line.trim().length === 0
    if (!isBlank) {
      compacted.push(line)
      continue
    }

    const previous = compacted.at(-1)
    if (!previous || previous.trim().length === 0) continue

    const next = lines.slice(index + 1).find(candidate => candidate.trim().length > 0)
    if (next && (LIST_ITEM_RE.test(next) || LIST_ITEM_RE.test(previous) || /[:：]$/.test(previous.trim()))) {
      continue
    }

    compacted.push('')
  }

  return compacted.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function extractSurroundingContext(documentContent: string, quote: string, maxChars = 1200): string | undefined {
  if (!documentContent || !quote.trim()) return undefined

  const exactIndex = documentContent.indexOf(quote)
  if (exactIndex >= 0) {
    const half = Math.floor(maxChars / 2)
    const start = Math.max(0, exactIndex - half)
    const end = Math.min(documentContent.length, exactIndex + quote.length + half)
    const context = documentContent.slice(start, end).trim()
    return context === quote.trim() ? undefined : context
  }

  const normalizedDoc = collapseWhitespace(documentContent)
  const normalizedQuote = collapseWhitespace(quote)
  const normalizedIndex = normalizedDoc.indexOf(normalizedQuote)
  if (normalizedIndex < 0) return undefined

  const half = Math.floor(maxChars / 2)
  const start = Math.max(0, normalizedIndex - half)
  const end = Math.min(normalizedDoc.length, normalizedIndex + normalizedQuote.length + half)
  const context = normalizedDoc.slice(start, end).trim()
  return context === normalizedQuote ? undefined : context
}

function listLines(items: string[]): string {
  return items.map(item => `- ${item}`).join('\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildSystemPrompt(skill: AnswerSkill): string {
  return `${OUTPUT_RULES}

Answer skill：${skill.id}

当前任务：
${skill.goal}

信息边界：
${listLines(skill.boundaries)}

允许使用背景知识：${skill.allowBackgroundKnowledge ? '是，但必须和原文依据区分。' : '否，只能依据已选原文和提供的上下文。'}

内部处理步骤：
${listLines(skill.process)}

最终输出要求：
${listLines(skill.finalOutput)}
- ${skill.lengthHint}
- 可以使用有信息量的小节标题组织答案，例如”**定义**”、”**为什么重要**”、”**放回原文看**”；标题必须服务内容，不要机械套模板，也不要覆盖原文已有结构。

重要：内部处理步骤只用于生成答案，不要把步骤标题、分析过程或这些规则输出给用户。`
}

function buildNewAnnotationMessages(
  quote: string,
  question: string,
  skill: AnswerSkill,
  surroundingContext?: string,
  webSearchContext?: string
): ChatMessage[] {
  const contextBlock = skill.includeContext && surroundingContext?.trim()
    ? `\n可参考的原文上下文：\n"""\n${surroundingContext.trim()}\n"""\n`
    : ''
  const searchBlock = webSearchContext?.trim()
    ? `\n外部网络检索资料：\n"""\n${webSearchContext.trim()}\n"""\n\n使用要求：\n- 网络资料只能作为背景补充或更新信息来源。\n- 回答中必须清楚区分”原文中的含义”和”网络补充”。\n- 如果网络结果不足、互相冲突或相关性弱，要如实说明，不要硬编。\n- 引用网络信息时尽量保留来源名称或链接。\n`
    : ''

  return [
    { role: 'system', content: buildSystemPrompt(skill) },
    {
      role: 'user',
      content: `已选原文：
"""
${quote}
"""
${contextBlock}
${searchBlock}
用户问题：
${question}`
    }
  ]
}

function shouldUseWebSearch(skill: AnswerSkill, question: string): boolean {
  const intent = skill.intent
  if (intent !== 'concept' && intent !== 'discussion') return false
  return /(最新|近期|现在|当下|202[4-9]|recent|latest|today|current|news|web|搜索|联网|查一下|资料|背景)/i.test(question)
    || intent === 'concept'
}

function buildSearchQueryPrompt(quote: string, question: string, surroundingContext?: string): ChatMessage[] {
  const contextBlock = surroundingContext?.trim()
    ? `\n可参考的原文上下文：\n"""\n${surroundingContext.trim().slice(0, 1200)}\n"""\n`
    : ''

  return [
    {
      role: 'system',
      content: [
        '你要为阅读批注生成联网搜索关键词。',
        '只输出 1 行搜索查询词，不要解释。',
        '查询词应包含用户真正需要查的新概念、技术名词、机构/产品名或背景主题。',
        '如果原文或问题是中文，但概念来自英文技术/产品，请优先保留英文专名。',
        '不要输出 JSON、编号、引号或多行。'
      ].join('\n')
    },
    {
      role: 'user',
      content: `已选原文：
"""
${quote}
"""
${contextBlock}
用户问题：
${question}`
    }
  ]
}

function cleanSearchQuery(value: string): string {
  return collapseWhitespace(value)
    .replace(/^[-*\d.)\s]+/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .slice(0, 160)
}

function clampSearchResultLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.webSearchResultLimit
  return Math.max(1, Math.min(10, Math.round(value)))
}

function parseStringArray(value: unknown, field: string, source: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${source}: ${field} must be a string array`)
  }
  return value.map(item => item.trim()).filter(Boolean)
}

function parseAnswerSkill(value: unknown, source: string): AnswerSkill {
  const record = value as Partial<AnswerSkill>
  if (!record || typeof record !== 'object') throw new Error(`${source}: skill must be an object`)
  if (typeof record.intent !== 'string' || !record.intent.trim()) throw new Error(`${source}: intent is required`)
  if (typeof record.id !== 'string' || !record.id.trim()) throw new Error(`${source}: id is required`)
  if (typeof record.goal !== 'string' || !record.goal.trim()) throw new Error(`${source}: goal is required`)
  if (typeof record.lengthHint !== 'string' || !record.lengthHint.trim()) throw new Error(`${source}: lengthHint is required`)

  return {
    intent: record.intent.trim(),
    id: record.id.trim(),
    match: parseStringArray(record.match ?? [], 'match', source),
    goal: record.goal.trim(),
    boundaries: parseStringArray(record.boundaries, 'boundaries', source),
    process: parseStringArray(record.process, 'process', source),
    finalOutput: parseStringArray(record.finalOutput, 'finalOutput', source),
    includeContext: Boolean(record.includeContext),
    allowBackgroundKnowledge: Boolean(record.allowBackgroundKnowledge),
    lengthHint: record.lengthHint.trim()
  }
}

function normalizeSearchResults(raw: unknown): WebSearchResult[] {
  const candidates = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { results?: unknown[] })?.results)
      ? (raw as { results: unknown[] }).results
      : Array.isArray((raw as { items?: unknown[] })?.items)
        ? (raw as { items: unknown[] }).items
        : Array.isArray((raw as { organic?: unknown[] })?.organic)
          ? (raw as { organic: unknown[] }).organic
          : Array.isArray((raw as { data?: unknown[] })?.data)
            ? (raw as { data: unknown[] }).data
            : Array.isArray((raw as { web?: { results?: unknown[] } })?.web?.results)
              ? (raw as { web: { results: unknown[] } }).web.results
              : []

  return candidates
    .map(item => {
      const record = item as Record<string, unknown>
      return {
        title: String(record.title ?? record.name ?? '').trim(),
        url: String(record.url ?? record.link ?? '').trim(),
        snippet: String(record.snippet ?? record.description ?? record.content ?? record.summary ?? record.text ?? '').trim()
      }
    })
    .filter(result => result.title || result.url || result.snippet)
}

function formatWebSearchContext(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) return ''
  return [
    `搜索关键词：${query}`,
    ...results.map((result, index) => {
      const lines = [`${index + 1}. ${result.title || 'Untitled result'}`]
      if (result.url) lines.push(`   URL: ${result.url}`)
      if (result.snippet) lines.push(`   摘要: ${result.snippet}`)
      return lines.join('\n')
    })
  ].join('\n')
}

function sourceWikiLink(file: TFile): string {
  return `[[${file.path.replace(/\.md$/i, '')}|${file.basename}]]`
}

function sourceBlockWikiLink(file: TFile, blockId?: string): string {
  if (!blockId) return sourceWikiLink(file)
  return `[[${file.path.replace(/\.md$/i, '')}#^${blockId}|选中原文]]`
}

function sourceQuoteWikiLink(file: TFile, annotation: MarginAIAnnotation): string {
  const target = annotation.sourceBlockId
    ? `${file.path.replace(/\.md$/i, '')}#^${annotation.sourceBlockId}`
    : file.path.replace(/\.md$/i, '')
  const alias = compactWikiAlias(annotation.quote)
  return `[[${target}|${alias}]]`
}

function compactWikiAlias(value: string): string {
  return collapseWhitespace(value)
    .replace(/[[\]|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '选中原文'
}

function preserveWikiAlias(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/\]\]/g, '] ]')
    .replace(/\s+/g, ' ')
    .trim()
}

function fileWikiTarget(path: string): string {
  return path.replace(/\.md$/i, '')
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Untitled'
}

function titleFromAnnotation(annotation: MarginAIAnnotation, detectIntentForQuestion: (question: string) => AnnotationIntent): string {
  const topic = topicFromQuote(annotation.quote)
  const question = collapseWhitespace(annotation.question)
  const intent = annotation.intent ?? detectIntentForQuestion(question)

  if (/(这|这个|这是|它|他|她|其|什么意思|是什么|啥意思|what is|what's|meaning)/i.test(question)) {
    return `${topic} 是什么`.slice(0, 36)
  }

  if (intent === 'concept') return `${topic} 概念`.slice(0, 36)
  if (intent === 'summary') return `${topic} 要点`.slice(0, 36)
  if (intent === 'translation') return `${topic} 翻译`.slice(0, 36)
  if (intent === 'writing') return `${topic} 改写`.slice(0, 36)
  if (intent === 'confusion') return `${topic} 如何理解`.slice(0, 36)
  return `${topic} 分析`.slice(0, 36)
}

function topicFromQuote(quote: string): string {
  const compact = collapseWhitespace(quote)
    .replace(/^[#>*\-\d.)\s]+/, '')
    .replace(/[，,。.!！?？:：；;].*$/, '')
    .trim()

  if (!compact) return 'MarginAI 批注'
  if (compact.length <= 18) return compact

  const latinMatch = compact.match(/[A-Za-z][A-Za-z0-9+._-]*(?:\s+[A-Za-z][A-Za-z0-9+._-]*){0,3}/)
  if (latinMatch?.[0] && latinMatch[0].length <= 28) return latinMatch[0]

  return compact.slice(0, 18)
}

function annotationNoteContent(
  annotation: MarginAIAnnotation,
  sourceFile: TFile,
  detectIntentForQuestion: (question: string) => AnnotationIntent
): string {
  const title = titleFromAnnotation(annotation, detectIntentForQuestion)
  return [
    `# ${title}`,
    '',
    `> - 【引用原文】${sourceQuoteWikiLink(sourceFile, annotation)}`,
    `> - 【提问】${annotation.question}`,
    '',
    noteAnswerMarkdown(annotation.answer),
    ''
  ].join('\n')
}

function annotationAnswerFromNote(markdown: string): string {
  const withoutTitle = markdown.replace(/^# .*(?:\n|$)/, '').trimStart()
  const lines = withoutTitle.split('\n')
  let bodyStart = 0

  while (bodyStart < lines.length) {
    const line = lines[bodyStart]
    if (line.trim() === '' || line.trim().startsWith('>')) {
      bodyStart += 1
      continue
    }
    break
  }

  return cardAnswerMarkdown(lines.slice(bodyStart).join('\n').trim())
}

function cardAnswerMarkdown(markdown: string): string {
  return compactMarkdownSpacing(normalizeMarkdownStructure(markdown))
    .split('\n')
    .map(line => {
      const heading = line.trim().match(/^#{2,6}\s+(.+?)\s*$/)
      if (!heading) return line
      return `**${heading[1].trim()}**`
    })
    .join('\n')
}

function firstSentence(markdown: string): string {
  const plain = markdown
    .replace(/^#+\s+/gm, '')
    .replace(LIST_ITEM_RE, '')
    .split('\n')
    .find(line => line.trim().length > 0) ?? ''
  return plain.split(/[。.!！?？]/)[0] ?? plain
}

function noteAnswerMarkdown(answer: string): string {
  return compactMarkdownSpacing(normalizeMarkdownStructure(answer))
    .split('\n')
    .map(line => {
      const heading = line.trim().match(/^\*\*([^*\n]{2,40})\*\*\s*$/)
      if (!heading) return line
      return `## ${heading[1].replace(/[：:]\s*$/, '').trim()}`
    })
    .join('\n')
}

class MarginAISettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MarginAIPlugin) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl)
      .setName('批注笔记文件夹')
      .setDesc('点击“生成笔记”后，批注 Markdown 笔记的保存位置。')
      .addText(text => text
        .setValue(this.plugin.settings.annotationsFolder)
        .onChange(async value => {
          this.plugin.settings.annotationsFolder = value.trim() || DEFAULT_SETTINGS.annotationsFolder
          await this.plugin.persist()
        }))

    new Setting(containerEl)
      .setName('API Base URL')
      .setDesc('OpenAI-compatible endpoint，例如 https://api.openai.com/v1。')
      .addText(text => text
        .setValue(this.plugin.settings.apiBaseUrl)
        .onChange(async value => {
          this.plugin.settings.apiBaseUrl = value.trim() || DEFAULT_SETTINGS.apiBaseUrl
          await this.plugin.persist()
        }))

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('密钥只保存在本地 Obsidian 插件数据中。')
      .addText(text => {
        text.inputEl.type = 'password'
        text
          .setValue(this.plugin.settings.apiKey)
          .onChange(async value => {
            this.plugin.settings.apiKey = value.trim()
            await this.plugin.persist()
          })
      })

    new Setting(containerEl)
      .setName('模型')
      .addText(text => text
        .setValue(this.plugin.settings.model)
        .onChange(async value => {
          this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model
          await this.plugin.persist()
        }))

    new Setting(containerEl)
      .setName('自定义 Skills 文件夹')
      .setDesc('可选。放置 JSON skill 文件；同 intent 会覆盖内置 skill。')
      .addText(text => text
        .setPlaceholder(DEFAULT_SETTINGS.customSkillsFolder)
        .setValue(this.plugin.settings.customSkillsFolder)
        .onChange(async value => {
          this.plugin.settings.customSkillsFolder = value.trim() || DEFAULT_SETTINGS.customSkillsFolder
          await this.plugin.persist()
          await this.plugin.reloadAnswerSkills(false)
        }))

    new Setting(containerEl)
      .setName('重新加载 Skills')
      .setDesc('修改自定义 skill JSON 后点击这里立即生效。')
      .addButton(button => button
        .setButtonText('重新加载')
        .onClick(async () => {
          await this.plugin.reloadAnswerSkills()
        }))

    new Setting(containerEl)
      .setName('联网搜索')
      .setDesc('开启后，概念解释和延伸讨论会先抽取关键词，再用 Tavily 搜索并把结果作为外部资料交给 AI。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.webSearchEnabled)
        .onChange(async value => {
          this.plugin.settings.webSearchEnabled = value
          await this.plugin.persist()
        }))

    new Setting(containerEl)
      .setName('搜索服务')
      .setDesc('默认使用 Tavily Search API；自定义接口保留给高级用法。')
      .addDropdown(dropdown => dropdown
        .addOption('tavily', 'Tavily')
        .addOption('custom', '自定义 URL 模板')
        .setValue(this.plugin.settings.webSearchProvider)
        .onChange(async value => {
          this.plugin.settings.webSearchProvider = value as WebSearchProvider
          await this.plugin.persist()
          this.display()
        }))

    new Setting(containerEl)
      .setName(this.plugin.settings.webSearchProvider === 'tavily' ? 'Tavily API Key' : '搜索 API Key')
      .setDesc(this.plugin.settings.webSearchProvider === 'tavily'
        ? '用于调用 Tavily Search API，只保存在本地 Obsidian 插件数据中。'
        : '可选。若填写，会以 Bearer Token 放入 Authorization header。')
      .addText(text => {
        text.inputEl.type = 'password'
        text
          .setValue(this.plugin.settings.webSearchApiKey)
          .onChange(async value => {
            this.plugin.settings.webSearchApiKey = value.trim()
            await this.plugin.persist()
          })
      })

    if (this.plugin.settings.webSearchProvider === 'custom') {
      new Setting(containerEl)
        .setName('搜索接口 URL 模板')
        .setDesc('例如 https://api.example.com/search?q={{query}}&count={{limit}}。接口应返回 results/items/data 数组。')
        .addText(text => text
          .setPlaceholder('https://api.example.com/search?q={{query}}')
          .setValue(this.plugin.settings.webSearchEndpointTemplate)
          .onChange(async value => {
            this.plugin.settings.webSearchEndpointTemplate = value.trim()
            await this.plugin.persist()
          }))
    }

    new Setting(containerEl)
      .setName('搜索结果数量')
      .setDesc('每次最多读取 1-10 条搜索结果。')
      .addSlider(slider => slider
        .setLimits(1, 10, 1)
        .setValue(clampSearchResultLimit(this.plugin.settings.webSearchResultLimit))
        .setDynamicTooltip()
        .onChange(async value => {
          this.plugin.settings.webSearchResultLimit = clampSearchResultLimit(value)
          await this.plugin.persist()
        }))
  }
}

class AnnotationView extends ItemView {
  private search = ''
  private activeId: string | null = null
  private expandedIds = new Set<string>()
  private quoteExpandedIds = new Set<string>()
  private editingId: string | null = null
  private editingAnswer = ''
  private pending: PendingQuestion | null = null
  private pendingQuestion = ''
  private pendingMode: AnnotationMode = 'ai'
  private pendingQuoteExpanded = false
  private renderedPath: string | null = null
  private submitting = false
  private clearOutsideInputListener: (() => void) | null = null

  constructor(leaf: WorkspaceLeaf, private readonly plugin: MarginAIPlugin) {
    super(leaf)
  }

  getViewType(): string {
    return VIEW_TYPE_ANNOTATIONS
  }

  getDisplayText(): string {
    return 'MarginAI 批注'
  }

  getIcon(): string {
    return 'margin-ai'
  }

  async onOpen(): Promise<void> {
    this.render()
  }

  async onClose(): Promise<void> {
    this.removeOutsideInputListener()
  }

  setActive(annotationId: string): void {
    this.activeId = annotationId
    this.updateActiveCard()
  }

  setPendingQuestion(pending: PendingQuestion, mode: AnnotationMode = 'ai'): void {
    this.pending = pending
    this.pendingMode = mode
    this.pendingQuestion = ''
    this.pendingQuoteExpanded = false
    this.editingId = null
    this.editingAnswer = ''
    this.render()
  }

  render(): void {
    this.removeOutsideInputListener()
    const container = this.containerEl.children[1]
    container.empty()
    container.addClass('margin-ai-view')

    const currentFile = this.plugin.currentMarkdownFile()
    const currentPath = currentFile?.path
    this.renderedPath = currentPath ?? null

    const toolbar = container.createDiv({ cls: 'margin-ai-toolbar' })
    const searchInput = toolbar.createEl('input', {
      type: 'search',
      placeholder: '搜索当前文件批注',
      cls: 'margin-ai-search'
    })
    searchInput.value = this.search
    searchInput.addEventListener('input', () => {
      this.search = searchInput.value
      this.render()
    })

    const list = container.createDiv({ cls: 'margin-ai-list' })
    if (!currentPath) {
      list.createEl('p', { text: '请先打开一个 Markdown 文件。', cls: 'setting-item-description' })
      return
    }

    if (this.pending && this.pending.file.path === currentPath) {
      const panel = list.createDiv({
        cls: [
          'margin-ai-input-panel',
          this.pendingMode === 'note' ? 'is-discussion' : 'is-concept'
        ].join(' ')
      })
      panel.addEventListener('click', event => event.stopPropagation())
      this.bindOutsideInputCancel(panel, () => {
        this.cancelPendingInput()
      })

      const inputHeader = panel.createDiv({ cls: 'margin-ai-input-header' })
      const title = inputHeader.createDiv({ cls: 'margin-ai-input-title' })
      const titleText = title.createSpan({
        text: this.pendingMode === 'note'
          ? '我的批注'
          : this.pendingQuestion.trim() || '新提问'
      })

      const inputBody = panel.createDiv({ cls: 'margin-ai-input-body' })
      this.renderQuote(inputBody, this.pending.quote, {
        expanded: this.pendingQuoteExpanded,
        onToggle: () => {
          this.pendingQuoteExpanded = !this.pendingQuoteExpanded
          this.render()
        }
      })
      if (this.submitting) {
        const loading = inputBody.createDiv({ cls: 'margin-ai-loading-state' })
        const loadingHeader = loading.createDiv({ cls: 'margin-ai-loading-header' })
        loadingHeader.createSpan({ cls: 'margin-ai-loading-spinner' })
        loadingHeader.createSpan({
          text: this.pendingMode === 'note' ? '正在保存批注' : '正在生成批注',
          cls: 'margin-ai-loading-title'
        })
        const skeleton = loading.createDiv({ cls: 'margin-ai-skeleton' })
        skeleton.createDiv({ cls: 'margin-ai-skeleton-line is-wide' })
        skeleton.createDiv({ cls: 'margin-ai-skeleton-line' })
        skeleton.createDiv({ cls: 'margin-ai-skeleton-line is-short' })
        inputBody.createDiv({
          text: this.pendingMode === 'note'
            ? '保存完成后会出现在当前文件批注列表中'
            : 'AI 正在阅读选中原文并组织回答',
          cls: 'margin-ai-input-hint'
        })
      } else {
        const textarea = inputBody.createEl('textarea', {
          placeholder: this.pendingMode === 'note'
            ? '输入你的批注'
            : '输入问题',
          cls: 'margin-ai-input-textarea'
        })
        textarea.value = this.pendingQuestion
        textarea.addEventListener('input', () => {
          this.pendingQuestion = textarea.value
          if (this.pendingMode !== 'note') titleText.setText(this.pendingQuestion.trim() || '新提问')
        })
        textarea.addEventListener('keydown', event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            this.submitPendingQuestion()
          }
        })
        inputBody.createDiv({
          text: '点击外部取消，Shift + Enter 换行，Enter 保存',
          cls: 'margin-ai-input-hint'
        })
        window.setTimeout(() => textarea.focus(), 0)
      }
    }

    const query = this.search.trim().toLowerCase()

    const annotations = this.plugin.annotations
      .filter(annotation => annotation.sourcePath === currentPath)
      .filter(annotation => {
        if (!query) return true
        return [
          annotation.quote,
          annotation.question,
          annotation.answer,
          annotation.sourcePath
        ].join('\n').toLowerCase().includes(query)
      })
      .sort((a, b) => a.anchorOffset - b.anchorOffset || a.createdAt - b.createdAt)

    if (annotations.length === 0) {
      list.createEl('p', { text: '当前文件暂无批注。选中文字后运行“MarginAI: 对选中文本提问”。', cls: 'setting-item-description' })
      return
    }

    annotations.forEach(annotation => {
      const intent = annotation.intent ?? this.plugin.detectIntent(annotation.question)
      const hasGeneratedNote = this.plugin.annotationNoteExists(annotation)
      const isEditing = annotation.id === this.editingId
      const isExpanded = this.expandedIds.has(annotation.id)
      const card = list.createDiv({
        cls: [
          'margin-ai-card',
          INTENT_CLASS_NAMES[intent],
          annotation.id === this.activeId ? 'is-active' : '',
          isExpanded ? 'is-expanded' : '',
          isEditing ? 'is-editing' : ''
        ].filter(Boolean).join(' ')
      })
      card.dataset.annotationId = annotation.id
      card.setAttribute('role', 'button')
      card.setAttribute('tabindex', '0')
      card.setAttribute('aria-label', '定位到原文')

      const topbar = card.createDiv({ cls: 'margin-ai-card-topbar' })
      topbar.createDiv({
        text: annotation.mode === 'note' ? '我的批注' : annotation.question,
        cls: 'margin-ai-card-question'
      })
      const menuButton = topbar.createEl('button', {
        cls: 'clickable-icon margin-ai-card-menu-button',
        attr: {
          type: 'button',
          'aria-label': '批注操作'
        }
      })
      setIcon(menuButton, 'more-vertical')
      menuButton.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()

        const menu = new Menu()
        menu.addItem(item => {
          item
            .setTitle(isEditing ? '取消编辑' : '编辑批注')
            .setIcon(isEditing ? 'x' : 'pencil')
            .onClick(() => {
              if (isEditing) {
                this.editingId = null
                this.editingAnswer = ''
              } else {
                this.pending = null
                this.pendingQuestion = ''
                this.pendingMode = 'ai'
                this.pendingQuoteExpanded = false
                this.editingId = annotation.id
                this.editingAnswer = annotation.answer
              }
              this.render()
            })
        })
        menu.addItem(item => {
          item
            .setTitle(hasGeneratedNote ? '打开笔记' : '保存为笔记')
            .setIcon(hasGeneratedNote ? 'file-text' : 'save')
            .onClick(async () => {
              await this.plugin.generateAnnotationNote(annotation)
            })
        })
        menu.addSeparator()
        menu.addItem(item => {
          item
            .setTitle('删除批注')
            .setIcon('trash')
            .onClick(async () => {
              await this.plugin.deleteAnnotation(annotation.id)
            })
        })
        menu.showAtMouseEvent(event)
      })
      this.renderQuote(card, annotation.quote, {
        expanded: this.quoteExpandedIds.has(annotation.id),
        onToggle: () => {
          if (this.quoteExpandedIds.has(annotation.id)) {
            this.quoteExpandedIds.delete(annotation.id)
          } else {
            this.quoteExpandedIds.add(annotation.id)
          }
          this.render()
        }
      })

      const locate = async () => {
        if (this.editingId === annotation.id) return
        this.activeId = annotation.id
        this.updateActiveCard()
        await this.plugin.openSource(annotation)
      }
      card.addEventListener('click', locate)
      card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          locate()
        }
      })
      if (isEditing) {
        const editPanel = card.createDiv({ cls: 'margin-ai-input-panel margin-ai-edit-panel' })
        editPanel.addEventListener('click', event => event.stopPropagation())
        editPanel.addEventListener('keydown', event => event.stopPropagation())
        this.bindOutsideInputCancel(editPanel, () => {
          this.editingId = null
          this.editingAnswer = ''
          this.render()
        })
        const inputHeader = editPanel.createDiv({ cls: 'margin-ai-input-header' })
        const title = inputHeader.createDiv({ cls: 'margin-ai-input-title' })
        const titleIcon = title.createSpan({ cls: 'margin-ai-input-title-icon' })
        setIcon(titleIcon, 'pencil')
        title.createSpan({ text: '编辑批注' })
        const hintIcon = inputHeader.createSpan({ cls: 'margin-ai-input-header-icon' })
        setIcon(hintIcon, 'more-vertical')

        const inputBody = editPanel.createDiv({ cls: 'margin-ai-input-body' })
        const editor = inputBody.createEl('textarea', { cls: 'margin-ai-input-textarea margin-ai-edit-input' })
        editor.value = this.editingAnswer
        this.autosizeTextarea(editor)
        editor.addEventListener('input', () => {
          this.editingAnswer = editor.value
          this.autosizeTextarea(editor)
        })
        editor.addEventListener('keydown', event => {
          event.stopPropagation()
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            this.saveEditingAnnotation(annotation.id)
          }
        })
        inputBody.createDiv({
          text: '点击外部取消，Shift + Enter 换行，Enter 保存',
          cls: 'margin-ai-input-hint'
        })
        window.setTimeout(() => editor.focus(), 0)
      } else {
        const bodyWrap = card.createDiv({ cls: 'margin-ai-card-body-wrap' })
        const body = bodyWrap.createDiv({ cls: 'margin-ai-card-body' })
        body.addEventListener('click', event => {
          if ((event.target as HTMLElement).closest('a')) event.stopPropagation()
        })
        const updateOverflow = () => {
          if (isExpanded) {
            expandButton.toggleClass('is-hidden', false)
            card.toggleClass('has-overflow', false)
            return
          }
          const isOverflowing = card.scrollHeight > card.clientHeight + 4
          expandButton.toggleClass('is-hidden', !isOverflowing)
          card.toggleClass('has-overflow', isOverflowing)
        }
        MarkdownRenderer.render(
          this.app,
          annotation.answer,
          body,
          annotation.sourcePath,
          this
        ).then(() => {
          window.requestAnimationFrame(updateOverflow)
        })
        const expandButton = card.createEl('button', {
          text: isExpanded ? '收起' : '展开全文',
          cls: `margin-ai-expand-button${isExpanded ? ' is-expanded' : ''}`,
          attr: {
            type: 'button',
            'aria-label': isExpanded ? '收起卡片' : '展开卡片',
            title: isExpanded ? '收起卡片' : '展开卡片'
          }
        })
        expandButton.addEventListener('click', event => {
          event.preventDefault()
          event.stopPropagation()
          if (isExpanded) {
            this.expandedIds.delete(annotation.id)
          } else {
            this.expandedIds.add(annotation.id)
          }
          this.render()
        })
        window.setTimeout(updateOverflow, 80)
      }
    })
  }

  handleFileOpen(file: TFile | null): void {
    const nextPath = file?.extension === 'md' ? file.path : null
    if (nextPath !== this.renderedPath) this.render()
  }

  private updateActiveCard(): void {
    this.containerEl.querySelectorAll<HTMLElement>('.margin-ai-card').forEach(card => {
      card.classList.toggle('is-active', card.dataset.annotationId === this.activeId)
    })
  }

  private autosizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }

  private bindOutsideInputCancel(panel: HTMLElement, onCancel: () => void): void {
    this.removeOutsideInputListener()

    const ownerDocument = panel.ownerDocument
    const listener = (event: PointerEvent) => {
      if (this.submitting) return
      const target = event.target
      if (target instanceof Node && panel.contains(target)) return
      onCancel()
    }
    ownerDocument.addEventListener('pointerdown', listener, true)
    this.clearOutsideInputListener = () => ownerDocument.removeEventListener('pointerdown', listener, true)
  }

  private removeOutsideInputListener(): void {
    this.clearOutsideInputListener?.()
    this.clearOutsideInputListener = null
  }

  private cancelPendingInput(): void {
    this.pending = null
    this.pendingQuestion = ''
    this.pendingMode = 'ai'
    this.pendingQuoteExpanded = false
    this.render()
  }

  private async saveEditingAnnotation(annotationId: string): Promise<void> {
    await this.plugin.updateAnnotationAnswer(annotationId, this.editingAnswer)
    this.editingId = null
    this.editingAnswer = ''
    this.render()
  }

  private async submitPendingQuestion(): Promise<void> {
    if (!this.pending || this.submitting) return

    const text = this.pendingQuestion.trim()
    if (!text) {
      new Notice(this.pendingMode === 'note' ? '请输入批注' : '请输入问题')
      return
    }

    this.submitting = true
    this.render()

    const saved = this.pendingMode === 'note'
      ? await this.plugin.createManualAnnotation({
        file: this.pending.file,
        quote: this.pending.quote,
        note: text,
        anchorOffset: this.pending.anchorOffset
      })
      : await this.plugin.createAnnotation({
        file: this.pending.file,
        quote: this.pending.quote,
        question: text,
        anchorOffset: this.pending.anchorOffset
      })

    this.submitting = false
      if (saved) {
        this.pending = null
        this.pendingQuestion = ''
        this.pendingMode = 'ai'
        this.pendingQuoteExpanded = false
      }
      this.render()
  }

  private renderQuote(
    container: HTMLElement,
    quote: string,
    options: { expanded: boolean; onToggle: () => void }
  ): void {
    const quoteWrap = container.createDiv({
      cls: `margin-ai-card-quote-wrap${options.expanded ? ' is-expanded' : ''}`
    })
    const quoteEl = quoteWrap.createDiv({ text: quote, cls: 'margin-ai-card-quote' })
    const expandButton = quoteWrap.createEl('button', {
      cls: `margin-ai-quote-expand-button${options.expanded ? ' is-expanded' : ''}`,
      attr: {
        type: 'button',
        'aria-label': options.expanded ? '收起引用' : '展开引用',
        title: options.expanded ? '收起引用' : '展开引用'
      }
    })
    setIcon(expandButton, options.expanded ? 'chevron-up' : 'chevron-down')
    expandButton.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      options.onToggle()
    })

    const updateOverflow = () => {
      const isOverflowing = quoteEl.scrollHeight > 98
      expandButton.toggleClass('is-hidden', !isOverflowing)
      quoteWrap.toggleClass('has-overflow', isOverflowing)
    }
    window.requestAnimationFrame(updateOverflow)
    window.setTimeout(updateOverflow, 80)
  }
}

export default class MarginAIPlugin extends Plugin {
  settings: MarginAISettings = { ...DEFAULT_SETTINGS }
  annotations: MarginAIAnnotation[] = []
  answerSkills: AnswerSkill[] = [FALLBACK_SKILL]
  private view: AnnotationView | null = null
  private syncingNotePaths = new Set<string>()

  async onload(): Promise<void> {
    await this.loadPluginData()
    await this.loadAnswerSkills()
    addIcon('margin-ai', MARGIN_AI_ICON)

    this.registerView(VIEW_TYPE_ANNOTATIONS, leaf => {
      this.view = new AnnotationView(leaf, this)
      return this.view
    })

    this.addRibbonIcon('margin-ai', 'MarginAI 批注', () => {
      this.activateView()
    })

    this.addCommand({
      id: 'ask-about-selection',
      name: '对选中文本提问',
      editorCallback: (editor, view) => {
        if (!(view instanceof MarkdownView)) {
          new Notice('请在 Markdown 文件中使用 MarginAI')
          return
        }
        this.askAboutSelection(editor, view)
      }
    })

    this.addCommand({
      id: 'add-note-annotation',
      name: '增加批注',
      editorCallback: (editor, view) => {
        if (!(view instanceof MarkdownView)) {
          new Notice('请在 Markdown 文件中使用 MarginAI')
          return
        }
        this.addNoteAnnotation(editor, view)
      }
    })

    this.addCommand({
      id: 'open-annotations-view',
      name: '打开批注侧边栏',
      callback: () => this.activateView()
    })

    this.registerMarkdownPostProcessor((el, ctx) => {
      this.markRenderedAnnotations(el, ctx.sourcePath)
    })

    this.registerEvent(this.app.workspace.on('file-open', file => {
      this.view?.handleFileOpen(file)
    }))

    this.registerEvent(this.app.vault.on('delete', file => {
      if (file instanceof TFile) this.handleVaultFileDelete(file)
    }))

    this.registerEvent(this.app.vault.on('modify', file => {
      if (file instanceof TFile) this.handleVaultFileModify(file)
    }))

    this.addSettingTab(new MarginAISettingTab(this.app, this))

    this.app.workspace.onLayoutReady(() => {
      this.activateView()
    })
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ANNOTATIONS)
  }

  async persist(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      annotations: this.annotations
    } satisfies MarginAIData)
  }

  currentMarkdownFile(): TFile | null {
    const file = this.app.workspace.getActiveFile()
    return file?.extension === 'md' ? file : null
  }

  annotationNoteExists(annotation: MarginAIAnnotation): boolean {
    const path = annotation.generatedNotePath ?? annotation.sidecarPath
    return !!path && this.app.vault.getAbstractFileByPath(path) instanceof TFile
  }

  async openPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) {
      new Notice(`找不到文件：${path}`)
      return
    }
    const leaf = this.app.workspace.getLeaf('tab')
    await leaf.openFile(file)
  }

  async openSource(annotation: MarginAIAnnotation): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(annotation.sourcePath)
    if (!(file instanceof TFile)) {
      new Notice(`找不到原文：${annotation.sourcePath}`)
      return
    }
    const leaf = this.app.workspace.getLeaf('tab')
    await leaf.openFile(file)

    const view = leaf.view instanceof MarkdownView
      ? leaf.view
      : this.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor
    if (!editor) return

    const content = editor.getValue()
    const index = this.findQuote(content, annotation.quote, annotation.anchorOffset)
    if (index < 0) return

    const from = editor.offsetToPos(index)
    const to = editor.offsetToPos(index + annotation.quote.length)
    editor.setSelection(from, to)
    editor.scrollIntoView({ from, to }, true)
  }

  private async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as Partial<MarginAIData> | null
    this.settings = { ...DEFAULT_SETTINGS, ...data?.settings }
    this.annotations = data?.annotations ?? []
  }

  async reloadAnswerSkills(showNotice = true): Promise<void> {
    await this.loadAnswerSkills()
    if (showNotice) new Notice(`MarginAI 已加载 ${this.answerSkills.length} 个回答 skill`)
  }

  getAnswerSkill(question: string): AnswerSkill {
    const normalized = question.trim()
    for (const skill of this.answerSkills) {
      if (skill.match.some(pattern => new RegExp(escapeRegExp(pattern), 'i').test(normalized))) {
        return skill
      }
    }
    return this.answerSkills.find(skill => skill.intent === 'discussion') ?? this.answerSkills[0] ?? FALLBACK_SKILL
  }

  detectIntent(question: string): AnnotationIntent {
    return this.getAnswerSkill(question).intent
  }

  private async loadAnswerSkills(): Promise<void> {
    const loaded = new Map<AnnotationIntent, AnswerSkill>()
    for (const skill of await this.loadBuiltInSkills()) {
      loaded.set(skill.intent, skill)
    }
    for (const skill of await this.loadCustomSkills()) {
      loaded.set(skill.intent, skill)
    }
    if (loaded.size === 0) loaded.set(FALLBACK_SKILL.intent, FALLBACK_SKILL)
    this.answerSkills = Array.from(loaded.values())
  }

  private async loadBuiltInSkills(): Promise<AnswerSkill[]> {
    const skills: AnswerSkill[] = []
    for (const fileName of BUILTIN_SKILL_FILES) {
      const path = `${this.manifest.dir}/skills/${fileName}`
      try {
        const json = await this.app.vault.adapter.read(path)
        skills.push(parseAnswerSkill(JSON.parse(json), path))
      } catch (error) {
        console.warn(`MarginAI failed to load built-in skill ${path}`, error)
      }
    }
    return skills
  }

  private async loadCustomSkills(): Promise<AnswerSkill[]> {
    const folderPath = normalizePath(this.settings.customSkillsFolder).trim()
    if (!folderPath) return []

    const folder = this.app.vault.getAbstractFileByPath(folderPath)
    if (!(folder instanceof TFolder)) return []

    const skills: AnswerSkill[] = []
    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== 'json') continue
      try {
        const json = await this.app.vault.read(child)
        skills.push(parseAnswerSkill(JSON.parse(json), child.path))
      } catch (error) {
        console.warn(`MarginAI failed to load custom skill ${child.path}`, error)
      }
    }
    return skills
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS)[0] ?? null

    if (!leaf) {
      leaf = workspace.getRightLeaf(false)
      if (!leaf) return
      await leaf.setViewState({ type: VIEW_TYPE_ANNOTATIONS, active: true })
    }

    if (leaf) workspace.revealLeaf(leaf)
    this.view?.render()
  }

  private askAboutSelection(editor: Editor, view: MarkdownView): void {
    const file = view.file
    const quote = editor.getSelection().trim()
    if (!file || !quote) {
      new Notice('请先在 Markdown 文件中选中文字')
      return
    }

    const from = editor.getCursor('from')
    const anchorOffset = editor.posToOffset(from)
    this.activateView().then(() => {
      this.view?.setPendingQuestion({ file, quote, anchorOffset })
    })
  }

  private addNoteAnnotation(editor: Editor, view: MarkdownView): void {
    const file = view.file
    const quote = editor.getSelection().trim()
    if (!file || !quote) {
      new Notice('请先在 Markdown 文件中选中文字')
      return
    }

    const from = editor.getCursor('from')
    const anchorOffset = editor.posToOffset(from)
    this.activateView().then(() => {
      this.view?.setPendingQuestion({ file, quote, anchorOffset }, 'note')
    })
  }

  async createAnnotation(input: {
    file: TFile
    quote: string
    question: string
    anchorOffset: number
  }): Promise<boolean> {
    if (!this.settings.apiKey) {
      new Notice('请先在 MarginAI 设置中配置 API Key')
      return false
    }

    const notice = new Notice('MarginAI 正在生成批注...', 0)

    try {
      const documentContent = await this.app.vault.read(input.file)
      const surroundingContext = extractSurroundingContext(documentContent, input.quote)
      const skill = this.getAnswerSkill(input.question)
      const intent = skill.intent
      const webSearchContext = await this.buildWebSearchContext(
        input.quote,
        input.question,
        surroundingContext,
        skill
      )
      const messages = buildNewAnnotationMessages(
        input.quote,
        input.question,
        skill,
        surroundingContext,
        webSearchContext
      )
      const answer = normalizeAiAnswer(await this.askAi(messages))

      const annotation: MarginAIAnnotation = {
        id: crypto.randomUUID(),
        sourcePath: input.file.path,
        quote: input.quote,
        anchorOffset: input.anchorOffset,
        question: input.question,
        answer,
        createdAt: Date.now(),
        mode: 'ai',
        intent
      }

      this.annotations.push(annotation)
      await this.persist()
      await this.activateView()
      new Notice('批注已保存')
      return true
    } catch (error) {
      console.error(error)
      new Notice(`批注失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      notice.hide()
    }
  }

  async createManualAnnotation(input: {
    file: TFile
    quote: string
    note: string
    anchorOffset: number
  }): Promise<boolean> {
    const annotation: MarginAIAnnotation = {
      id: crypto.randomUUID(),
      sourcePath: input.file.path,
      quote: input.quote,
      anchorOffset: input.anchorOffset,
      question: '我的批注',
      answer: input.note,
      createdAt: Date.now(),
      mode: 'note',
      intent: 'discussion'
    }

    this.annotations.push(annotation)
    await this.persist()
    await this.activateView()
    new Notice('批注已保存')
    return true
  }

  async updateAnnotationAnswer(annotationId: string, answer: string): Promise<void> {
    const annotation = this.annotations.find(candidate => candidate.id === annotationId)
    if (!annotation) return

    annotation.answer = compactMarkdownSpacing(answer)
    await this.persist()
    await this.syncAnnotationNote(annotation)
    await this.activateView()
    new Notice('批注已更新')
  }

  async generateAnnotationNote(annotation: MarginAIAnnotation): Promise<void> {
    const sourceFile = this.app.vault.getAbstractFileByPath(annotation.sourcePath)
    if (!(sourceFile instanceof TFile)) {
      new Notice(`找不到原文：${annotation.sourcePath}`)
      return
    }

    const existingPath = annotation.generatedNotePath ?? annotation.sidecarPath
    if (existingPath && this.app.vault.getAbstractFileByPath(existingPath) instanceof TFile) {
      await this.openPath(existingPath)
      return
    }
    if (existingPath) {
      annotation.generatedNotePath = undefined
      annotation.sidecarPath = undefined
      await this.persist()
    }

    let sourceContent = await this.app.vault.read(sourceFile)
    annotation.sourceBlockId = await this.ensureSourceBlockId(
      sourceFile,
      sourceContent,
      annotation.anchorOffset
    )
    sourceContent = await this.app.vault.read(sourceFile)
    const notePath = await this.annotationNotePathFor(sourceFile, annotation)
    await this.app.vault.create(notePath, annotationNoteContent(annotation, sourceFile, question => this.detectIntent(question)))
    await this.linkSourceSelectionToNote(sourceFile, sourceContent, annotation, notePath)
    annotation.generatedNotePath = notePath
    await this.persist()
    await this.activateView()
    await this.openPath(notePath)
    new Notice('批注笔记已生成')
  }

  async deleteAnnotation(annotationId: string): Promise<void> {
    const before = this.annotations.length
    this.annotations = this.annotations.filter(annotation => annotation.id !== annotationId)
    if (this.annotations.length === before) return

    await this.persist()
    await this.activateView()
    this.clearRenderedAnnotationMarks(annotationId)
    new Notice('批注已删除')
  }

  private async handleVaultFileDelete(file: TFile): Promise<void> {
    let changed = false
    this.annotations.forEach(annotation => {
      if (annotation.generatedNotePath === file.path) {
        annotation.generatedNotePath = undefined
        changed = true
      }
      if (annotation.sidecarPath === file.path) {
        annotation.sidecarPath = undefined
        changed = true
      }
    })

    if (!changed) return
    await this.persist()
    await this.activateView()
  }

  private async handleVaultFileModify(file: TFile): Promise<void> {
    if (this.syncingNotePaths.has(file.path)) return

    const annotation = this.annotations.find(candidate =>
      candidate.generatedNotePath === file.path || candidate.sidecarPath === file.path
    )
    if (!annotation) return

    const content = await this.app.vault.read(file)
    const answer = annotationAnswerFromNote(content)
    if (!answer || answer === annotation.answer) return

    annotation.answer = answer
    await this.persist()
    await this.activateView()
  }

  private async syncAnnotationNote(annotation: MarginAIAnnotation): Promise<void> {
    const notePath = annotation.generatedNotePath ?? annotation.sidecarPath
    if (!notePath) return

    const noteFile = this.app.vault.getAbstractFileByPath(notePath)
    const sourceFile = this.app.vault.getAbstractFileByPath(annotation.sourcePath)
    if (!(noteFile instanceof TFile) || !(sourceFile instanceof TFile)) return

    this.syncingNotePaths.add(notePath)
    try {
      await this.app.vault.modify(noteFile, annotationNoteContent(annotation, sourceFile, question => this.detectIntent(question)))
    } finally {
      this.syncingNotePaths.delete(notePath)
    }
  }

  private async askAi(messages: ChatMessage[]): Promise<string> {
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.settings.model,
        messages,
        stream: false
      }),
      throw: false
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`AI API 返回 ${response.status}: ${response.text.slice(0, 180)}`)
    }

    const json = response.json as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content
    if (!content) throw new Error('AI API 没有返回内容')
    return content
  }

  private async buildWebSearchContext(
    quote: string,
    question: string,
    surroundingContext: string | undefined,
    skill: AnswerSkill
  ): Promise<string | undefined> {
    if (!this.settings.webSearchEnabled) return undefined
    if (!shouldUseWebSearch(skill, question)) return undefined
    if (!this.settings.webSearchApiKey.trim()) {
      new Notice(`已开启联网搜索，但还没有配置 ${this.settings.webSearchProvider === 'tavily' ? 'Tavily ' : ''}API Key`)
      return undefined
    }
    if (this.settings.webSearchProvider === 'custom' && !this.settings.webSearchEndpointTemplate.trim()) return undefined

    try {
      const query = cleanSearchQuery(await this.askAi(buildSearchQueryPrompt(quote, question, surroundingContext)))
      if (!query) return undefined

      const results = await this.searchWeb(query)
      return formatWebSearchContext(query, results)
    } catch (error) {
      console.error('MarginAI web search failed', error)
      new Notice(`联网搜索失败，已改用模型直接回答：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async searchWeb(query: string): Promise<WebSearchResult[]> {
    if (this.settings.webSearchProvider === 'custom') {
      return this.searchCustomWeb(query)
    }
    return this.searchTavily(query)
  }

  private async searchTavily(query: string): Promise<WebSearchResult[]> {
    const limit = clampSearchResultLimit(this.settings.webSearchResultLimit)
    const response = await requestUrl({
      url: 'https://api.tavily.com/search',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.webSearchApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: limit,
        include_answer: false,
        include_raw_content: false
      }),
      throw: false
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Tavily 返回 ${response.status}: ${response.text.slice(0, 180)}`)
    }

    return normalizeSearchResults(response.json).slice(0, limit)
  }

  private async searchCustomWeb(query: string): Promise<WebSearchResult[]> {
    const limit = clampSearchResultLimit(this.settings.webSearchResultLimit)
    const template = this.settings.webSearchEndpointTemplate.trim()
    const queryValue = encodeURIComponent(query)
    const limitValue = String(limit)
    const url = template.includes('{{query}}')
      ? template
          .replace(/{{\s*query\s*}}/gi, queryValue)
          .replace(/{{\s*limit\s*}}/gi, limitValue)
      : `${template}${template.includes('?') ? '&' : '?'}q=${queryValue}&count=${limitValue}`

    const headers: Record<string, string> = {}
    if (this.settings.webSearchApiKey) {
      headers.Authorization = `Bearer ${this.settings.webSearchApiKey}`
    }

    const response = await requestUrl({
      url,
      method: 'GET',
      headers,
      throw: false
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`搜索接口返回 ${response.status}: ${response.text.slice(0, 180)}`)
    }

    return normalizeSearchResults(response.json).slice(0, limit)
  }

  private async annotationNotePathFor(sourceFile: TFile, annotation: MarginAIAnnotation): Promise<string> {
    await this.ensureFolder(this.settings.annotationsFolder)
    const sourceStem = sourceFile.path.replace(/\.md$/i, '').replace(/\//g, ' - ')
    const title = titleFromAnnotation(annotation, question => this.detectIntent(question))
    const basePath = normalizePath(`${this.settings.annotationsFolder}/${sanitizeFileName(title || sourceStem)}.md`)
    let path = basePath
    let index = 2
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = basePath.replace(/\.md$/i, ` ${index}.md`)
      index += 1
    }
    return path
  }

  private async linkSourceSelectionToNote(
    sourceFile: TFile,
    content: string,
    annotation: MarginAIAnnotation,
    notePath: string
  ): Promise<void> {
    const index = this.findQuote(content, annotation.quote, annotation.anchorOffset)
    if (index < 0) return

    const existingSelection = content.slice(index, index + annotation.quote.length)
    if (/\[\[.*?\]\]/.test(existingSelection)) return

    const noteTarget = fileWikiTarget(notePath)
    const alias = preserveWikiAlias(existingSelection)
    const replacement = existingSelection.includes('\n')
      ? `${existingSelection} [[${noteTarget}|批注笔记]]`
      : `[[${noteTarget}|${alias}]]`

    const nextContent = `${content.slice(0, index)}${replacement}${content.slice(index + annotation.quote.length)}`
    await this.app.vault.modify(sourceFile, nextContent)
  }

  private async ensureSourceBlockId(sourceFile: TFile, content: string, offset: number): Promise<string> {
    const block = this.findContainingTextBlock(content, offset)
    const existing = content.slice(block.start, block.end).match(/\s\^([A-Za-z0-9-]+)\s*$/)
    if (existing?.[1]) return existing[1]

    const blockId = `margin-ai-${crypto.randomUUID().slice(0, 8)}`
    const insertAt = this.trailingWhitespaceStart(content, block.end)
    const nextContent = `${content.slice(0, insertAt)} ^${blockId}${content.slice(insertAt)}`
    await this.app.vault.modify(sourceFile, nextContent)
    return blockId
  }

  private findContainingTextBlock(content: string, offset: number): { start: number; end: number } {
    const safeOffset = Math.max(0, Math.min(offset, content.length))
    let start = content.lastIndexOf('\n\n', safeOffset)
    start = start < 0 ? 0 : start + 2

    let end = content.indexOf('\n\n', safeOffset)
    end = end < 0 ? content.length : end

    return { start, end }
  }

  private trailingWhitespaceStart(content: string, end: number): number {
    let insertAt = end
    while (insertAt > 0 && /[ \t]/.test(content.charAt(insertAt - 1))) {
      insertAt -= 1
    }
    return insertAt
  }

  private clearRenderedAnnotationMarks(annotationId: string): void {
    document.querySelectorAll<HTMLElement>('.margin-ai-source-mark').forEach(mark => {
      if (mark.dataset.annotationId !== annotationId) return
      mark.replaceWith(...Array.from(mark.childNodes))
    })
  }

  private async ensureFolder(folder: string): Promise<void> {
    const normalized = normalizePath(folder)
    const parts = normalized.split('/').filter(Boolean)
    let current = ''

    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current)
      }
    }
  }

  private findQuote(content: string, quote: string, offset: number): number {
    const near = content.indexOf(quote, Math.max(0, offset - 32))
    if (near >= 0) return near
    return content.indexOf(quote)
  }

  private markRenderedAnnotations(el: HTMLElement, sourcePath: string): void {
    if (el.closest('.margin-ai-view')) return

    const annotations = this.annotations.filter(annotation => annotation.sourcePath === sourcePath)
    if (annotations.length === 0) return

    annotations.forEach(annotation => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode() as Text | null

      while (node) {
        const index = node.data.indexOf(annotation.quote)
        if (index >= 0 && node.parentElement && !node.parentElement.closest('.margin-ai-source-mark')) {
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + annotation.quote.length)

          const mark = document.createElement('mark')
          mark.className = 'margin-ai-source-mark'
          mark.dataset.annotationId = annotation.id
          mark.appendChild(range.extractContents())
          range.insertNode(mark)
          mark.addEventListener('click', async () => {
            await this.activateView()
            this.view?.setActive(annotation.id)
          })
          break
        }

        node = walker.nextNode() as Text | null
      }
    })
  }
}
