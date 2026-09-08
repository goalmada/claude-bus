#!/usr/bin/env node
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { projectTools } from './project-tools.js';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tools = projectTools(config.job, config.privateRoot);
const server = new Server({ name: 'scoped-project', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'read_file', description: 'Read an assigned source file; returns content and hash for editing.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false } },
  { name: 'write_file', description: 'Write an assigned file. Supply the hash from read_file, or null for a new file. Cannot overwrite concurrent edits.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' }, expectedHash: { type: ['string', 'null'] } }, required: ['file','content','expectedHash'], additionalProperties: false } },
  { name: 'run_tests', description: 'Run the fixed assigned Node tests with no network and no writes to source or outside the isolated temporary directory.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    if (!Object.hasOwn(tools, request.params.name)) throw new Error('Unknown tool');
    const result = await tools[request.params.name](request.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
