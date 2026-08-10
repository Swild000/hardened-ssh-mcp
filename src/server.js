import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSshTool } from './tools/ssh-tool.js';

// CRITICAL: stdout is reserved for JSON-RPC (MCP protocol traffic) - all
// logging must go to stderr.
const log = (message) => {
  console.error(`[hardened-ssh-mcp] ${message}`);
};

log('Starting hardened SSH-only MCP server...');

const server = new McpServer({
  name: 'hardened-ssh-mcp',
  version: '1.0.0',
});

registerSshTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);

log('Ready. Only tool exposed: run-ssh-command.');

process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error.message}`);
});
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`);
});
