import path from 'node:path';
import type { ArtifactRecord, McpServerStatus } from '../types';
import type { SkillRecord } from '../skills';
import type { ProjectEntry } from '../projects';
import {
  SCREENS,
  currentArtifact,
  currentProjectEntry,
  currentServer,
  currentSkill,
  cursorIndex,
  visibleArtifacts,
  visibleProjectEntries,
  visibleServers,
  visibleSkills,
  type TuiState,
} from './model';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const INVERSE = '\x1b[7m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const YELLOW_BOLD = `${BOLD}${YELLOW}`;
const CYAN = '\x1b[36m';
const CYAN_BOLD = `${BOLD}${CYAN}`;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function useColor(): boolean {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

function paint(text: string, code: string): string {
  return useColor() ? `${code}${text}${RESET}` : text;
}

function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

/** Keep both the root and the tail, so a long path stays identifiable. */
function fitMiddle(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width <= 3) return fit(text, width);
  const tail = Math.max(1, Math.floor((width - 1) / 2));
  const head = width - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function pad(text: string, width: number): string {
  const clipped = fit(text, width);
  return clipped + ' '.repeat(Math.max(0, width - clipped.length));
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

function tilde(file: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && file.startsWith(home)) return `~${file.slice(home.length)}`;
  return file;
}

interface Column {
  header: string;
  width: number;
}

function columnsFor(state: TuiState): Column[] {
  if (state.screen === 'artifacts') {
    if (state.scope) {
      return [
        { header: 'AGENT', width: 7 },
        { header: 'KIND', width: 8 },
        { header: 'SAFETY', width: 7 },
        { header: 'ACTION', width: 6 },
        { header: 'SIZE', width: 9 },
        { header: 'FILES', width: 6 },
        { header: 'LABEL', width: 18 },
      ];
    }
    return [
      { header: 'AGENT', width: 7 },
      { header: 'CATEGORY', width: 9 },
      { header: 'SIZE', width: 9 },
      { header: 'SAFETY', width: 7 },
      { header: 'ACTION', width: 6 },
    ];
  }
  if (state.screen === 'skills') {
    return [
      { header: 'SCOPE', width: 7 },
      { header: 'NAME', width: 34 },
      { header: 'STATE', width: 9 },
      { header: 'VALID', width: 8 },
      { header: 'KIND', width: 6 },
    ];
  }
  return [
    { header: 'NAME', width: 20 },
    { header: 'TYPE', width: 6 },
    { header: 'OK', width: 4 },
    { header: 'LATENCY', width: 8 },
  ];
}

function artifactCells(record: ArtifactRecord): string[] {
  return [
    record.agent,
    record.category,
    record.exists ? formatBytes(record.sizeBytes) : '-',
    record.safetyLevel,
    record.recommendedAction,
    tilde(record.absolutePath),
  ];
}

function skillCells(record: SkillRecord): string[] {
  const errors = record.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = record.issues.length - errors;
  const validity = errors > 0 ? `${errors} err` : warnings > 0 ? `${warnings} warn` : 'ok';
  return [
    record.scope,
    record.name,
    record.enabled ? 'enabled' : 'disabled',
    validity,
    record.pluginKey ? 'plugin' : record.isSymlink ? 'link' : 'dir',
    tilde(record.directory),
  ];
}

function serverCells(status: McpServerStatus): string[] {
  return [
    status.name,
    status.type,
    status.available ? 'yes' : 'no',
    status.latencyMs !== undefined ? `${(status.latencyMs / 1000).toFixed(1)}s` : '-',
    status.statusMessage,
  ];
}

function projectCells(entry: ProjectEntry): string[] {
  return [
    entry.agent,
    entry.kind,
    entry.safetyLevel,
    entry.recommendedAction,
    formatBytes(entry.sizeBytes),
    String(entry.fileCount),
    entry.label,
    tilde(entry.absolutePath),
  ];
}

function rowCells(state: TuiState): string[][] {
  if (state.screen === 'artifacts') {
    return state.scope
      ? visibleProjectEntries(state).map(projectCells)
      : visibleArtifacts(state).map(artifactCells);
  }
  if (state.screen === 'skills') return visibleSkills(state).map(skillCells);
  return visibleServers(state).map(serverCells);
}

function isBusy(state: TuiState): boolean {
  return (
    (state.screen === 'artifacts' && (state.artifactsBusy || state.projectBusy)) ||
    (state.screen === 'skills' && state.skillsBusy) ||
    (state.screen === 'mcp' && state.mcpBusy)
  );
}

function headerLine(state: TuiState, width: number): string {
  const counts: Record<string, number> = {
    artifacts: state.scope ? state.projectEntries.length : state.artifacts.length,
    skills: state.skills.length,
    mcp: state.mcp?.statuses.length ?? 0,
  };
  const spinner = isBusy(state) ? ` ${SPINNER[Date.now() % SPINNER.length] ?? ''}` : '';
  const tabs = SCREENS.map((screen, index) => {
    const label = `${index + 1} ${screen} ${counts[screen] ?? 0}`;
    return screen === state.screen ? `[${label}]` : ` ${label} `;
  }).join(' ');

  const left = `cac${spinner}  ${tabs}`;
  const right =
    state.marked.size > 0 && state.screen === 'artifacts'
      ? `${state.marked.size} marked`
      : state.filter
        ? `filter:${state.filter}`
        : state.allowCaution
          ? 'caution on'
          : state.scope
            ? `project:${path.basename(state.scope)}`
            : '';

  if (!right) return fit(left, width);
  const space = Math.max(1, width - left.length - right.length);
  return fit(`${left}${' '.repeat(space)}${right}`, width);
}

function detailLine(state: TuiState, width: number): string {
  if (state.confirm) return paint(fit(state.confirm.prompt, width), YELLOW_BOLD);

  if (state.screen === 'artifacts') {
    if (state.scope) {
      const entry = currentProjectEntry(state);
      if (!entry) return fit(`project: ${state.scope}`, width);
      const prefix = state.marked.has(entry.absolutePath) ? '[marked] ' : '';
      return fit(
        `${prefix}${tilde(entry.absolutePath)}  ${entry.label}  ${entry.safetyLevel}/${entry.recommendedAction}  ${formatBytes(entry.sizeBytes)} in ${entry.fileCount} files`,
        width,
      );
    }
    const record = currentArtifact(state);
    if (!record) return '';
    const prefix = state.marked.has(record.absolutePath) ? '[marked] ' : '';
    return fit(
      `${prefix}${tilde(record.absolutePath)}  ${record.description}  ${formatBytes(record.sizeBytes)} in ${record.fileCount} files`,
      width,
    );
  }

  if (state.screen === 'skills') {
    const skill = currentSkill(state);
    if (!skill) return '';
    const issues = skill.issues.map((issue) => `${issue.severity}: ${issue.message}`).join('; ');
    const mechanism = skill.toggleMechanism ? ` via ${skill.toggleMechanism}` : '';
    return fit(`${tilde(skill.directory)}${mechanism}${issues ? `  ${issues}` : ''}`, width);
  }

  const server = currentServer(state);
  if (!server) return '';
  return fit(`${tilde(server.source)}  ${server.statusMessage}`, width);
}

/** Absolute path of the selected row, kept on its own line. */
function pathLine(state: TuiState, width: number): string {
  if (state.confirm) return '';

  if (state.screen === 'artifacts') {
    if (state.scope) {
      const entry = currentProjectEntry(state);
      return entry ? fitMiddle(entry.absolutePath, width) : fitMiddle(`project: ${state.scope}`, width);
    }
    const record = currentArtifact(state);
    return record ? fitMiddle(record.absolutePath, width) : '';
  }

  if (state.screen === 'skills') {
    const skill = currentSkill(state);
    return skill ? fitMiddle(skill.directory, width) : '';
  }

  const server = currentServer(state);
  if (!server) return '';
  const source = server.source.replace(/^[a-z]+:/, '');
  return fitMiddle(`${source}  ${server.statusMessage}`, width);
}

function helpFor(state: TuiState): string {
  if (state.filterInput !== null) return 'type to filter  enter apply  esc cancel';
  if (state.confirm) return 'y confirm  n cancel';
  if (state.screen === 'artifacts') {
    return state.scope
      ? 'space mark  c clean  C all  u caution  s scope  / filter  q quit'
      : 'space mark  c clean  C all safe  u caution  s scope  / filter  q quit';
  }
  if (state.screen === 'skills') return 'd toggle  x remove  i issues  / filter  r reload  1-3 tabs  q quit';
  return 'p probe  r reload  / filter  1-3 tabs  q quit';
}

function renderPicker(state: TuiState, width: number, height: number): string[] {
  const picker = state.picker;
  const options = [
    'Home-wide (all agents)',
    `Current directory: ${process.cwd()}`,
    'Type a path…',
  ];
  const lines: string[] = [paint('choose scope', BOLD), ''];

  if (picker?.input != null) {
    lines.push(fit(`  path: ${picker.input}▏`, width));
    if (picker.error) lines.push(paint(`  ${picker.error}`, RED));
    lines.push(paint('  enter load  esc back', DIM));
  } else {
    options.forEach((option, index) => {
      const marker = picker && index === picker.cursor ? '›' : ' ';
      lines.push(fit(`${marker} ${index + 1} ${option}`, width));
    });
    lines.push('');
    lines.push(paint('  home-wide scans every agent; a project shows only that directory', DIM));
    lines.push(paint('  up/down move  enter select  1-3 jump  esc cancel  q quit', DIM));
  }

  while (lines.length < height) lines.push('');
  return lines.slice(0, height);
}

function statusLine(state: TuiState, width: number): string {
  if (state.confirm) {
    const help = 'y confirm  n cancel';
    return fit(`${' '.repeat(Math.max(1, width - help.length))}${help}`, width);
  }

  const left = state.filterInput !== null
    ? `${state.status}  filter: ${state.filterInput}▏`
    : state.status;
  const help = helpFor(state);
  const space = Math.max(1, width - left.length - help.length);
  return fit(`${left}${' '.repeat(space)}${help}`, width);
}

/** Render one full frame, padded to the terminal height. */
export function renderFrame(state: TuiState, width: number, height: number): string[] {
  const safeWidth = Math.max(20, width);
  const safeHeight = Math.max(5, height);

  if (state.picker) return renderPicker(state, safeWidth, safeHeight);

  const bodyHeight = safeHeight - 5;
  const columns = columnsFor(state);
  const fixed = columns.reduce((sum, column) => sum + column.width + 2, 0);
  const pathWidth = Math.max(10, safeWidth - fixed - 2);

  const columnHeader = `   ${columns.map((column) => pad(column.header, column.width)).join('  ')}  PATH`;
  const rows = rowCells(state);
  const cursor = cursorIndex(state);
  const start = Math.max(
    0,
    Math.min(cursor - bodyHeight + 1, Math.max(0, rows.length - bodyHeight)),
  );
  const visible = rows.slice(start, start + bodyHeight);

  const body: string[] = [];
  if (rows.length === 0) {
    const message = state.filterInput !== null ? '' : 'no rows';
    body.push(paint(fit(`  ${message}`, safeWidth), DIM));
  }

  const isArtifactsScreen = state.screen === 'artifacts';
  const visibleItems = isArtifactsScreen
    ? (state.scope ? visibleProjectEntries(state) : visibleArtifacts(state))
    : [];

  visible.forEach((cells, index) => {
    const absolute = start + index;
    const isSelected = absolute === cursor;
    const item = isArtifactsScreen ? visibleItems[absolute] : undefined;
    const isItemMarked = item ? state.marked.has(item.absolutePath) : false;

    const cursorMarker = isSelected ? '›' : ' ';
    const markMarker = isItemMarked ? '*' : ' ';
    const marker = `${cursorMarker}${markMarker}`;

    const cellsText = cells
      .slice(0, columns.length)
      .map((cell, columnIndex) => pad(cell, columns[columnIndex]?.width ?? 0))
      .join('  ');
    const path = pad(cells[columns.length] ?? '', pathWidth);
    const line = fit(`${marker} ${cellsText}  ${path}`, safeWidth);

    if (isItemMarked && isSelected) {
      body.push(paint(line, `${INVERSE}${CYAN_BOLD}`));
    } else if (isItemMarked) {
      body.push(paint(line, CYAN));
    } else if (isSelected) {
      body.push(paint(line, INVERSE));
    } else {
      body.push(line);
    }
  });

  while (body.length < bodyHeight) body.push('');

  const status = statusLine(state, safeWidth);

  return [
    headerLine(state, safeWidth),
    paint(fit(columnHeader, safeWidth), DIM),
    ...body,
    detailLine(state, safeWidth),
    paint(pathLine(state, safeWidth), DIM),
    state.error ? paint(status, RED) : paint(status, DIM),
  ];
}
