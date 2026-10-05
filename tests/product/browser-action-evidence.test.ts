import { describe, expect, it } from 'vitest';
import { captureHumanActionExchange, selectLatestHumanActionExchange } from '../browser/run.js';

const request = { requestId: 'request-1', turnId: 'table-1:hand-1:2:0', expectedVersion: 2, actionId: 'opaque-action-1' };

describe('passive browser canonical request evidence', () => {
  it('retains request identity before a response arrives', () => {
    const result = captureHumanActionExchange('table-1', request, null);
    expect(result.request).toEqual(request);
    expect(result.status).toBeNull();
    expect(result.captureError).toBeNull();
  });
  it('retains the exact rejected request, not an older accepted action', () => {
    const result = captureHumanActionExchange('table-1', request, 409);
    expect(result.request?.requestId).toBe('request-1');
    expect(result.status).toBe(409);
  });
  it('does not let a late response replace a newer unacknowledged request', () => {
    const older = captureHumanActionExchange('table-1', request, 200, 1);
    const newer = captureHumanActionExchange('table-1', { ...request, requestId: 'request-2' }, null, 2);
    expect(selectLatestHumanActionExchange(newer, older)).toBe(newer);
    const rejected = captureHumanActionExchange('table-1', { ...request, requestId: 'request-2' }, 409, 2);
    expect(selectLatestHumanActionExchange(newer, rejected)).toBe(rejected);
    expect(selectLatestHumanActionExchange(rejected, newer)).toBe(rejected);
  });
  it('projects metadata only even when extra private values are supplied', () => {
    const privateValue = 'do-not-retain-private-value';
    const result = captureHumanActionExchange('table-1', { ...request, deck: privateValue, token: privateValue } as typeof request, 200);
    expect(JSON.stringify(result).includes(privateValue)).toBe(false);
    expect(Object.keys(result.request ?? {}).sort()).toEqual(['actionId', 'expectedVersion', 'requestId', 'turnId']);
  });
  it('fails closed without echoing malformed bodies or identifiers', () => {
    const result = captureHumanActionExchange('table-1', { ...request, requestId: 'invalid identifier' }, 400);
    expect(result.request).toBeNull();
    expect(result.captureError).toBe('invalid-canonical-request');
  });
});
