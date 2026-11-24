# cac — coding agent cleanup

Inventory of what coding agents leave in your home directory, plus a skill
audit and an MCP health check.

Agents covered: Claude, Codex, Pi, OMP, Gemini, Copilot, Cursor, Cline, Roo Code,
Zed, Goose, Antigravity, Kilocode, Kimi, DeepSeek, OpenHands, Hermes, OpenClaw,
Qwen Code.

## Commands

```bash
bun run src/index.ts tui                    # interactive terminal UI
bun run src/index.ts                        # artifacts, skill summary, MCP status
bun run src/index.ts scan                   # artifacts only
bun run src/index.ts clean                  # dry run, shows what would be removed
bun run src/index.ts clean --yes            # delete safe artifacts
bun run src/index.ts project [path]        # artifacts for one project (default cwd)
bun run src/index.ts project --clean --allow-caution   # dry run of project session state
bun run src/index.ts skills list            # every skill, its state and validity
bun run src/index.ts skills verify          # validity report, exit 1 on errors
bun run src/index.ts skills disable <name>  # disable through the agent config
bun run src/index.ts skills enable <name>
bun run src/index.ts skills remove <name>   # dry run, then --yes to delete
bun run src/index.ts mcp                    # MCP servers and handshake result
```

## Interactive UI

`cac tui`, or bare `cac` with a terminal attached, opens a scope picker first:
home-wide, the current directory, or a typed path. A piped or `--json` call falls
back to the text report. Pick a project and the artifacts tab shows that project's
local files and per-agent session state; pick home and it shows every agent in
your home directory. Press `s` on the artifacts tab to change scope.

The chosen directory also feeds skill discovery: `project`-scope skill rows come
from that directory's `.claude/skills` and `.agents/skills`, not the directory you
launched from.

Three tabs follow: artifacts, skills, MCP. Arrow keys or `j`/`k` move, `1`-`3` or
Tab switch tabs, `r` reloads the current tab.

| Key | Artifacts | Skills | MCP |
| :--- | :--- | :--- | :--- |
| `Space` | mark/unmark row (turns cyan, `*` marker) | | |
| `c` | clean marked artifacts (or selected if none marked), after `y` | | |
| `C` | clean every cleanable artifact, after `y` | | |
| `u` | allow `caution` artifacts | | |
| `s` | change scope | | |
| `d` | | enable or disable the skill | |
| `x` | | remove the skill, after `y` | |
| `i` | | show only skills with issues | |
| `p` | | | toggle the handshake probe |
| `/` | filter rows | filter rows | filter rows |
| `esc` | clear filter or marks | clear the filter | clear the filter |
| `q` | quit | quit | quit |

The selected row's absolute path sits on its own line above the status bar, with
middle truncation so the root and the file name both stay visible.

In project scope the same safety rules apply. Session rows are `caution`/`clean`,
so `u` unlocks them and `c` or `C` then deletes them after `y`. Local config rows
are `critical`/`keep` and refuse with a keep message.

## Global command

Build one executable and put it on `PATH`:

```bash
bun run build:exe
cp cac.exe ~/.local/bin/cac.exe      # PowerShell: Copy-Item cac.exe $HOME\.local\bin\cac.exe
```

`~/.local/bin` is already on your `PATH` here, so `cac` works from any directory:

```bash
cac tui
cac project D:/path/to/repo
cac mcp
```

The binary embeds the Bun runtime, about 86 MB. Rebuild after code changes.

For development without rebuilding, `bun link` registers the package instead and
runs `src/index.ts` directly.

## Options

| Flag | Effect |
| :--- | :--- |
| `--agent claude,codex` | Filter artifacts. Known: `claude`, `codex`, `pi`, `omp`, `gemini`, `copilot` |
| `--category cache,log` | Filter artifacts. Known: `cache`, `log`, `session`, `storage`, `config`, `backup` |
| `--scope codex,global` | Filter skills. Known: `global`, `claude`, `codex`, `pi`, `omp`, `gemini`, `copilot`, `project` |
| `--only-issues` | With `skills list`: show only skills that have issues |
| `--full-paths` | Print absolute paths instead of `~`-relative |
| `--json` | Machine-readable output |
| `--yes` | Apply `clean` or `skills remove`. Without it both are dry runs |
| `--allow-caution` | Include `caution` artifacts in `clean` |
| `--no-probe` | Check MCP command presence only, skip the handshake |
| `--timeout <ms>` | MCP probe timeout, default `60000` |

`mcp` and `report` exit `1` when any server is unavailable. `skills verify`
exits `1` when any skill has an error.

## Artifact safety levels

| Level | Meaning | `clean` default |
| :--- | :--- | :--- |
| `safe` | Regenerable cache, log, or backup | removed |
| `caution` | State you may want, or a live database | kept, removed with `--allow-caution` |
| `critical` | Config, credentials, skills | never removed |

`clean` only touches paths inside the user home directory and skips symlinks.

## Per-project artifacts

`project [path]` folds in local agent files under the project plus the home state
each agent keys by that path.

