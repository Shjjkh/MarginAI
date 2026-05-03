import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  addIcon,
  normalizePath,
  requestUrl
} from 'obsidian'

const VIEW_TYPE_ANNOTATIONS = 'margin-ai-annotations'
const MARGIN_AI_ICON = `<path d="M6 3.5h8l4 4v13H6z"/>
<path d="M14 3.5v4h4"/>
<path d="M9 10h4"/>
<path d="M9 13h3"/>
<path d="M16.5 11.5c.35 1.3 1.2 2.15 2.5 2.5-1.3.35-2.15 1.2-2.5 2.5-.35-1.3-1.2-2.15-2.5-2.5 1.3-.35 2.15-1.2 2.5-2.5z"/>
<path d="M20 18h-4"/>`

type ChatRole = 'system' | 'user' | 'assistant'
type AnnotationIntent =
  | 'concept'
  | 'confusion'
  | 'discussion'
  | 'summary'
  | 'translation'
  | 'writing'

interface ChatMessage {
  role: ChatRole
  content: string
}

interface MarginAISettings {
  annotationsFolder: string
  apiBaseUrl: string
  apiKey: string
  model: string
}

interface MarginAIAnnotation {
  id: string
  sourcePath: string
  sidecarPath: string
  quote: string
  anchorOffset: number
  question: string
  answer: string
  createdAt: number
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

const DEFAULT_SETTINGS: MarginAISettings = {
  annotationsFolder: 'MarginAI/Annotations',
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini'
}

const OUTPUT_RULES = `输出会直接保存到用户选中文本旁边的批注里。

通用输出规则：
- 只输出批注正文，不要输出任务说明、标签或元信息。
- 回复语言跟随用户问题。
- 不要寒暄，不要说“好的/当然/总结一下/希望有帮助”。
- 不要复述用户问题，不要复述“已选原文/用户问题”等标签。
- 不要输出 JSON、XML、HTML、代码围栏或表格。
- 使用简单 Markdown：短段落，或一级项目符号“- 要点”。
- 如果需要给出判断，第一句先给结论。`

const WRAPPED_MARKDOWN_RE = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i
const LEADING_LABEL_RE = /^(?:answer|assistant|回复|回答|答案)\s*[:：]\s*/i
const ECHOED_LABEL_RE = /^(?:已选原文|用户问题|passage|question)\s*[:：].*$/i
const INTENT_CLASS_NAMES: Record<AnnotationIntent, string> = {
  concept: 'is-concept',
  confusion: 'is-confusion',
  discussion: 'is-discussion',
  summary: 'is-summary',
  translation: 'is-translation',
  writing: 'is-writing'
}

const INTENT_PATTERNS: Array<[AnnotationIntent, RegExp]> = [
  ['translation', /(翻译|译成|译为|translate|translation|英文|英语|中文|日文|日语|韩文|韩语)/i],
  ['summary', /(总结|概括|归纳|提炼|摘要|要点|summary|summarize|tl;?dr|main points?)/i],
  ['writing', /(改写|润色|优化表达|换个说法|更通俗|更学术|整理成|rewrite|polish|paraphrase)/i],
  ['concept', /(是什么|什么意思|含义|概念|定义|区别|关系|解释一下|什么是|meaning|concept|define|definition|explain)/i],
  ['confusion', /(为什么|为何|怎么理解|如何理解|没懂|不懂|看不懂|疑惑|逻辑|推理|依据|why|confus|understand)/i],
  ['discussion', /(怎么看|是否成立|合理吗|评价|深入|展开|讨论|启发|延伸|think|discuss|evaluate|analysis|analyze)/i]
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

  normalized = normalized.replace(LEADING_LABEL_RE, '').trim()
  return normalized || answer.trim()
}

function detectIntent(question: string): AnnotationIntent {
  const normalized = question.trim()
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(normalized)) return intent
  }
  return 'discussion'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

