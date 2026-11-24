import { cleanArtifacts, cleanProjectEntries } from '../cleaner';
import { checkMcpServers, discoverMcpServers } from '../mcp';
import { scanArtifacts } from '../scanner';
import { scanProject } from '../projects';
import { discoverSkills, removeSkill, setSkillEnabled } from '../skills';
import {
  applyEvent,
  initialTuiState,
  type Effect,
  type Screen,
  type TuiEvent,
  type TuiState,
} from './model';
import { renderFrame } from './view';

const ALTERNATE_SCREEN_ON = '\x1b[?1049h\x1b[?25l';
const ALTERNATE_SCREEN_OFF = '\x1b[?25h\x1b[?1049l';

const SEQUENCES: Record<string, string> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[5~': 'pgup',
  '\x1b[6~': 'pgdn',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
};

/** Split a raw stdin chunk into key tokens. */
export function parseKeys(chunk: string): string[] {
  const chars = Array.from(chunk);
  const keys: string[] = [];
  let index = 0;

  while (index < chars.length) {
    const char = chars[index] ?? '';

    if (char === '\x1b') {
      const rest = chars.slice(index, index + 4).join('');
      const match = Object.keys(SEQUENCES).find((sequence) => rest.startsWith(sequence));
      if (match) {
        keys.push(SEQUENCES[match] ?? 'esc');
        index += match.length;
        continue;
      }
      keys.push('esc');
      index += 1;
      continue;
    }

    if (char === '\r' || char === '\n') keys.push('enter');
    else if (char === '\t') keys.push('tab');
    else if (char === '\x7f' || char === '\b') keys.push('backspace');
    else if (char === '\x03') keys.push('ctrl-c');
    else keys.push(char);

    index += 1;
  }

  return keys;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function effectScreen(effect: Effect): Screen {
  switch (effect.type) {
    case 'loadSkills':
    case 'toggleSkill':
    case 'removeSkill':
      return 'skills';
    case 'loadMcp':
      return 'mcp';
    default:
      return 'artifacts';
  }
}

/** Run the interactive terminal UI. */
export async function runTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('the tui needs an interactive terminal');
  }

  let state: TuiState = initialTuiState;
  const pending = new Set<string>();
  let finished = false;
  let ticker: NodeJS.Timeout | undefined;

  const write = (text: string) => process.stdout.write(text);

  const draw = () => {
    if (finished) return;
    const width = process.stdout.columns ?? 100;
    const height = process.stdout.rows ?? 30;
    const frame = renderFrame(state, width, height);
    write(`\x1b[H${frame.map((line) => `${line}\x1b[K`).join('\n')}\x1b[0J`);
  };

  const dispatch = (event: TuiEvent) => {
    const result = applyEvent(state, event);
    state = result.state;
    draw();
    for (const effect of result.effects) void runEffect(effect);
  };

  const runEffect = async (effect: Effect) => {
    const key = effect.type === 'loadSkills' ? `loadSkills:${effect.cwd ?? ''}` : effect.type;
    if (pending.has(key)) return;
    if (effect.type === 'quit') {
      finish();
      return;
    }

    pending.add(key);
    try {
      switch (effect.type) {
        case 'loadArtifacts':
          dispatch({ type: 'busy', screen: 'artifacts', busy: true });
          dispatch({
            type: 'artifacts',
            records: await scanArtifacts(),
            announce: effect.announce === true,
          });
          break;
        case 'loadSkills':
          dispatch({ type: 'busy', screen: 'skills', busy: true });
          dispatch({
            type: 'skills',
            records: await discoverSkills(effect.cwd ?? process.cwd()),
            announce: effect.announce === true,
          });
          break;
        case 'loadMcp': {
          dispatch({ type: 'busy', screen: 'mcp', busy: true });
          const discovery = await discoverMcpServers();
          const statuses = await checkMcpServers(discovery.servers, { probe: effect.probe });
          dispatch({
            type: 'mcp',
            data: { statuses, configFiles: discovery.configFiles },
            announce: effect.announce === true,
          });
          break;
        }
        case 'loadProject': {
          dispatch({ type: 'projectBusy', busy: true });
          const scan = await scanProject(effect.path);
          dispatch({
            type: 'project',
            entries: scan.entries,
            announce: effect.announce === true,
          });
          break;
        }
        case 'cleanProject': {
          const results = await cleanProjectEntries(effect.entries, {
            projectRoot: effect.project,
            dryRun: false,
            safetyLevels: effect.safetyLevels,
          });
          const freed = results.reduce((sum, result) => sum + result.bytesFreed, 0);
          const failed = results.filter((result) => result.error);
          dispatch({
            type: 'status',
            message: failed.length > 0
              ? `clean failed: ${failed[0]?.error ?? 'unknown error'}`
              : `freed ${formatBytes(freed)}`,
          });
          await runEffect({ type: 'loadProject', path: effect.project });
          break;
        }
        case 'clean': {
          const results = await cleanArtifacts(effect.records, {
            dryRun: false,
            safetyLevels: effect.safetyLevels,
          });
          const freed = results.reduce((sum, result) => sum + result.bytesFreed, 0);
          const failed = results.filter((result) => result.error);
          dispatch({
            type: 'status',
            message: failed.length > 0
              ? `clean failed: ${failed[0]?.error ?? 'unknown error'}`
              : `freed ${formatBytes(freed)}`,
          });
          await runEffect({ type: 'loadArtifacts' });
          break;
        }
        case 'toggleSkill': {
          const outcome = await setSkillEnabled(effect.skill, effect.enabled);
          dispatch({ type: 'status', message: `${effect.skill.name}: ${outcome.message}` });
          await runEffect({ type: 'loadSkills', cwd: state.scope ?? undefined });
          break;
        }
        case 'removeSkill': {
          const outcome = await removeSkill(effect.skill, false);
          dispatch({
            type: 'status',
            message: outcome.error
              ? `remove failed: ${outcome.error}`
              : `removed ${effect.skill.name} from ${effect.skill.scope}`,
          });
          await runEffect({ type: 'loadSkills', cwd: state.scope ?? undefined });
          break;
        }
      }
    } catch (error) {
      dispatch({ type: 'error', message: describeError(error) });
      if (effect.type === 'loadProject') dispatch({ type: 'projectBusy', busy: false });
      else dispatch({ type: 'busy', screen: effectScreen(effect), busy: false });
    } finally {
      pending.delete(key);
      draw();
    }
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(ticker);
    process.stdin.off('data', onData);
    process.stdout.off('resize', draw);
    try {
      process.stdin.setRawMode(false);
    } catch {
      // terminal already detached
    }
    process.stdin.pause();
    write(`${ALTERNATE_SCREEN_OFF}\x1b[?25h`);
  };

  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const key of parseKeys(text)) {
      if (finished) return;
      dispatch({ type: 'key', key });
    }
  };

  write(ALTERNATE_SCREEN_ON);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.stdout.on('resize', draw);

  process.once('SIGINT', finish);
  process.once('SIGTERM', finish);

  ticker = setInterval(() => {
    if (state.artifactsBusy || state.projectBusy || state.skillsBusy || state.mcpBusy) draw();
  }, 150);

  draw();
  dispatch({ type: 'openScope' });
  void runEffect({ type: 'loadArtifacts', announce: true });
  void runEffect({ type: 'loadSkills', announce: true });
  void runEffect({ type: 'loadMcp', probe: true, announce: true });

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (finished) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}
