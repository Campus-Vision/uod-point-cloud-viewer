import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSurveyColour } from '../src/colour.js';

test('8-bit scan RGB survives normalised 16-bit rendering without turning black', () => {
  const input = new Uint16Array([0, 1, 128, 255]);
  expandSurveyColour(input);
  assert.deepEqual([...input], [0, 257, 32896, 65535]);
  assert.equal(input[2] / 65535, 128 / 255);
});