function buildNewAnnotationMessages(quote: string, question: string, surroundingContext?: string): ChatMessage[] {
  const contextBlock = surroundingContext?.trim()
    ? `\n可参考的原文上下文：\n"""\n${surroundingContext.trim()}\n"""\n`
    : ''

  return [
    { role: 'system', content: OUTPUT_RULES },
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

function sourceWikiLink(file: TFile): string {
  return `[[${file.path.replace(/\.md$/i, '')}|${file.basename}]]`
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Untitled'
}

function annotationBlock(annotation: MarginAIAnnotation, sourceFile: TFile): string {
  return [
    `标识：${annotation.id}`,
    `来源：${sourceWikiLink(sourceFile)}`,
    '',
    `> ${annotation.quote.replace(/\n/g, '\n> ')}`,
    '',
    `问：${annotation.question}`,
    '',
    '答：',
    annotation.answer
  ].filter(Boolean).join('\n')
}

function sidecarHeader(sourceFile: TFile): string {
  return [
    `来源：${sourceWikiLink(sourceFile)}`,
    '类型：MarginAI 批注',
    '',
    '说明：此文件由 MarginAI 插件维护，可直接阅读和搜索；不要使用标题或表格。',
    ''
  ].join('\n')
}

class MarginAISettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MarginAIPlugin) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl)
      .setName('批注文件夹')
      .setDesc('批注 sidecar Markdown 文件保存位置。')
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
  }
}

class AnnotationView extends ItemView {
  private search = ''
  private activeId: string | null = null
  private pending: PendingQuestion | null = null
  private pendingQuestion = ''
  private submitting = false

  constructor(leaf: WorkspaceLeaf, private readonly plugin: MarginAIPlugin) {
    super(leaf)
  }

  getViewType(): string {
    return VIEW_TYPE_ANNOTATIONS
  }

  getDisplayText(): string {
    return 'MarginAI 批注'
  }

  async onOpen(): Promise<void> {
    this.render()
  }

  setActive(annotationId: string): void {
    this.activeId = annotationId
    this.render()
  }

  setPendingQuestion(pending: PendingQuestion): void {
    this.pending = pending
    this.pendingQuestion = ''
    this.render()
  }

  render(): void {
    const container = this.containerEl.children[1]
    container.empty()
    container.addClass('margin-ai-view')

    const currentFile = this.plugin.currentMarkdownFile()
    const currentPath = currentFile?.path
    container.createEl('div', {
      text: currentFile ? `当前文件：${currentFile.basename}` : '当前文件：未打开 Markdown',
      cls: 'setting-item-description'
    })

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
      const panel = list.createDiv({ cls: 'margin-ai-question-panel' })
      panel.createDiv({ text: this.pending.quote, cls: 'margin-ai-card-quote' })
      const textarea = panel.createEl('textarea', {
        placeholder: '输入问题，Enter 提问，Shift+Enter 换行',
        cls: 'margin-ai-question-input'
      })
      textarea.value = this.pendingQuestion
      textarea.disabled = this.submitting
      textarea.addEventListener('input', () => {
        this.pendingQuestion = textarea.value
      })
      textarea.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          this.submitPendingQuestion()
        }
      })

      const actions = panel.createDiv({ cls: 'margin-ai-card-actions' })
      actions.createEl('button', { text: '取消' }).addEventListener('click', () => {
        this.pending = null
        this.pendingQuestion = ''
        this.render()
      })
      const submitButton = actions.createEl('button', { text: this.submitting ? '提问中...' : '提问' })
      submitButton.disabled = this.submitting
      submitButton.addEventListener('click', () => {
        this.submitPendingQuestion()
      })

      window.setTimeout(() => textarea.focus(), 0)
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
      .sort((a, b) => b.createdAt - a.createdAt)

    if (annotations.length === 0) {
      list.createEl('p', { text: '当前文件暂无批注。选中文字后运行“MarginAI: 对选中文本提问”。', cls: 'setting-item-description' })
      return
    }

    annotations.forEach(annotation => {
      const intent = annotation.intent ?? detectIntent(annotation.question)
      const card = list.createDiv({
        cls: `margin-ai-card ${INTENT_CLASS_NAMES[intent]}${annotation.id === this.activeId ? ' is-active' : ''}`
      })
      card.setAttribute('role', 'button')
      card.setAttribute('tabindex', '0')
      card.setAttribute('aria-label', '定位到原文')
      const locate = async () => {
        this.activeId = annotation.id
        await this.plugin.openSource(annotation)
        this.render()
      }
      card.addEventListener('click', locate)
      card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          locate()
        }
      })
      card.createDiv({ text: annotation.quote, cls: 'margin-ai-card-quote' })
      card.createDiv({ text: annotation.question, cls: 'margin-ai-card-question' })
      card.createDiv({ text: annotation.answer, cls: 'margin-ai-card-body' })

      const actions = card.createDiv({ cls: 'margin-ai-card-actions' })
      actions.addEventListener('click', event => event.stopPropagation())
      actions.createEl('button', { text: '定位原文' }).addEventListener('click', async event => {
        event.stopPropagation()
        await locate()
      })
      actions.createEl('button', { text: '打开批注文件' }).addEventListener('click', async event => {
        event.stopPropagation()
        await this.plugin.openPath(annotation.sidecarPath)
      })
    })
  }

  private async submitPendingQuestion(): Promise<void> {
    if (!this.pending || this.submitting) return

    const question = this.pendingQuestion.trim()
    if (!question) {
      new Notice('请输入问题')
      return
    }

    this.submitting = true
    this.render()

    const saved = await this.plugin.createAnnotation({
      file: this.pending.file,
      quote: this.pending.quote,
      question,
      anchorOffset: this.pending.anchorOffset
    })

    this.submitting = false
    if (saved) {
      this.pending = null
      this.pendingQuestion = ''
    }
    this.render()
  }
}

