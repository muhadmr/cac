import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { McpServerConfig, McpServerStatus } from './types';
import { HOME } from './scanner';

const IS_WINDOWS = process.platform === 'win32';

/** Claude and Codex both use this MCP protocol version. */
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'agent-artifact-audit', version: '0.1.0' };

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  const text = await readText(file);
  if (!text) return null;
  try {
    return readJsonFiltered(JSON.parse(text));
  } catch {
    return null;
  }
}

function readJsonFiltered(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Collect `mcpServers` entries from a JSON config file. */
function serversFromJson(
  json: Record<string, unknown> | null,
  source: string,
): McpServerConfig[] {
  const raw = json?.mcpServers ?? json?.context_servers;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  return Object.entries(raw as Record<string, unknown>).flatMap(([name, value]) => {
    if (!value || typeof value !== 'object') return [];
    const entry = value as Record<string, unknown>;
    const url = typeof entry.url === 'string' ? entry.url : undefined;
    const command = typeof entry.command === 'string' ? entry.command : undefined;
    if (!url && !command) return [];

    const declaredType = typeof entry.type === 'string' ? entry.type : undefined;
    const type: McpServerConfig['type'] =
      declaredType === 'sse' || declaredType === 'http'
        ? declaredType
        : url
          ? 'http'
          : 'stdio';

    const rawEnv = readJsonFiltered(entry.env);
    const envEntries = rawEnv
      ? Object.entries(rawEnv).filter((item): item is [string, string] => typeof item[1] === 'string')
      : [];
    const args = Array.isArray(entry.args)
      ? entry.args.filter((item): item is string => typeof item === 'string')
      : undefined;

    return [
      {
        name,
        source,
        type,
        command,
        args,
        env: envEntries.length > 0 ? Object.fromEntries(envEntries) : undefined,
        url,
      },
    ];
  });
}

interface TomlServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

function parseTomlValue(raw: string): string | string[] | boolean {
  const trimmed = raw.trim();
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    const items: string[] = [];
    for (const match of inner.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
      const basic = match[1];
      if (basic !== undefined) {
        try {
          items.push(String(JSON.parse(`"${basic}"`)));
        } catch {
          items.push(basic);
        }
      } else {
        items.push(match[2] ?? '');
      }
    }
    return items;
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Minimal TOML reader for `[mcp_servers.<name>]` tables in Codex config.
 * Only command, args, url, and env are read.
 */
export function parseCodexToml(text: string): TomlServer[] {
  const servers = new Map<string, TomlServer>();
  let section: string[] = [];
  let pendingKey: string | null = null;
  let pendingBuffer = '';

  const flush = () => {
    pendingKey = null;
    pendingBuffer = '';
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (pendingKey) {
      pendingBuffer += ' ' + rawLine.trim();
      if (pendingBuffer.includes(']')) {
        assign(pendingKey, pendingBuffer);
        flush();
      }
      continue;
    }

    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      section = line
        .replace(/^\[+/, '')
        .replace(/\]+$/, '')
        .split('.')
        .map((part) => part.trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    if (section[0] !== 'mcp_servers' || section.length < 2) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (value.startsWith('[') && !value.includes(']')) {
      pendingKey = key;
      pendingBuffer = value;
      continue;
    }

    assign(key, value);
  }

  function assign(key: string, rawValue: string) {
    const name = section[1];
    if (!name) return;
    const server = servers.get(name) ?? { name };
    const parsed = parseTomlValue(rawValue);

    if (section.length === 2) {
      if (key === 'command' && typeof parsed === 'string') server.command = parsed;
      if (key === 'url' && typeof parsed === 'string') server.url = parsed;
      if (key === 'args' && Array.isArray(parsed)) server.args = parsed;
    } else if (section.length === 3 && section[2] === 'env') {
      if (typeof parsed === 'string') {
        server.env = { ...(server.env ?? {}), [key]: parsed };
      }
    }

    servers.set(name, server);
  }

  return [...servers.values()].filter((server) => server.command || server.url);
}

export interface McpDiscovery {
  servers: McpServerConfig[];
  configFiles: Array<{ path: string; found: boolean; serverCount: number }>;
}

/** Read every known MCP config file and return the merged server list. */
export async function discoverMcpServers(): Promise<McpDiscovery> {
  const servers: McpServerConfig[] = [];
  const configFiles: McpDiscovery['configFiles'] = [];

  const jsonSources: Array<{ file: string; label: string }> = [
    { file: path.join(HOME, '.claude.json'), label: 'claude' },
    { file: path.join(HOME, '.claude', 'settings.json'), label: 'claude' },
    { file: path.join(process.cwd(), '.mcp.json'), label: 'project' },
    { file: path.join(HOME, '.pi', 'agent', 'mcp.json'), label: 'pi' },
    { file: path.join(HOME, '.gemini', 'settings.json'), label: 'gemini' },
    { file: path.join(HOME, '.copilot', 'mcp-config.json'), label: 'copilot' },
    { file: path.join(HOME, '.cursor', 'mcp.json'), label: 'cursor' },
    { file: path.join(HOME, '.config', 'zed', 'settings.json'), label: 'zed' },
    { file: path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), label: 'cline' },
    { file: path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'), label: 'roo' },
    { file: path.join(HOME, '.kilocode', 'globalStorage', 'mcp.json'), label: 'kilocode' },
  ];

  for (const { file, label } of jsonSources) {
    const json = await readJson(file);
    const found = json !== null;
    const foundServers = serversFromJson(json, `${label}:${file}`);
    servers.push(...foundServers);
    configFiles.push({ path: file, found, serverCount: foundServers.length });
  }

  const codexConfig = path.join(HOME, '.codex', 'config.toml');
  const codexText = await readText(codexConfig);
  const codexServers = codexText ? parseCodexToml(codexText) : [];
  for (const server of codexServers) {
    servers.push({
      name: server.name,
      source: `codex:${codexConfig}`,
      type: server.url ? 'http' : 'stdio',
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
    });
  }
  configFiles.push({
    path: codexConfig,
    found: codexText !== null,
    serverCount: codexServers.length,
  });

  return { servers, configFiles };
}

function expandHome(value: string): string {
  if (value === '~') return HOME;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(HOME, value.slice(2));
  }
  return value;
}

/** Resolve an executable the way a shell would, honoring PATHEXT on Windows. */
export async function resolveCommand(command: string): Promise<string | null> {
  const expanded = expandHome(command);
  const candidates: string[] = [];

  if (expanded.includes('/') || expanded.includes('\\')) {
    candidates.push(expanded);
  } else {
    const dirs = (process.env.PATH ?? '').split(IS_WINDOWS ? ';' : ':').filter(Boolean);
    const extensions = IS_WINDOWS
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
    for (const dir of dirs) {
      for (const ext of extensions) {
        candidates.push(path.join(dir, expanded + (expanded.toLowerCase().endsWith(ext.toLowerCase()) ? '' : ext)));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

interface ProbeOptions {
  timeoutMs: number;
}

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  },
};

interface ProbeResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

function probeStdio(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const started = Date.now();
  const { promise, resolve } = Promise.withResolvers<ProbeResult>();
  let settled = false;
  let stdout = '';
  let stderr = '';

  const child = spawn(command, args, {
    env: { ...process.env, ...(env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: IS_WINDOWS && /\.(bat|cmd)$/i.test(command),
  });

  const finish = (ok: boolean, message: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      child.kill();
    } catch {
      // already exited
    }
    resolve({ ok, message, latencyMs: Date.now() - started });
  };

  const timer = setTimeout(() => {
    const detail = stderr.trim().split(/\r?\n/).pop() ?? '';
    finish(
      false,
      detail
        ? `no handshake in ${options.timeoutMs}ms: ${detail}`
        : `no handshake in ${options.timeoutMs}ms`,
    );
  }, options.timeoutMs);

  child.on('error', (error) => finish(false, `spawn error: ${error.message}`));

  child.on('exit', (code) => {
    const detail = stderr.trim().split(/\r?\n/).pop() ?? '';
    finish(false, `exited with code ${code}${detail ? `: ${detail}` : ''}`);
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (message.id === 1 && 'result' in message) {
          finish(true, 'MCP handshake ok');
        } else if (message.id === 1 && message.error) {
          finish(false, `handshake error: ${JSON.stringify(message.error)}`);
        }
      } catch {
        // partial line, wait for more
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });

  child.stdin?.on('error', () => {
    // server closed stdin before the request landed; exit handler reports it
  });

  child.stdin?.write(JSON.stringify(INITIALIZE_REQUEST) + '\n');
  return promise;
}

async function probeHttp(url: string, options: ProbeOptions): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(INITIALIZE_REQUEST),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const latencyMs = Date.now() - started;
    const text = await response.text();
    if (response.ok && text.includes('"result"')) {
      return { ok: true, message: `HTTP ${response.status}, handshake ok`, latencyMs };
    }
    if (response.ok) {
      return { ok: true, message: `HTTP ${response.status}`, latencyMs };
    }
    return { ok: false, message: `HTTP ${response.status}`, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, latencyMs };
  }
}

export interface CheckOptions {
  probe?: boolean;
  timeoutMs?: number;
}

interface CheckOutcome {
  available: boolean;
  statusMessage: string;
  latencyMs?: number;
}

async function checkOne(
  server: McpServerConfig,
  probe: boolean,
  timeoutMs: number,
): Promise<CheckOutcome> {
  if (server.type === 'http' || server.type === 'sse') {
    if (!server.url) return { available: false, statusMessage: 'missing url' };
    const result = await probeHttp(server.url, { timeoutMs });
    return { available: result.ok, statusMessage: result.message, latencyMs: result.latencyMs };
  }

  if (!server.command) return { available: false, statusMessage: 'missing command' };

  const resolved = await resolveCommand(server.command);
  if (!resolved) {
    return { available: false, statusMessage: `command not found: ${server.command}` };
  }

  if (!probe) {
    return { available: true, statusMessage: `command found: ${resolved}` };
  }

  const result = await probeStdio(resolved, server.args ?? [], server.env, { timeoutMs });
  return {
    available: result.ok,
    statusMessage: `${result.message} (${resolved})`,
    latencyMs: result.latencyMs,
  };
}

function serverKey(server: McpServerConfig): string {
  return [
    server.type,
    server.url ?? '',
    server.command ?? '',
    JSON.stringify(server.args ?? []),
    JSON.stringify(server.env ?? {}),
  ].join('\u0000');
}

/** Check reachability of every discovered MCP server, probing duplicates once. */
export async function checkMcpServers(
  servers: McpServerConfig[],
  options: CheckOptions = {},
): Promise<McpServerStatus[]> {
  const probe = options.probe ?? true;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const outcomes = new Map<string, Promise<CheckOutcome>>();

  return Promise.all(
    servers.map(async (server) => {
      const key = serverKey(server);
      let outcome = outcomes.get(key);
      if (!outcome) {
        outcome = checkOne(server, probe, timeoutMs);
        outcomes.set(key, outcome);
      }
      const result = await outcome;
      return {
        name: server.name,
        source: server.source,
        type: server.type,
        available: result.available,
        statusMessage: result.statusMessage,
        latencyMs: result.latencyMs,
      };
    }),
  );
}
