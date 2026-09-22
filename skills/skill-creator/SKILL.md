---
name: skill-creator
description: Create, update, import, or validate Emperor Skills (SKILL.md folders with optional scripts, references, and assets). Use when the user wants a new Skill, wants to improve an existing one, or wants to install a Skill from a folder, a zip, or a GitHub link.
---

# Skill Creator

Guidance for creating effective Skills and managing them with the `skill_manage` tool.

## About Skills

A Skill is a self-contained folder that gives the agent specialized knowledge, a workflow, or tools for one kind of task. Think of it as an onboarding guide: it turns a general-purpose agent into one equipped with procedural knowledge no model has on its own.

Skills provide:

1. Workflows: multi-step procedures for a specific domain
2. Tool integrations: how to work with specific file formats or APIs
3. Domain expertise: schemas, conventions, business rules
4. Bundled resources: scripts, references, and assets for repetitive work

## Where Skills live

| Scope             | Folder                              | Notes                                                                              |
| ----------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| Personal          | `~/.emperor/skills/<name>/`         | Available in every session                                                         |
| Project           | `<project>/.emperor/skills/<name>/` | Build sessions of that project only; overrides a personal Skill with the same name |
| Built-in / Plugin | shipped with Emperor or a Plugin    | Read-only                                                                          |

Create, update, delete, and import Skills only with `skill_manage`. These folders are outside the writable workspace, so file and shell tools cannot write them; `skill_manage` asks the user for approval unless the session runs with full access. To change a built-in or Plugin Skill, create a personal Skill with the same name; it takes precedence.

## Anatomy of a Skill

```
skill-name/
├── SKILL.md          (required: YAML frontmatter + Markdown instructions)
├── scripts/          (optional: executable code)
├── references/       (optional: documents loaded into context when needed)
└── assets/           (optional: files used in the output, e.g. templates)
```

### SKILL.md

- **Frontmatter** (YAML, required): `name` and `description`. They are the only fields the agent sees before the Skill is loaded, so the description must say what the Skill does and when to use it.
- **Body** (Markdown): instructions, loaded only after the Skill triggers.

Rules Emperor enforces:

- `name`: lowercase letters, digits, `.`, `_`, `-`; starts with a letter or digit; at most 64 characters. The frontmatter name is the Skill's name; keep the folder name identical.
- `description`: required; keep it under 1024 characters.
- Links in SKILL.md should be relative paths inside the Skill folder (for example `references/api.md`). Missing referenced files are reported as warnings.
- Symbolic links must stay inside the Skill folder. `node_modules`, `.venv`, `venv`, `.git`, and `__pycache__` are ignored and are not copied on import.
- Use `{{skill_dir}}` for absolute paths to bundled files; Emperor expands it when the Skill is loaded.

### Bundled resources

- **scripts/**: code for tasks that need deterministic reliability or are rewritten repeatedly (for example `scripts/rotate_pdf.py`). Test every script you add by running it.
- **references/**: documentation to read while working: schemas, API docs, policies. For large files, tell the agent which `grep` or `glob` patterns find the relevant part.
- **assets/**: files used in the output but not read into context: templates, images, fonts, boilerplate projects.

Do not add README, CHANGELOG, installation guides, or other auxiliary documentation. A Skill contains only what an agent needs to do the job.

## Core principles

### Be concise

The context window is shared with the system prompt, the conversation, and every other Skill's description. Assume the agent is already capable; add only what it would not know. Prefer short examples over long explanations.

### Match freedom to fragility

- **High freedom** (prose guidance): several approaches are valid and the choice depends on context.
- **Medium freedom** (pseudocode or parameterized scripts): a preferred pattern exists but variation is fine.
- **Low freedom** (exact scripts, few parameters): the operation is fragile or must happen in a fixed order.

### Progressive disclosure

1. Name and description: always in context.
2. SKILL.md body: loaded when the Skill triggers; keep it under about 500 lines.
3. Bundled resources: read or executed only when needed.

When a Skill covers several variants (frameworks, providers, domains), keep the selection logic in SKILL.md and move each variant's details into its own reference file, linked directly from SKILL.md. Keep references one level deep, and add a table of contents to reference files longer than about 100 lines.

## Creating a Skill

### 1. Understand concrete use cases

Ask the user for examples of requests that should trigger the Skill and what a good result looks like. Ask a few questions at a time. Skip this step only when the usage is already clear.

### 2. Plan the reusable contents

For each example, work out what you would otherwise rewrite or rediscover every time: a script, a reference document, or an asset. That list becomes the Skill's resources.

### 3. Write the Skill

Name it with a short, verb-led, hyphen-case name (for example "Plan Mode" → `plan-mode`). Then create it with one call, passing the full SKILL.md and any resource files:

```json
{
  "action": "create",
  "scope": "user",
  "content": "---\nname: pdf-rotate\ndescription: Rotate, split, and merge PDF files. Use when the user asks to change page order or orientation of a PDF.\n---\n\n# PDF Rotate\n\nRun `scripts/rotate.py <file> <degrees>` ...\n",
  "files": {
    "scripts/rotate.py": "import sys\n..."
  }
}
```

Use `"scope": "project"` in a Build session when the Skill belongs to that project only.

Writing guidelines:

- Use the imperative voice.
- Put all "when to use" information in the description, not in the body.
- Keep frontmatter minimal; add `metadata` only when needed, for example `metadata: { emperor: { requires: { bins: [git] } } }` to declare required tools.

### 4. Validate

```json
{ "action": "validate", "name": "pdf-rotate" }
```

Fix every reported error. Warnings (for example a missing referenced file) mean something is probably wrong; check them too. `validate` also accepts `content` to check SKILL.md text before writing it.

### 5. Iterate

Use the Skill on real tasks, note where the agent struggled, and update it:

```json
{
  "action": "update",
  "name": "pdf-rotate",
  "content": "<full new SKILL.md>",
  "files": { "scripts/rotate.py": "..." }
}
```

`update` replaces SKILL.md and writes the given files; files you do not pass are kept. Use `{ "action": "delete", "name": "..." }` to remove a Skill.

## Importing existing Skills

`skill_manage` with `action: "import"` installs Skills from:

- a local folder: `{ "kind": "folder", "path": "/abs/path" }`
- a local zip: `{ "kind": "zip", "path": "/abs/path/skill.zip" }`
- an https link: `{ "kind": "url", "url": "https://github.com/<owner>/<repo>/tree/<branch>/<folder>" }` or a direct `.zip` link
- pasted SKILL.md text: `{ "kind": "content", "content": "---\nname: ..." }`

Every folder containing a SKILL.md is imported under its frontmatter name. An existing Skill with the same name is kept unless `"overwrite": true` is passed. Review imported scripts before running them.

## Listing

`{ "action": "list" }` shows the Skills available in the current session with their source, and any invalid Skills with the reason they were rejected.
