#!/usr/bin/env bun
import path from 'node:path';
import pkg from '../package.json';
import type { AgentName, ArtifactCategory } from './types';
import { HOME, agentTotal, scanArtifacts } from './scanner';
import { cleanArtifacts, cleanProjectEntries } from './cleaner';
import { checkMcpServers, discoverMcpServers } from './mcp';
import { runTui } from './tui/app';
import { discoverSkills, removeSkill, setSkillEnabled, summarizeSkills, type SkillRecord, type SkillScope } from './skills';
import { scanProject } from './projects';

const AGENTS: AgentName[] = [
  'claude',
  'codex',
  'pi',
  'omp',
  'gemini',
  'copilot',
  'cursor',
  'cline',
  'roo',
  'zed',
  'goose',
  'antigravity',
  'kilocode',
  'kimi',
  'deepseek',
  'hermes',
  'openhands',
  'openclaw',
  'qwen',
];
const CATEGORIES: ArtifactCategory[] = ['cache', 'log', 'session', 'storage', 'config', 'backup'];
const SCOPES: SkillScope[] = ['global', ...AGENTS, 'project'];
const SKILL_ACTIONS = ['list', 'verify', 'enable', 'disable', 'remove'] as const;

type SkillAction = (typeof SKILL_ACTIONS)[number];

interface CliOptions {
  command: 'report' | 'scan' | 'clean' | 'mcp' | 'skills' | 'project' | 'tui';
  skillAction?: SkillAction;
  names: string[];
  json: boolean;
  yes: boolean;
  probe: boolean;
  timeoutMs: number;
  agents?: AgentName[];
  categories?: ArtifactCategory[];
  scopes?: SkillScope[];
  allowCaution: boolean;
  onlyIssues: boolean;
  projectClean: boolean;
  fullPaths: boolean;
}

const USAGE = `Usage: cac <command> [options]

Commands
  tui                    Interactive terminal UI (default for a bare invocation)
  report                 Artifact scan, skill summary, MCP status (default when piped)
  scan                   List agent artifacts with size, files, safety
  project [path]         Artifacts for one project (default: current directory)
  clean                  Remove regenerable artifacts (dry run by default)
  skills <action>        Skill inventory and control
    list                   Every skill per scope, validity, enabled state
    verify                 Validity report, exit 1 on errors
    disable <name...>      Disable through the agent config
    enable <name...>       Re-enable a disabled skill
    remove <name...>       Delete the skill directory (dry run by default)
  mcp                    List MCP servers and check availability

Options
  --agent <a,b>          Filter: ${AGENTS.join(', ')}
  --category <c,b>       Filter: ${CATEGORIES.join(', ')}
  --scope <s,b>          Filter skills: ${SCOPES.join(', ')}
  --only-issues          With skills list: show skills that have issues
  --full-paths           Print absolute paths instead of ~
  --json                 Machine-readable output
  --yes                  Apply clean or skills remove (otherwise dry run)
  --clean                With project: clean that project's session state
  --allow-caution        With clean: include caution artifacts
  --no-probe             Skip MCP handshake probe, check command only
  --timeout <ms>         MCP probe timeout, default 60000
  -h, --help             Show this help`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error('Run with --help for usage.');
  process.exit(64);
}

