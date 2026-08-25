import { describe, expect, test } from 'bun:test';
import { telemetryHeaders, type TelemetryGlobals } from '../../src/shared/telemetry.ts';
import { VERSION } from '../../src/version.ts';

const node = { versions: { node: '22.1.0' }, env: {} };

// Bun, Deno, workerd with nodejs_compat and the Next.js edge sandbox all expose
// process.versions.node, so each case here pins the precedence over that shim.
describe('runtime detection', () => {
  const cases: [string, TelemetryGlobals, string | undefined][] = [
    ['bun', { Bun: { version: '1.3.0' }, process: node }, 'bun@1.3.0'],
    ['deno', { Deno: { version: { deno: '2.1.0' } }, process: node }, 'deno@2.1.0'],
    ['workers', { navigator: { userAgent: 'Cloudflare-Workers' }, process: node }, 'cloudflare-workers'],
    ['edge-light', { EdgeRuntime: 'edge-runtime', process: node }, 'edge-light'],
    ['node', { process: node }, 'node@22.1.0'],
    ['browser', { navigator: { userAgent: 'Mozilla/5.0' } }, 'browser'],
    ['unknown', {}, undefined],
  ];
  for (const [name, globals, expected] of cases) {
    test(name, () => expect(telemetryHeaders(globals)['Upstash-Telemetry-Runtime']).toBe(expected as string));
  }
});

describe('platform detection', () => {
  test('vercel', () => {
    expect(telemetryHeaders({ process: { env: { VERCEL: '1' } } })['Upstash-Telemetry-Platform']).toBe('vercel');
  });

  test('aws', () => {
    expect(telemetryHeaders({ process: { env: { AWS_REGION: 'us-east-1' } } })['Upstash-Telemetry-Platform']).toBe('aws');
  });

  test('a worker binding named AWS_REGION does not make it aws', () => {
    const g = { navigator: { userAgent: 'Cloudflare-Workers' }, process: { env: { AWS_REGION: 'us-east-1' } } };
    expect(telemetryHeaders(g)['Upstash-Telemetry-Platform']).toBe('cloudflare');
  });

  test('no platform header rather than a wrong one', () => {
    expect(telemetryHeaders({ process: node })['Upstash-Telemetry-Platform']).toBeUndefined();
  });
});

describe('telemetryHeaders', () => {
  test('always carries the sdk version', () => {
    expect(telemetryHeaders({})).toEqual({ 'Upstash-Telemetry-Sdk': `upstash-blob-js@${VERSION}` });
    expect(VERSION).toMatch(/^v\d+\.\d+\.\d+/);
  });

  test('UPSTASH_DISABLE_TELEMETRY sends nothing at all', () => {
    expect(telemetryHeaders({ process: { versions: { node: '22.1.0' }, env: { UPSTASH_DISABLE_TELEMETRY: '1' } } })).toEqual({});
  });

  test('a variable that says false and means true is a trap, so falsey spellings leave it on', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off', '', '  ']) {
      expect(telemetryHeaders({ process: { env: { UPSTASH_DISABLE_TELEMETRY: v } } })).toHaveProperty('Upstash-Telemetry-Sdk');
    }
    for (const v of ['1', 'true', 'yes', ' on ']) {
      expect(telemetryHeaders({ process: { env: { UPSTASH_DISABLE_TELEMETRY: v } } })).toEqual({});
    }
  });

  test('vercel wins over aws when both are set', () => {
    expect(telemetryHeaders({ process: { env: { VERCEL: '1', AWS_REGION: 'us-east-1' } } })['Upstash-Telemetry-Platform']).toBe('vercel');
  });

  test('reads the real globalThis by default', () => {
    expect(telemetryHeaders()['Upstash-Telemetry-Runtime']).toStartWith('bun@');
  });
});
