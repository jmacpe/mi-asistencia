import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, combinations, isExam, weekStart } from '../static/model.js';

const course = () => ({ id: 'demo', name: 'Materia de ejemplo', rows: Array.from({length: 8}, (_, i) => ({
  asis_clase_id: String(i + 1), fecha: `2026-10-${String(5 + i * 2).padStart(2, '0')}`,
  cnt_horas_catedras: '2', cnt_horas_asistidas: i < 4 ? '2' : null, asistencia_cargada: i < 4 ? 'S' : 'N'
})), summary: [{tipo_clase: 'GLOBAL', cnt_horas_catedras: '16', porc_asistencia: '50'}] });

test('permite exactamente dos encuentros si se llega al 75%', () => {
  const c = course();
  const result = calculate(c, {}, '2026-10-11');
  assert.equal(result.maxAdditional, 2);
  const planned = c.rows.slice(4, 6).map(r => r.asis_clase_id);
  assert.equal(calculate(c, {planned}, '2026-10-11').maxAdditional, 0);
});

test('todas las combinaciones enteras máximas coinciden con enumeración exhaustiva', () => {
  for (let a = 0; a <= 5; a++) for (let b = 0; b <= 5; b++) for (let budget = 0; budget <= 20; budget++) {
    const groups = [{hours: 2, dates: Array(a)}, {hours: 3, dates: Array(b)}];
    const expected = [];
    for (let x = 0; x <= a; x++) for (let y = 0; y <= b; y++) {
      const cost = x * 2 + y * 3;
      if (x + y && cost <= budget && !(x < a && cost + 2 <= budget) && !(y < b && cost + 3 <= budget)) expected.push(`${x},${y}`);
    }
    assert.deepEqual(combinations(groups, budget).map(x => x.counts.join(',')).sort(), expected.sort());
  }
});

test('los parciales cubren lunes a domingo y no ofrecen esas fechas para faltar', () => {
  assert.equal(weekStart('2026-10-11'), '2026-10-05');
  assert.equal(isExam({fecha:'2026-10-11'}, ['2026-10-05']), true);
  const result = calculate(course(), {}, '2026-10-11', ['2026-10-12']);
  assert.equal(result.future.some(r => isExam(r, ['2026-10-12'])), false);
});

test('una materia sin calendario no inventa un margen de faltas', () => {
  assert.equal(calculate({ rows: [], summary: [] }).available, false);
});
