import { readFileSync } from 'node:fs';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseConfig } from './config.js';

/**
 * ADR-0010: Ollama has no authentication and SearXNG is an open search proxy,
 * so nothing may be published beyond loopback. Without this test, one edit to
 * compose.yaml could expose a service on every interface with CI still green.
 * The file is parsed as YAML, so comments, quoting, flow lists and anchors
 * cannot hide an entry.
 */
const portSchema = z.union([
  z.string(),
  z.number(),
  z.looseObject({ host_ip: z.string().optional() }),
]);
const composeSchema = z.object({
  services: z.record(
    z.string(),
    z.looseObject({
      ports: z.array(portSchema).optional(),
      network_mode: z.string().optional(),
    }),
  ),
});

/**
 * js-yaml keeps a merge key (`<<: *anchor`) as a literal property while Compose
 * expands it, so a port inherited that way would be invisible here. Any merge
 * key anywhere fails the check instead.
 */
function hasMergeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasMergeKey);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, inner]) => key === '<<' || hasMergeKey(inner));
  }
  return false;
}

/** Every reason the Compose file would expose something beyond loopback. */
function exposures(yaml: string): string[] {
  const loaded: unknown = load(yaml);
  if (hasMergeKey(loaded)) return ['merge key: write ports out in full'];
  const compose = composeSchema.parse(loaded);
  const problems: string[] = [];
  for (const [name, service] of Object.entries(compose.services)) {
    if (service.network_mode === 'host') problems.push(`${name}: network_mode host`);
    for (const port of service.ports ?? []) {
      if (typeof port === 'object') {
        if (port.host_ip !== '127.0.0.1')
          problems.push(`${name}: host_ip ${port.host_ip ?? 'unset'}`);
      } else if (!String(port).startsWith('127.0.0.1:')) {
        problems.push(`${name}: ${String(port)}`);
      }
    }
  }
  return problems;
}

describe('process topology', () => {
  it('publishes nothing in compose.yaml beyond 127.0.0.1', () => {
    const compose = readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8');
    expect(exposures(compose)).toEqual([]);
  });

  it.each([
    ["services:\n  a:\n    ports: # web\n      - '8888:8080'\n", ['a: 8888:8080']],
    ["services:\n  a:\n    ports: [\n      '8888:8080'\n      ]\n", ['a: 8888:8080']],
    ["services:\n  a:\n    'ports':\n      - '0.0.0.0:1:2'\n", ['a: 0.0.0.0:1:2']],
    ["x: &p ['9:9']\nservices:\n  a:\n    ports: *p\n", ['a: 9:9']],
    [
      'x: &s\n  ports: ["0.0.0.0:1:1"]\nservices:\n  a:\n    <<: *s\n',
      ['merge key: write ports out in full'],
    ],
    ['services:\n  a:\n    network_mode: host\n', ['a: network_mode host']],
    ['services:\n  a:\n    ports:\n      - 8080\n', ['a: 8080']],
    [
      'services:\n  a:\n    ports:\n      - target: 8080\n        published: 8888\n',
      ['a: host_ip unset'],
    ],
  ])('catches an exposed port in %j', (yaml, expected) => {
    expect(exposures(yaml)).toEqual(expected);
  });

  it('fails closed on a file it cannot parse', () => {
    expect(() => exposures("services:\n  a:\n    ports: [\n  '8888:8080'\n")).toThrow();
  });

  it('accepts loopback in both syntaxes', () => {
    expect(
      exposures(
        "services:\n  a:\n    ports:\n      - '127.0.0.1:1:2'\n      - target: 1\n        host_ip: 127.0.0.1\n",
      ),
    ).toEqual([]);
  });

  it('binds the API to loopback by default', () => {
    expect(parseConfig({}).host).toBe('127.0.0.1');
  });
});
