# MarginAI Obsidian Plugin

MarginAI is an Obsidian plugin for AI-assisted reading annotations. This folder contains the buildable plugin package.

中文说明见下方。

## English

### Workflow

1. Open a Markdown note in Obsidian.
2. Select a passage.
3. Run `MarginAI: 对选中文本提问` to ask AI, or `MarginAI: 增加批注` to write a personal annotation.
4. Edit the question or note in the MarginAI sidebar.
5. Submit with `Enter`; insert a new line with `Shift+Enter`.
6. Review annotation cards in source-text order.
7. Locate the source passage, edit the annotation, or save it as a Markdown note.

### Built-in Capabilities

- File-scoped annotation sidebar.
- OpenAI-compatible AI provider configuration.
- Local plugin-data storage for active annotation cards.
- Optional Markdown note generation in the vault.
- Source passage navigation.
- Editable annotation bodies.
- Built-in JSON answer skills in `skills/*.json`.
- User-overridable custom skills from a vault folder.
- Optional web search enrichment through Tavily or a custom URL template.

### Development

```bash
npm install
npm run typecheck
npm run build
```

During development, copy or symlink the built files into an Obsidian vault:

```text
.obsidian/plugins/margin-ai/
  manifest.json
  main.js
  styles.css
  skills/
```

Reload the plugin after copying files.

### Answer Skills

Built-in answer skills live in `plugin/skills/*.json`. Each skill defines an intent, matching hints, prompt boundaries, process scaffolding, and visible output rules.

Users can configure a custom skills folder in the plugin settings. A custom skill with the same `intent` as a built-in skill overrides the built-in version.

## 中文

### 使用流程

1. 在 Obsidian 中打开一个 Markdown 笔记。
2. 选中一段原文。
3. 运行 `MarginAI: 对选中文本提问` 向 AI 提问，或运行 `MarginAI: 增加批注` 写个人批注。
4. 在 MarginAI 侧边栏中编辑问题或批注内容。
5. `Enter` 提交，`Shift+Enter` 换行。
6. 在侧边栏中按原文顺序查看批注卡片。
7. 可以定位回原文、编辑批注，或保存为 Markdown 笔记。

### 当前能力

- 当前文件范围内的批注侧边栏。
- OpenAI-compatible AI 服务配置。
- 活跃批注卡片保存在本地插件数据中。
- 可选生成 vault 内 Markdown 批注笔记。
- 从批注跳转回原文。
- 可编辑批注正文。
- `skills/*.json` 内置回答策略。
- 支持用户从 vault 文件夹覆盖/新增 skill。
- 可选 Tavily 或自定义 URL 模板联网搜索。

### 开发

```bash
npm install
npm run typecheck
npm run build
```

开发测试时，将构建产物复制或软链接到 Obsidian vault：

```text
.obsidian/plugins/margin-ai/
  manifest.json
  main.js
  styles.css
  skills/
```

复制后需要重新加载插件。

### Answer Skills

内置回答 skills 位于 `plugin/skills/*.json`。每个 skill 定义 intent、匹配提示、回答边界、内部过程脚手架和最终可见输出规则。

用户可以在插件设置里配置自定义 skills 文件夹。自定义 skill 如果和内置 skill 使用同一个 `intent`，会覆盖内置版本。
