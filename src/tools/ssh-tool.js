import { z } from 'zod';
import { spawn } from 'node:child_process';
import { logCommand } from '../log.js';

// ---------------------------------------------------------------------------
// CONFIGURATION - all read from environment variables, set in the "env"
// block of this server's entry in your MCP client's config (e.g. Claude
// Desktop's claude_desktop_config.json). Nothing here is a tool parameter -
// the model cannot choose or change the host, user, or identity file. That
// is the entire point of this project versus general-purpose "run any
// command" MCP tools: the target is fixed by whoever deploys the server,
// not by the model at runtime.
//
// Required:
//   SSH_USER              - the remote username to connect as
//   SSH_HOST              - the remote host (IP or hostname)
//   SSH_IDENTITY_FILE      - absolute path to your private key
//
// Optional:
//   SSH_KNOWN_HOSTS_FILE   - defaults to your normal ~/.ssh/known_hosts
//   SSH_EXECUTABLE         - defaults to "ssh" (resolved via PATH)
//   SSH_HOME               - only needed in the Windows edge case below
//   SSH_CONNECT_TIMEOUT_SECONDS (default 10)
//   SSH_COMMAND_TIMEOUT_MS       (default 30000)
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This server requires SSH_USER, SSH_HOST, and SSH_IDENTITY_FILE to be set as ` +
        'environment variables - see the "env" block in the README\'s example config.'
    );
  }
  return value;
}

const SSH_USER = requireEnv('SSH_USER');
const SSH_HOST = requireEnv('SSH_HOST');
const SSH_IDENTITY_FILE = requireEnv('SSH_IDENTITY_FILE');
const SSH_KNOWN_HOSTS_FILE = process.env.SSH_KNOWN_HOSTS_FILE || '';
const SSH_EXECUTABLE = process.env.SSH_EXECUTABLE || 'ssh';
const SSH_HOME = process.env.SSH_HOME || '';
const SSH_CONNECT_TIMEOUT_SECONDS = Number(process.env.SSH_CONNECT_TIMEOUT_SECONDS || 10);
const COMMAND_TIMEOUT_MS = Number(process.env.SSH_COMMAND_TIMEOUT_MS || 30_000);

function runSsh(remoteCommand) {
  return new Promise((resolve) => {
    const args = [
      '-i', SSH_IDENTITY_FILE,
      '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
      // Never hang waiting for an interactive password/passphrase prompt -
      // there is no terminal attached to answer one. If key auth fails,
      // fail fast instead of hanging the whole MCP server.
      '-o', 'BatchMode=yes',
      // Trust-on-first-use, then pinned like normal SSH - not blanket
      // "never verify" (which would silently accept a MITM'd host key
      // every single time).
      '-o', 'StrictHostKeyChecking=accept-new',
      ...(SSH_KNOWN_HOSTS_FILE
        ? [
            // Quoted: ssh's own -o value parser splits on whitespace unless
            // quoted, which matters if your path contains spaces (common on
            // Windows, e.g. "C:\Users\Jane Doe\.ssh\known_hosts").
            '-o', `UserKnownHostsFile="${SSH_KNOWN_HOSTS_FILE}"`,
          ]
        : []),
      `${SSH_USER}@${SSH_HOST}`,
      remoteCommand,
    ];

    const spawnEnv = SSH_HOME ? { ...process.env, HOME: SSH_HOME } : process.env;

    // spawn (not exec/shell:true) so the argument array is passed straight
    // through - no shell re-interprets or re-splits any of this.
    const startedAt = Date.now();
    const child = spawn(SSH_EXECUTABLE, args, { shell: false, windowsHide: true, env: spawnEnv });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, COMMAND_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ timedOut, exitCode: code, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        timedOut: false,
        exitCode: null,
        stdout,
        stderr: stderr || `Failed to launch "${SSH_EXECUTABLE}": ${err.message}`,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

export function registerSshTool(server) {
  server.tool(
    'run-ssh-command',
    `Run exactly one command over SSH on the fixed target ${SSH_USER}@${SSH_HOST} and nothing else. This tool ` +
      'cannot reach any other host, cannot run local commands, and cannot touch the local filesystem directly - ' +
      'the only thing it can ever do is relay one command over SSH to that one account on that one machine, which ' +
      'is fixed by whoever deployed this server, not something you (the model) can choose. ' +
      'Standing rule: always show the user the exact command in chat and get their explicit go-ahead BEFORE ' +
      'calling this tool. Call it with confirmed=false (or omit confirmed) to preview what would run without ' +
      'executing anything. Only call it with confirmed=true after the user has approved this specific command in ' +
      'this specific turn - never assume consent from an earlier, different command.',
    {
      command: z.string().min(1).describe('The exact shell command to run on the remote host, over SSH.'),
      confirmed: z
        .boolean()
        .default(false)
        .describe(
          'Must be explicitly set to true to actually execute. Leave false/omit to preview the command without ' +
            'running it. Only set true after the user has seen this exact command and approved it in chat.'
        ),
    },
    async ({ command, confirmed }) => {
      if (!confirmed) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Not executed (confirmed=false/omitted).\n\n` +
                `Command that would run on ${SSH_USER}@${SSH_HOST}:\n${command}\n\n` +
                'Show this exact command to the user; only re-call this tool with confirmed=true once they have explicitly approved it.',
            },
          ],
          isError: true,
        };
      }

      const result = await runSsh(command);
      logCommand({ command, exitCode: result.exitCode, timedOut: result.timedOut });

      if (result.timedOut) {
        return {
          content: [
            {
              type: 'text',
              text:
                `SSH command timed out after ${COMMAND_TIMEOUT_MS / 1000}s and was killed.\n\n` +
                `Command: ${command}\nPartial stdout:\n${result.stdout}\nPartial stderr:\n${result.stderr}`,
            },
          ],
          isError: true,
        };
      }

      const text =
        `Exit code: ${result.exitCode}\n\nstdout:\n${result.stdout || '(empty)'}\n\nstderr:\n${result.stderr || '(empty)'}\n\n` +
        `elapsed: ${result.elapsedMs}ms`;

      return {
        content: [{ type: 'text', text }],
        isError: result.exitCode !== 0,
      };
    }
  );
}