| Source | Location |
| :--- | :--- |
| Local config | `.claude/settings.local.json`, `.mcp.json` |
| Local skills and agents | `.claude/skills`, `.claude/agents`, `.claude/commands`, `.agents/skills` |
| Local agent dirs | `.codex`, `.pi`, `.omp`, `.gemini`, `.copilot` when present |
| Claude transcripts | `~/.claude/projects/<slug>`, slug = path with each separator replaced by `-` |
| OMP sessions | `~/.omp/agent/sessions/--<slug>--` |
| Pi sessions | `~/.pi/agent/sessions/--<slug>--` |
| Codex rollouts | `~/.codex/sessions/**/*.jsonl` whose `session_meta.payload.cwd` matches |
| Copilot sessions | `~/.copilot/session-state/*/workspace.yaml` whose `cwd:` matches |

Path matching ignores case on Windows. Codex rollouts and Copilot sessions get one
row each, so every path matches its measured size. Gemini history uses hashed
directory names with no project path, so it is not attributed. Use `--json` for
scripting.

Session rows are `caution`/`clean`; local rows are `critical`/`keep`. Cleaning
follows the same gates as home-wide:

```bash
bun run src/index.ts project --clean                      # dry run, safe rows only
bun run src/index.ts project --clean --allow-caution      # dry run, session state included
bun run src/index.ts project --clean --allow-caution --yes
```

Only paths inside the project directory or your home directory are eligible, and
sidecar or lock files stay protected.

## Skill scopes

| Scope | Directory |
| :--- | :--- |
| `global` | `~/.agents/skills`, the shared store |
| `claude` | `~/.claude/skills`, `~/.claude/plugins/cache/*/*/*/skills` |
| `codex` | `~/.codex/skills`, `~/.agents/skills`, `~/.codex/plugins/cache/*/*/*/skills` |
| `pi` | `~/.pi/agent/skills` (usually symlinks into the shared store) |
| `omp` | `~/.omp/agent/skills`, `~/.omp/agent/managed-skills` |
| `gemini` | `~/.gemini/skills` |
| `copilot` | `~/.copilot/skills` |
| `project` | `.claude/skills`, `.agents/skills`, `.codex/skills`, `.omp/skills`, `.gemini/skills`, `.copilot/skills` in the current directory |

The same directory can appear under `global` and `codex`. Both are listed
because Codex reads the shared store directly and keeps its own toggle per
skill.

## Validity checks

| Check | Severity |
| :--- | :--- |
| `SKILL.md` present and readable | error |
| Frontmatter block at the start of the file | error |
| Frontmatter delimiters escaped as `\---` | error |
| `name` present | error |
| `name` matches the directory name | error, warning when only the case differs |
| `description` present | error |
| `description` at most 1024 chars | warning |
| Body longer than 50 chars | warning |
| Broken symlink | error |
| Directory name is lowercase kebab-case | warning |

Empty directories and dot-prefixed directories are skipped.

## Skill toggles

| Scope | Mechanism |
| :--- | :--- |
| `codex` | `[[skills.config]]` block with `enabled` in `~/.codex/config.toml` |
| `claude` plugin skills | `enabledPlugins["<plugin>@<marketplace>"]` in `~/.claude/settings.json` |
| `global`, `claude`, `pi`, `omp`, `gemini`, `copilot`, `project` | move the skill into a sibling `<root>-disabled` directory |

Disabling a Codex skill adds a `[[skills.config]]` block with `enabled = false`.
Enabling it rewrites the value, and removes the block when the block holds only
`path` and `enabled`. Turning a plugin skill off flips `enabledPlugins` for the
whole plugin. Config files keep their line endings and key order.

The installed Claude build contains no per-skill toggle key, so plain Claude
skills use the filesystem stash. A stashed skill moves to `skills-disabled`,
`managed-skills-disabled`, or the matching sibling of its root. The agent no
longer scans it, `skills list` shows it as disabled, and `skills enable` moves it
back. A symlink moves as a link, so the shared target stays intact. An emptied
stash directory is removed.

## Skill removal

`skills remove` deletes the skill directory. A symlink is unlinked, never
followed. Removal refuses:

- paths outside the home or project tree
- top-level directories
- a skill in the shared `~/.agents/skills` store when the scope is not `global`
- a plugin-managed skill inside any `plugins/cache` tree
- a skill inside `skills/.system`

## MCP sources

| Agent | File |
| :--- | :--- |
| Claude | `~/.claude.json`, `~/.claude/settings.json` |
| Codex | `~/.codex/config.toml` (`[mcp_servers.*]`) |
| Pi | `~/.pi/agent/mcp.json` |
| Gemini | `~/.gemini/settings.json` |
| Copilot | `~/.copilot/mcp-config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Any | `./.mcp.json` in the current directory |

A `stdio` server counts as available when it answers a JSON-RPC `initialize`
request within the timeout. A cold `uvx` server may need the full timeout on
first run.

## Layout

```
src/types.ts     shared types
src/scanner.ts   artifact definitions and size measurement
src/cleaner.ts   target selection and deletion
src/skills.ts    skill discovery, validation, toggles, removal
src/mcp.ts       config discovery, TOML reader, health probes
src/tui/model.ts state, key handling, effects
src/tui/view.ts  frame renderer
src/tui/app.ts   terminal loop and effect runner
src/index.ts     CLI
```