function parseList<T extends string>(value: string, allowed: T[], label: string): T[] {
  const items = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const invalid = items.filter((item) => !allowed.includes(item as T));
  if (invalid.length > 0) {
    fail(`unknown ${label}: ${invalid.join(', ')}. Allowed: ${allowed.join(', ')}`);
  }
  return items as T[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: 'report',
    names: [],
    json: false,
    yes: false,
    probe: true,
    timeoutMs: 60_000,
    allowCaution: false,
    onlyIssues: false,
    projectClean: false,
    fullPaths: false,
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    const command = args.shift() as string;
    const commands: CliOptions['command'][] = ['report', 'scan', 'clean', 'mcp', 'skills', 'project', 'tui'];
    if (!commands.includes(command as CliOptions['command'])) {
      fail(`unknown command: ${command}`);
    }
    options.command = command as CliOptions['command'];
  }

  if (options.command === 'skills') {
    const action = args[0];
    if (!action || action.startsWith('-')) {
      fail(`skills needs an action: ${SKILL_ACTIONS.join(', ')}`);
    }
    if (!SKILL_ACTIONS.includes(action as SkillAction)) {
      fail(`unknown skills action: ${action}. Allowed: ${SKILL_ACTIONS.join(', ')}`);
    }
    options.skillAction = action as SkillAction;
    args.shift();
  }

  while (args.length > 0) {
    const arg = args.shift() as string;
    switch (arg) {
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
      case '-v':
      case '--version':
        console.log(`cac ${pkg.version}`);
        process.exit(0);
      case '--json':
        options.json = true;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--no-probe':
        options.probe = false;
        break;
      case '--allow-caution':
        options.allowCaution = true;
        break;
      case '--clean':
        options.projectClean = true;
        break;
      case '--only-issues':
        options.onlyIssues = true;
        break;
      case '--full-paths':
        options.fullPaths = true;
        break;
      case '--agent':
        options.agents = parseList(args.shift() ?? fail('--agent needs a value'), AGENTS, 'agent');
        break;
      case '--category':
        options.categories = parseList(args.shift() ?? fail('--category needs a value'), CATEGORIES, 'category');
        break;
      case '--scope':
        options.scopes = parseList(args.shift() ?? fail('--scope needs a value'), SCOPES, 'scope');
        break;
      case '--timeout': {
        const raw = args.shift() ?? fail('--timeout needs a value');
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 1000) fail(`invalid timeout: ${raw}`);
        options.timeoutMs = value;
        break;
      }
      default:
        if ((options.command === 'skills' || options.command === 'project') && !arg.startsWith('-')) {
          options.names.push(arg);
          break;
        }
        fail(`unknown option: ${arg}`);
    }
  }

  if (options.projectClean && options.command !== 'project') {
    fail('--clean applies to the project command only');
  }

  fullPaths = options.fullPaths;
  return options;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

