import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseConfig } from './config.js';

/**
 * ADR-0010: Ollama has no authentication and SearXNG is an open search proxy,
 * so nothing may be published beyond loopback. One edit to a ports entry would
 * otherwise expose a service on every interface with CI still green.
 */
function composePorts(yaml: string): string[] {
  const ports: string[] = [];
  let portsIndent: number | undefined;
  for (const line of yaml.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (portsIndent !== undefined && indent <= portsIndent) portsIndent = undefined;
    if (/^\s*ports:\s*$/.test(line)) {
      portsIndent = indent;
      continue;
    }
    if (portsIndent !== undefined) {
      const item = /^\s*-\s*['"]?([^'"#]+)['"]?/.exec(line);
      if (item?.[1] !== undefined) ports.push(item[1].trim());
    }
    // Inline lists such as `ports: ['8888:8080']` count too.
    const inline = /^\s*ports:\s*\[(.*)\]/.exec(line);
    if (inline?.[1] !== undefined) {
      ports.push(...inline[1].split(',').map((p) => p.replace(/['"\s]/g, '')));
    }
  }
  return ports;
}

describe('process topology', () => {
  const compose = readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8');

  it('publishes every Compose port on 127.0.0.1 only', () => {
    const ports = composePorts(compose);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port, port).toMatch(/^127\.0\.0\.1:/);
  });

  it('reads both list styles, so the check cannot be sidestepped by formatting', () => {
    expect(composePorts("    ports:\n      - '8888:8080'\n")).toEqual(['8888:8080']);
    expect(composePorts("    ports: ['0.0.0.0:1:2']\n")).toEqual(['0.0.0.0:1:2']);
  });

  it('binds the API to loopback by default', () => {
    expect(parseConfig({}).host).toBe('127.0.0.1');
  });
});
