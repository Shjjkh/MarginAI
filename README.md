# MarginAI

MarginAI is an Obsidian plugin for AI-assisted reading annotations.

The core workflow:

- Select text in a Markdown note.
- Ask AI about the selected text.
- Save the answer as a visible Markdown annotation file in the vault.
- Manage annotations from a file-scoped sidebar.
- Jump from an annotation back to the original source text.

The active plugin project lives in [`plugin/`](plugin/).

Default annotation folder in an Obsidian vault:

```text
MarginAI/Annotations
```

Development:

```bash
cd plugin
npm install
npm run build
```
