import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'ssh-command-log.txt');

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // if this fails, logCommand's own try/catch below still keeps things safe
}

/**
 * Append-only local audit trail of every command this server actually
 * executed (i.e. every call that had confirmed=true). A logging failure
 * must never block or affect the SSH call itself.
 */
export function logCommand({ command, exitCode, timedOut }) {
  const line = `${new Date().toISOString()}\texit=${exitCode}\ttimedOut=${timedOut}\tcommand=${JSON.stringify(command)}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // never let a logging failure interrupt anything
  }
}
