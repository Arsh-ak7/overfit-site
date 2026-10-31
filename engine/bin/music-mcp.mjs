#!/usr/bin/env node
/**
 * Synthlings MCP server over stdio, for bring-your-own-agent play.
 * Add it to your MCP client with: node /path/to/spike/bin/music-mcp.mjs
 * See docs/bring-your-own-agent.md.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMusicServer } from '../src/mcp/server.mjs';

const { server } = createMusicServer();
await server.connect(new StdioServerTransport());