export default class MarginAIPlugin extends Plugin {
  settings: MarginAISettings = { ...DEFAULT_SETTINGS }
  annotations: MarginAIAnnotation[] = []
  private view: AnnotationView | null = null

  async onload(): Promise<void> {
    await this.loadPluginData()
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
      id: 'open-annotations-view',
      name: '打开批注侧边栏',
      callback: () => this.activateView()
    })

    this.registerMarkdownPostProcessor((el, ctx) => {
      this.markRenderedAnnotations(el, ctx.sourcePath)
    })

    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.view?.render()
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
      const messages = buildNewAnnotationMessages(
        input.quote,
        input.question,
        extractSurroundingContext(documentContent, input.quote)
      )
      const answer = normalizeAiAnswer(await this.askAi(messages))
      const sidecarPath = await this.sidecarPathFor(input.file)

      const annotation: MarginAIAnnotation = {
        id: crypto.randomUUID(),
        sourcePath: input.file.path,
        sidecarPath,
        quote: input.quote,
        anchorOffset: input.anchorOffset,
        question: input.question,
        answer,
        createdAt: Date.now(),
        intent: detectIntent(input.question)
      }

      this.annotations.push(annotation)
      await this.appendToSidecar(input.file, annotation)
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

  private async sidecarPathFor(sourceFile: TFile): Promise<string> {
    await this.ensureFolder(this.settings.annotationsFolder)
    const sourceStem = sourceFile.path.replace(/\.md$/i, '').replace(/\//g, ' - ')
    return normalizePath(`${this.settings.annotationsFolder}/${sanitizeFileName(sourceStem)}.annotations.md`)
  }

  private async appendToSidecar(sourceFile: TFile, annotation: MarginAIAnnotation): Promise<void> {
    const block = annotationBlock(annotation, sourceFile)
    const file = this.app.vault.getAbstractFileByPath(annotation.sidecarPath)

    if (file instanceof TFile) {
      await this.app.vault.append(file, `\n---\n\n${block}\n`)
      return
    }

    await this.app.vault.create(annotation.sidecarPath, `${sidecarHeader(sourceFile)}${block}\n`)
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
