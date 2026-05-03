# MarginAI Obsidian Plugin

MarginAI is an Obsidian plugin prototype for AI-assisted reading annotations.

Current v1 flow:

- Select text in a Markdown note.
- Run `MarginAI: 对选中文本提问`.
- Enter the question in the MarginAI sidebar. `Enter` submits, `Shift+Enter` inserts a new line.
- The plugin sends the selected text and question to an OpenAI-compatible API.
- The answer is saved as a visible Markdown annotation sidecar in the vault.
- The MarginAI sidebar lists annotations for the current Markdown file and can open the source note or sidecar file.
- The sidecar file itself is the user-visible annotation document and links back to the source note.

Default vault folder:

- `MarginAI/Annotations`

Annotation sidecar files intentionally use constrained Markdown:

- no headings
- no tables
- source quote, question, answer, simple text, simple lists, and Obsidian links only

Development:

```bash
npm install
npm run build
```

To test locally, copy or symlink these files into an Obsidian vault plugin folder:

```text
.obsidian/plugins/margin-ai/
  manifest.json
  main.js
  styles.css
```
