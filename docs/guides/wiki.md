---
title: Keep a readable work history
parent: Guides
nav_order: 12
---

# Keep what the work teaches

The wiki keeps knowledge that stays true and has to be gathered from many
messages: what a project is, its terms, decisions and specifications, and how a
client works. What happened stays in the sources, and current state and history
stay in the work ledger. Each evening the agent adds a page for the day. Read the
wiki in the viewer's Wiki page or in a Markdown editor.

## Choose the vault

Onboarding enables the wiki at `~/.mama/workspace/wiki`. To configure it manually:

```yaml
wiki:
  enabled: true
  vaultPath: ~/.mama/workspace
  wikiDir: wiki
```

A relative `wikiDir` is resolved under `vaultPath`; an absolute `wikiDir` names the
wiki root directly. Both paths are required when enabled. Restart after changing
configuration. The writer uses local Markdown files; opening them in Obsidian is
optional.

The owner agent's instructions use:

| Path                            | Content                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Home.md`                       | Every page with one line on what it covers                                                                                                    |
| Project, client and topic pages | Overview, decisions and specifications, terms, how the client works; each section rewritten when its knowledge changes, with no dated entries |
| `daily/YYYY-MM-DD.md`           | The day in brief, what the owner decided, what was missed and learned; written at `reports.daily_hour` (23:00 by default)                     |
| `log.md`                        | One line per wiki operation: a page created, reorganised or checked                                                                           |
| `lessons/`                      | Reusable lessons, with process/system/client subdirectories available                                                                         |

Directories are created at startup. Content and `Home.md` appear when the agent
publishes them; an empty vault is not a completed wiki.

## Read before changing a page

`manage.wiki.read` lists page paths or reads selected pages. Long lists and pages
are paginated; their version and continuation fields let the agent read the whole
result without combining different versions.

For an existing page, use `manage.wiki.update` to replace the named section whose
knowledge changed, passing the `expectedContentVersion` returned by the read. A concurrent
change produces a conflict to resolve by reading again. Use
`manage.wiki.publish` for a new page with `expectedContentVersion: null`, or for a
version-checked publication of an existing page. Evidence belongs in `sourceIds`
and `sourceRefs`; visible prose should explain what happened without internal IDs.

The writer preserves an existing human section beginning with `<!-- human -->`.
Place manually maintained notes below that marker if they should survive agent
publication.

## Check what carried over

Pick a project and check that its page answers the questions you would otherwise
dig through messages for: the terms, the decisions that stand, what the client
usually asks to change. Read yesterday's daily page and check it names what you
decided. Ask a later owner session a question the page answers. A saved Markdown
file alone does not demonstrate useful recall.
