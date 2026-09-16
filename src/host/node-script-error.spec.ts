import { describe, expect, it } from 'vitest';
import { describeNodeScriptError } from './node-script-error';

describe('describeNodeScriptError', () => {
  it("unwraps the host's raw stderr JSON into the inner message", () => {
    const raw = JSON.stringify({
      __error: 'Login failed: [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
    });
    expect(describeNodeScriptError(raw)).toBe(
      'Login failed: [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
    );
  });

  it('passes through a plain string message unchanged', () => {
    expect(describeNodeScriptError('boom')).toBe('boom');
  });

  it('reads message off an error object', () => {
    expect(describeNodeScriptError({ message: 'boom' })).toBe('boom');
  });

  it('falls back to Unknown error when nothing is usable', () => {
    expect(describeNodeScriptError(undefined)).toBe('Unknown error');
    expect(describeNodeScriptError({})).toBe('Unknown error');
  });

  it('leaves JSON alone when it is not the __error shape', () => {
    const raw = JSON.stringify({ foo: 'bar' });
    expect(describeNodeScriptError(raw)).toBe(raw);
  });
});
