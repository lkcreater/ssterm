// Minimal stdio MCP server (newline-delimited JSON-RPC 2.0) used as the test
// "ssterm" server and as the decoy "other" server. Usage:
//   node mcp-server.mjs <name> <eventLogFile> <tokenReturnedByTool>
// Every spawn and every tools/call is appended to the event log, so a test can
// prove whether a CLI started or called this server without trusting the model.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [name, logFile, token] = process.argv.slice(2);
const tool = name === 'ssterm' ? 'ping' : 'lookup';
const log = (event) => appendFileSync(logFile, JSON.stringify({ name, event, at: Date.now() }) + '\n');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

log('spawn');
createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return; // notification
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result });
  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name, version: '0.0.0' },
      });
    case 'tools/list':
      return reply({
        tools: [{
          name: tool,
          description: name === 'ssterm' ? 'Health check. Returns a token.' : 'Looks up a value. Returns a token.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      });
    case 'tools/call':
      log(`call:${req.params?.name}`);
      return reply({ content: [{ type: 'text', text: token }] });
    case 'ping':
      return reply({});
    default:
      return send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
  }
});
