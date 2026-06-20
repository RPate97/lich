import { describe, test, expect } from 'vitest';
import { RealTartCli } from '../../../src/sandbox/tart-cli.js';
import { TartCommandError } from '../../../src/sandbox/errors.js';

describe('RealTartCli', () => {
  test('captures stdout from a successful command', async () => {
    const cli = new RealTartCli('/bin/echo');
    const { stdout } = await cli.run(['hello']);
    expect(stdout.trim()).toBe('hello');
  });

  test('throws TartCommandError on non-zero exit', async () => {
    const cli = new RealTartCli('/bin/sh');
    await expect(cli.run(['-c', 'exit 7'])).rejects.toBeInstanceOf(TartCommandError);
  });

  test('honors timeoutMs', async () => {
    const cli = new RealTartCli('/bin/sleep');
    await expect(cli.run(['10'], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });
});
