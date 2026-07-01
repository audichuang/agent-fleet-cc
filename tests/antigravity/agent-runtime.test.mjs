// resolveAgyBin resolution — moved to lib/adapter.mjs in the shared-runtime
// migration (agent-runtime.mjs deleted). runAgyPrint/spawnAgyDetached are gone
// (the shared worker owns spawning); only the pure bin-resolution knowledge
// survives here. detectHost / buildPluginInfo are covered by host-detect.test
// and lib-units.test respectively, so they are not re-asserted here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AGY_BIN,
  resolveAgyBin,
} from '../../plugins/antigravity/scripts/lib/adapter.mjs';

describe('resolveAgyBin (adapter)', () => {
  it('returns AGY_BIN env value when it points to an existing file', () => {
    const env = { AGY_BIN: process.execPath, PATH: '' };
    assert.equal(resolveAgyBin(env), process.execPath);
  });

  it('falls back to DEFAULT_AGY_BIN when nothing resolves', () => {
    const env = { PATH: '/nonexistent/dir', HOME: '/also/nonexistent' };
    assert.equal(resolveAgyBin(env), DEFAULT_AGY_BIN);
  });
});
