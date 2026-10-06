import defaults from './gate-thresholds.json';

export function gateThreshold(name: keyof typeof defaults): number {
  const value = Number(process.env[name] || defaults[name]);
  if (!Number.isFinite(value) || value < 0 || (name !== 'PROBE_TOLERANCE' && value > 1)
    || ((name === 'PROBE_TOLERANCE' || name === 'GATE_STRICT') && !Number.isInteger(value))) {
    throw new Error(`${name}: invalid threshold`);
  }
  return value;
}