const ANSI = {
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  reset: '\x1b[0m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function colorize(text: string, color: keyof typeof ANSI): string {
  return useColor ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

let fullPaths = false;

function tilde(file: string): string {
  if (fullPaths) return file;
  const relative = path.relative(HOME, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return `~${path.sep}${relative}`;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function printTable(rows: string[][], headers: string[]): void {
  const visible = (text: string) => text.replace(ANSI_PATTERN, '');
  const widths = headers.map((header, index) =>
    Math.max(visible(header).length, ...rows.map((row) => visible(row[index] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) =>
        index === cells.length - 1
          ? cell
          : cell + ' '.repeat(Math.max(0, (widths[index] ?? 0) - visible(cell).length)),
      )
      .join('  ')
      .trimEnd();

  console.log(colorize(line(headers), 'dim'));
  for (const row of rows) console.log(line(row));
}

function safetyLabel(record: { safetyLevel: string; recommendedAction: string }): string {
  if (record.safetyLevel === 'critical') return colorize('never', 'red');
  if (record.recommendedAction === 'clean') return colorize(record.safetyLevel, 'green');
  return colorize(record.safetyLevel, 'yellow');
}

async function runScan(options: CliOptions): Promise<void> {
  const records = await scanArtifacts({ agents: options.agents, categories: options.categories });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          home: HOME,
          totals: agentTotal(records),
          artifacts: records.map((record) => ({
            ...record,
            path: record.absolutePath,
            lastModified: record.lastModified?.toISOString(),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (records.length === 0) {
    console.log('No artifacts matched the filter.');
    return;
  }

  printTable(
    records.map((record) => [
      record.agent,
      record.category,
      record.exists ? formatBytes(record.sizeBytes) : '-',
      String(record.exists ? record.fileCount : '-'),
      safetyLabel(record),
      record.recommendedAction,
      tilde(record.absolutePath),
    ]),
    ['AGENT', 'CATEGORY', 'SIZE', 'FILES', 'SAFETY', 'ACTION', 'PATH'],
  );

  const totals = agentTotal(records);
  const reclaimable = records
    .filter((record) => record.recommendedAction === 'clean' && record.safetyLevel === 'safe')
    .reduce((sum, record) => sum + record.sizeBytes, 0);

  console.log('');
  console.log(
    Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([agent, total]) => `${agent} ${formatBytes(total)}`)
      .join('  '),
  );
  console.log(`reclaimable now (safe artifacts): ${formatBytes(reclaimable)}`);
}

async function runClean(options: CliOptions): Promise<void> {
  const records = await scanArtifacts({ agents: options.agents, categories: options.categories });
  const dryRun = !options.yes;
  const results = await cleanArtifacts(records, {
    dryRun,
    agents: options.agents,
    categories: options.categories,
    safetyLevels: options.allowCaution ? ['safe', 'caution'] : ['safe'],
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dryRun,
          totalBytes: results.reduce(
            (sum, result) => sum + (result.cleaned ? result.bytesFreed : result.artifact.sizeBytes),
            0,
          ),
          results: results.map((result) => ({
            agent: result.artifact.agent,
            category: result.artifact.category,
            safety: result.artifact.safetyLevel,
            path: result.artifact.absolutePath,
            sizeBytes: result.artifact.sizeBytes,
            cleaned: result.cleaned,
            error: result.error,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (results.length === 0) {
    console.log('Nothing to clean. Use --category or --allow-caution to widen the filter.');
    return;
  }

  const bytes = results.reduce(
    (sum, result) => sum + (result.cleaned ? result.bytesFreed : result.artifact.sizeBytes),
    0,
  );

  for (const result of results) {
    const status = dryRun ? 'would remove' : result.cleaned ? 'removed' : `failed: ${result.error}`;
    console.log(
      `${status.padEnd(14)} ${formatBytes(result.artifact.sizeBytes).padStart(9)}  ${tilde(result.artifact.absolutePath)}`,
    );
  }

  console.log('');
  console.log(
    dryRun
      ? `Dry run: ${results.length} artifacts, ${formatBytes(bytes)} reclaimable. Re-run with --yes to delete.`
      : `Removed ${results.filter((result) => result.cleaned).length}/${results.length} artifacts, freed ${formatBytes(bytes)}.`,
  );
}

async function runMcp(options: CliOptions): Promise<number> {
  const discovery = await discoverMcpServers();
  const statuses = await checkMcpServers(discovery.servers, {
    probe: options.probe,
    timeoutMs: options.timeoutMs,
  });

  if (options.json) {
    console.log(JSON.stringify({ configFiles: discovery.configFiles, servers: statuses }, null, 2));
  } else {
    printTable(
      discovery.configFiles.map((config) => [
        config.found ? 'found' : 'missing',
        String(config.serverCount),
        tilde(config.path),
      ]),
      ['CONFIG', 'SERVERS', 'PATH'],
    );

    console.log('');

    if (statuses.length === 0) {
      console.log('No MCP servers configured.');
    } else {
      printTable(
        statuses.map((status) => [
          status.name,
          status.type,
          status.available ? colorize('yes', 'green') : colorize('no', 'red'),
          status.latencyMs !== undefined ? `${(status.latencyMs / 1000).toFixed(1)}s` : '-',
          status.statusMessage,
          tilde(status.source.replace(/^[a-z]+:/, '')),
        ]),
        ['NAME', 'TYPE', 'OK', 'LATENCY', 'DETAIL', 'SOURCE'],
      );
    }
  }

  const unavailable = statuses.filter((status) => !status.available).length;
  return unavailable > 0 ? 1 : 0;
}

function skillValidity(skill: SkillRecord): string {
  const errors = skill.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = skill.issues.length - errors;
  if (errors > 0) return colorize(`${errors} error${errors === 1 ? '' : 's'}`, 'red');
  if (warnings > 0) return colorize(`${warnings} warn`, 'yellow');
  return colorize('ok', 'green');
}

function selectSkills(records: SkillRecord[], options: CliOptions): SkillRecord[] {
  return records.filter((record) => !options.scopes || options.scopes.includes(record.scope));
}

function skillNamesToRecords(records: SkillRecord[], names: string[]): SkillRecord[] {
  return records.filter(
    (record) => names.includes(record.name) || (record.declaredName !== undefined && names.includes(record.declaredName)),
  );
}

async function runSkills(options: CliOptions): Promise<number> {
  const action = options.skillAction;
  if (!action) fail('skills needs an action');

  const all = await discoverSkills();
  const records = selectSkills(all, options);

  if (action === 'list') {
    const visible = options.onlyIssues
      ? records.filter((record) => record.issues.length > 0)
      : records;
    if (options.json) {
      console.log(JSON.stringify({ summary: summarizeSkills(records), skills: visible }, null, 2));
      return 0;
    }
    if (visible.length === 0) {
      console.log('No skills matched the filter.');
      return 0;
    }
    printTable(
      visible.map((record) => [
        record.scope,
        record.name,
        record.enabled ? colorize('enabled', 'green') : colorize('disabled', 'yellow'),
        skillValidity(record),
        record.pluginKey ? 'plugin' : record.isSymlink ? 'link' : 'dir',
        tilde(record.directory),
      ]),
      ['SCOPE', 'NAME', 'STATE', 'VALID', 'KIND', 'PATH'],
    );
    const summary = summarizeSkills(records);
    console.log('');
    console.log(
      Object.entries(summary.byScope)
        .map(([scope, count]) => `${scope} ${count}`)
        .join('  '),
    );
    console.log(
      `${summary.total} skills, ${summary.errors} errors, ${summary.warnings} warnings, ${summary.disabled} disabled`,
    );
    return 0;
  }

  if (action === 'verify') {
    const broken = records.filter((record) => record.issues.length > 0);
    if (options.json) {
      console.log(JSON.stringify({ summary: summarizeSkills(records), skills: broken }, null, 2));
    } else if (broken.length === 0) {
      console.log(`All ${records.length} skills valid.`);
    } else {
      printTable(
        broken.flatMap((record) =>
          record.issues.map((issue) => [
            record.scope,
            record.name,
            colorize(issue.severity, issue.severity === 'error' ? 'red' : 'yellow'),
            issue.message,
            tilde(record.directory),
          ]),
        ),
        ['SCOPE', 'NAME', 'SEVERITY', 'MESSAGE', 'PATH'],
      );
      console.log('');
      console.log(`${broken.length} of ${records.length} skills have issues`);
    }
    const errors = summarizeSkills(records).errors;
    return errors > 0 ? 1 : 0;
  }

  if (options.names.length === 0) {
    fail(`skills ${action} needs at least one skill name`);
  }

  const matches = skillNamesToRecords(records, options.names);
  const missing = options.names.filter(
    (name) => !matches.some((record) => record.name === name || record.declaredName === name),
  );

  if (matches.length === 0) {
    fail(`no skill matched: ${options.names.join(', ')} in scope ${options.scopes?.join(', ') ?? 'all'}`);
  }
  for (const name of missing) {
    console.error(`warning: no skill named ${name} in scope`);
  }

  if (action === 'remove') {
    const dryRun = !options.yes;
    const outcomes = [];
    for (const record of matches) outcomes.push(await removeSkill(record, dryRun));

    if (options.json) {
      console.log(JSON.stringify({ dryRun, outcomes }, null, 2));
      return outcomes.some((outcome) => outcome.error) ? 1 : 0;
    }

    for (const outcome of outcomes) {
      const status = outcome.error
        ? `failed: ${outcome.error}`
        : dryRun
          ? 'would remove'
          : 'removed';
      console.log(`${status.padEnd(14)} ${tilde(outcome.skill.directory)}`);
    }
    console.log('');
    console.log(
      dryRun
        ? `${outcomes.length} skills matched. Re-run with --yes to delete.`
        : `Removed ${outcomes.filter((outcome) => outcome.removed).length}/${outcomes.length} skills.`,
    );
    return outcomes.some((outcome) => outcome.error) ? 1 : 0;
  }

  const enabled = action === 'enable';
  const outcomes = [];
  for (const record of matches) outcomes.push(await setSkillEnabled(record, enabled));

  if (options.json) {
    console.log(JSON.stringify({ outcomes }, null, 2));
    return outcomes.some((outcome) => !outcome.changed) ? 1 : 0;
  }

  printTable(
    outcomes.map((outcome) => [
      outcome.skill.scope,
      outcome.skill.name,
      outcome.changed ? 'updated' : 'skipped',
      outcome.message,
      tilde(outcome.skill.directory),
    ]),
    ['SCOPE', 'NAME', 'RESULT', 'DETAIL', 'PATH'],
  );

  return outcomes.some((outcome) => !outcome.changed) ? 1 : 0;
}

async function runProject(options: CliOptions): Promise<number> {
  const target = options.names[0] ?? process.cwd();
  const scan = await scanProject(target);

  if (options.projectClean) {
    const dryRun = !options.yes;
    const results = await cleanProjectEntries(scan.entries, {
      projectRoot: scan.project,
      dryRun,
      safetyLevels: options.allowCaution ? ['safe', 'caution'] : ['safe'],
    });

    if (options.json) {
      console.log(JSON.stringify({ project: scan.project, dryRun, results }, null, 2));
      return results.some((result) => result.error) ? 1 : 0;
    }

    console.log(`project: ${scan.project}`);

    if (results.length === 0) {
      console.log('nothing to clean for this project. Add --allow-caution to include session state.');
      return 0;
    }

    for (const result of results) {
      const status = dryRun ? 'would remove' : result.cleaned ? 'removed' : `failed: ${result.error}`;
      console.log(
        `${status.padEnd(14)} ${formatBytes(result.entry.sizeBytes).padStart(9)}  ${result.entry.label}  ${tilde(result.entry.absolutePath)}`,
      );
    }

    const bytes = results.reduce(
      (sum, result) => sum + (result.cleaned ? result.bytesFreed : result.entry.sizeBytes),
      0,
    );
    console.log('');
    console.log(
      dryRun
        ? `Dry run: ${results.length} entries, ${formatBytes(bytes)} reclaimable. Re-run with --yes.`
        : `Removed ${results.filter((result) => result.cleaned).length}/${results.length} entries, freed ${formatBytes(bytes)}.`,
    );
    return results.some((result) => result.error) ? 1 : 0;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          project: scan.project,
          entries: scan.entries.map((entry) => ({
            ...entry,
            lastModified: entry.lastModified?.toISOString(),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`project: ${scan.project}`);

  if (scan.entries.length === 0) {
    console.log('no agent artifacts found for this project');
    return 0;
  }

  printTable(
    scan.entries.map((entry) => [
      entry.agent,
      entry.kind,
      entry.safetyLevel,
      entry.recommendedAction,
      formatBytes(entry.sizeBytes),
      String(entry.fileCount),
      entry.label,
      tilde(entry.absolutePath),
    ]),
    ['AGENT', 'KIND', 'SAFETY', 'ACTION', 'SIZE', 'FILES', 'LABEL', 'PATH'],
  );

  const bytes = scan.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const local = scan.entries.filter((entry) => entry.kind === 'local').length;
  const sessions = scan.entries.length - local;
  console.log('');
  console.log(`${scan.entries.length} entries, ${formatBytes(bytes)} total (${local} local, ${sessions} session)`);
  return 0;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const options = parseArgs(rawArgs);

  if (
    rawArgs.length === 0 &&
    process.stdin.isTTY &&
    process.stdout.isTTY
  ) {
    await runTui();
    return;
  }

  switch (options.command) {
    case 'scan':
      await runScan(options);
      break;
    case 'clean':
      await runClean(options);
      break;
    case 'mcp':
      process.exitCode = await runMcp(options);
      break;
    case 'skills':
      process.exitCode = await runSkills(options);
      break;
    case 'project':
      process.exitCode = await runProject(options);
      break;
    case 'tui':
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        fail('tui needs an interactive terminal');
      }
      await runTui();
      break;
    case 'report': {
      await runScan(options);
      const summary = summarizeSkills(selectSkills(await discoverSkills(), options));
      console.log('');
      console.log(
        `skills ${summary.total}, ${summary.errors} errors, ${summary.warnings} warnings, ${summary.disabled} disabled`,
      );
      console.log('');
      process.exitCode = await runMcp(options);
      break;
    }
  }
}

await main();
