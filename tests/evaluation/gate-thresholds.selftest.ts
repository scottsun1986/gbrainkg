import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import defaults from './gate-thresholds.json';
import { gateThreshold } from './gate-thresholds';

const names = Object.keys(defaults) as Array<keyof typeof defaults>;
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
try {
  for (const name of names) delete process.env[name];
  const shell = execFileSync('bash', ['-c', 'source tests/evaluation/gate-thresholds.sh && env'], { encoding: 'utf8' });
  for (const name of names) {
    assert.equal(gateThreshold(name), defaults[name]);
    const shellValue = shell.split('\n').find(line => line.startsWith(`${name}=`))?.slice(name.length + 1);
    assert.equal(Number(shellValue), defaults[name], `${name}: shell and direct TypeScript defaults diverged`);
  }
  process.env.GATE_HIT_RATE = '0.99';
  assert.equal(gateThreshold('GATE_HIT_RATE'), 0.99);
  for (const invalid of ['NaN', '-1', 'Infinity', '1.01']) {
    process.env.GATE_HIT_RATE = invalid;
    assert.throws(() => gateThreshold('GATE_HIT_RATE'), /invalid threshold/);
    assert.throws(() => execFileSync('bash', ['-c', 'source tests/evaluation/gate-thresholds.sh'], { stdio: 'ignore' }));
  }
} finally {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
}
console.log('PASS: shared threshold defaults, overrides and invalid configuration');
