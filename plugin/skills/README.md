# MarginAI Answer Skills

MarginAI routes each AI annotation request to an answer skill. Built-in skills live in this folder as JSON files so open-source users can inspect and improve them.

Users can add or override skills from their vault by setting a custom skills folder in the plugin settings. A user skill with the same `intent` as a built-in skill replaces the built-in skill.

Each skill file should contain:

```json
{
  "intent": "concept",
  "id": "concept-bridge",
  "match": ["是什么", "meaning", "define"],
  "goal": "What this skill should accomplish.",
  "boundaries": ["Information boundaries and safety rules."],
  "process": ["Private reasoning scaffold for weak models."],
  "finalOutput": ["Visible output requirements."],
  "includeContext": true,
  "allowBackgroundKnowledge": true,
  "lengthHint": "Default answer length."
}
```

`process` is included in the prompt as an internal scaffold. The model is instructed not to show it in the saved annotation.

Skill writing principles:

- Prefer task-routing guidance over rigid output templates.
- Tell weak models what to inspect first, what to preserve, and what to avoid.
- If the selected source already has a clear structure, skills should preserve that structure instead of asking the model to invent a new one.
- Output shape should serve the user's question; do not force sections that add no value.
