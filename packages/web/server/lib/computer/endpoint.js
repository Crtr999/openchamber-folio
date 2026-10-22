/**
 * Where the agent's computer is.
 *
 * Open Carter does not own a computer of its own. When a tool brings one —
 * the CarterBot computer is the one this build ships with — that tool's MCP
 * server is already configured, and its address is where that computer's
 * control centre lives. The access key is in the same configuration, usually
 * written as a `{file:...}` reference so it never appears in a file the user
 * might share or paste into a chat.
 *
 * This module finds that server, resolves the key, and hands back the two
 * things the app needs: the address to show, and the credential to show it
 * with. The credential never reaches the renderer — it is used for the
 * server's own calls, and it is handed to the browser panel as a cookie.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readConfigLayers } from '../opencode/shared.js';

const FILE_REFERENCE = /^\{file:(.+)\}$/i;
const LOCAL_ADDRESS = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i;
const VALID_SCREEN_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

/** `{file:~/path}` → the file's contents, trimmed. */
const resolveFileReference = (value, { homedir, readFile }) => {
  const match = typeof value === 'string' ? value.trim().match(FILE_REFERENCE) : null;
  if (!match) return null;
  let target = match[1].trim();
  if (!target) return null;
  if (target === '~') target = homedir;
  else if (target.startsWith('~/')) target = path.join(homedir, target.slice(2));
  try {
    return readFile(target, 'utf8').trim();
  } catch {
    return null;
  }
};

/**
 * The computer's address and key, or null when no computer is configured.
 *
 * The server that brings a computer is a remote one on this machine: the
 * agent talks to it over MCP, and the same host serves the screen.
 */
export const resolveComputerEndpoint = (options = {}) => {
  const {
    workingDirectory = null,
    homedir = os.homedir(),
    readFile = (target) => fs.readFileSync(target, 'utf8'),
    readLayers = readConfigLayers,
  } = options;

  let config = {};
  try {
    config = readLayers(workingDirectory).mergedConfig ?? {};
  } catch {
    return null;
  }

  const mcp = isRecord(config.mcp) ? config.mcp : {};
  // OpenCode 2 keeps servers under `mcp.servers`; v1 kept them in `mcp`.
  const servers = { ...mcp, ...(isRecord(mcp.servers) ? mcp.servers : {}) };
  const entries = Object.entries(servers).filter(([, server]) => isRecord(server) && typeof server.url === 'string');
  const named = entries.find(([name]) => /^carterbot$/i.test(name));
  const candidates = named ? [named] : entries.filter(([, server]) => LOCAL_ADDRESS.test(String(server.url)));
  const chosen = candidates[0];
  if (!chosen) return null;

  const [name, server] = chosen;
  const url = asNonEmptyString(server.url);
  if (!url) return null;
  // The MCP endpoint is `/mcp`; the control centre is the host itself.
  const baseUrl = url.replace(/\/mcp\/?$/i, '').replace(/\/+$/, '');
  if (!baseUrl) return null;

  const headers = isRecord(server.headers) ? server.headers : {};
  const authorization = asNonEmptyString(headers.Authorization ?? headers.authorization);
  if (!authorization) return null;
  const credential = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!credential) return null;
  const token = resolveFileReference(credential, { homedir, readFile }) ?? credential;
  if (!token) return null;

  return { name, baseUrl, token };
};

/**
 * What the computer is doing right now: which screens are open.
 *
 * A failure is an ordinary answer here — the computer may not be running — so
 * it is reported as "not available" rather than raised.
 */
export const fetchComputerState = async (endpoint, { fetchImpl = fetch, timeoutMs = 5_000 } = {}) => {
  if (!endpoint?.baseUrl) return { available: false, screens: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint.baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      signal: controller.signal,
    });
    if (!response.ok) return { available: false, screens: [] };
    const payload = await response.json();
    const screens = Array.isArray(payload?.screens)
      ? payload.screens
        .filter((screen) => typeof screen?.name === 'string' && screen.name.trim())
        .map((screen) => ({ name: screen.name.trim(), since: typeof screen?.since === 'string' ? screen.since : '' }))
      : [];
    return { available: true, screens };
  } catch {
    return { available: false, screens: [] };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Syncs clipboard text to a screen on the computer and optionally pastes it
 * (`Ctrl+V`) into the currently focused element on that screen.
 *
 * Uses `/api/screen/clipboard` when the computer server provides it, and falls
 * back to the computer's `/mcp` `run` tool (`xclip` + `xdotool`) so existing
 * running containers work without requiring a container rebuild first.
 */
export const sendComputerClipboard = async (
  endpoint,
  { screen, text, paste = false } = {},
  { fetchImpl = fetch, timeoutMs = 5_000 } = {},
) => {
  if (!endpoint?.baseUrl || !endpoint?.token) return { ok: false };
  const screenName = typeof screen === 'string' ? screen.trim() : '';
  if (!VALID_SCREEN_NAME.test(screenName)) return { ok: false };
  if (typeof text !== 'string') return { ok: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const direct = await fetchImpl(`${endpoint.baseUrl}/api/screen/clipboard`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: screenName, text, paste: Boolean(paste) }),
      signal: controller.signal,
    }).catch(() => null);

    if (direct && direct.ok) {
      return { ok: true };
    }

    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const pasteFlag = paste ? '1' : '0';
    const command = [
      `port=$(awk -F: '$1 == "${screenName}" { gsub(/[^0-9]/, "", $3); print $3 }' /data/vnc-tokens/tokens 2>/dev/null | tail -n 1)`,
      'if [ -z "$port" ]; then exit 1; fi',
      'disp=":$((port - 5900))"',
      `printf '%s' '${b64}' | base64 -d | DISPLAY="$disp" xclip -selection clipboard -i >/dev/null 2>&1`,
      `printf '%s' '${b64}' | base64 -d | DISPLAY="$disp" xclip -selection primary -i >/dev/null 2>&1`,
      `if [ "${pasteFlag}" = "1" ]; then`,
      '  DISPLAY="$disp" xdotool keyup Super_L Super_R Meta_L Meta_R Control_L Control_R Alt_L Alt_R Shift_L Shift_R >/dev/null 2>&1 || true',
      '  DISPLAY="$disp" xdotool key --clearmodifiers ctrl+v >/dev/null 2>&1',
      'fi',
    ].join('\n');

    const mcpResponse = await fetchImpl(`${endpoint.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'run',
          arguments: { command, timeout_s: 5 },
        },
      }),
      signal: controller.signal,
    });
    return { ok: mcpResponse.ok };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
};
