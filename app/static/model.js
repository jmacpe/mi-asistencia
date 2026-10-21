export const TODAY_ZONE = 'America/Asuncion';
export function localDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TODAY_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function weekday(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}
export const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export function officialHours(row) {
  if (row.cnt_horas_asistidas === null || row.cnt_horas_asistidas === 'Feriado') return 0;
  const n = Number(row.cnt_horas_asistidas);
  return Number.isFinite(n) ? n : 0;
}
export function weekStart(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
export function weekEnd(iso) {
  const date = new Date(`${weekStart(iso)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 6);
  return date.toISOString().slice(0, 10);
}
export function isExam(row, examWeeks = []) {
  return examWeeks.some(start => start && weekStart(row.fecha) === start);
}
export function rowStatus(row, override, examWeeks = []) {
  if (row.cnt_horas_asistidas === 'Feriado') return 'holiday';
  if (isExam(row, examWeeks)) return 'present';
  if (override) return override.status;
  if (row.asistencia_cargada !== 'S' || row.cnt_horas_asistidas === null) return 'pending';
  if (officialHours(row) === 0) return 'absent';
  return officialHours(row) >= Number(row.cnt_horas_catedras) ? 'present' : 'partial';
}
export function combinations(groups, budget) {
  if (budget < -1e-8) return [];
  const result = [];
  function walk(i, counts, cost) {
    if (i === groups.length) {
      const count = counts.reduce((a, b) => a + b, 0);
      // Only maximal options: no extra class can be added to this combination.
      if (count && !groups.some((g, j) => counts[j] < g.dates.length && cost + g.hours <= budget + 1e-8)) {
        result.push({ counts: [...counts], count, hours: cost });
      }
      return;
    }
    const g = groups[i];
    for (let n = 0; n <= g.dates.length && cost + n * g.hours <= budget + 1e-8; n++) walk(i + 1, [...counts, n], cost + n * g.hours);
  }
  walk(0, [], 0);
  return result.sort((a, b) => b.count - a.count || b.hours - a.hours || a.counts.join().localeCompare(b.counts.join()));
}
export function calculate(course, personal = {}, today = localDate(), examWeeks = []) {
  const overrides = personal.overrides || {};
  const planned = new Set(personal.planned || []);
  const global = course.summary.find(r => r.tipo_clase === 'GLOBAL');
  if (course.error || !global || !course.rows.length || !(Number(global.cnt_horas_catedras) > 0)) {
    return { available: false, error: course.error || 'Todavía no hay asistencia suficiente para calcular.', maxAdditional: null };
  }
  const total = Number(global.cnt_horas_catedras);
  const officialAttended = course.rows.reduce((n, r) => n + officialHours(r), 0);
  const officialCredit = Number(global.porc_asistencia) * total / 100;
  // Reconcile the portal's rounded percentage, including its justified/holiday credit.
  const roundedCredit = Math.round(officialCredit * 100) / 100;
  const integerCredit = Math.round(roundedCredit);
  const credit = Math.abs(integerCredit - roundedCredit) <= total * .000051 ? integerCredit : roundedCredit;
  const adjustment = credit - officialAttended;
  let attended = adjustment, pendingHours = 0;
  const future = [], pastPending = [], absences = [], personalRows = [], conflicts = [], examRows = [];
  for (const row of course.rows) {
    const id = String(row.asis_clase_id), override = overrides[id];
    const exam = isExam(row, examWeeks);
    const status = rowStatus(row, override, examWeeks);
    if (exam) examRows.push(row);
    const h = Number(row.cnt_horas_catedras);
    if (override) {
      personalRows.push(row);
      if (!exam && row.asistencia_cargada === 'S' && status !== rowStatus(row)) conflicts.push(row);
    }
    if (status === 'present') attended += h;
    else if (status === 'partial') attended += officialHours(row);
    else if (status === 'absent') absences.push(row);
    else if (status === 'pending') {
      if (row.fecha >= today) future.push(row);
      else { pendingHours += h; pastPending.push(row); }
    }
  }
  const planRows = future.filter(r => planned.has(String(r.asis_clase_id)));
  const available = future.filter(r => !planned.has(String(r.asis_clase_id)));
  const futureHours = future.reduce((n, r) => n + Number(r.cnt_horas_catedras), 0);
  const planHours = planRows.reduce((n, r) => n + Number(r.cnt_horas_catedras), 0);
  const minimum = total * .75;
  const budget = attended + futureHours - minimum;
  const remainingBudget = budget - planHours;
  const groups = [];
  for (const row of available) {
    const day = weekday(row.fecha), hours = Number(row.cnt_horas_catedras);
    let group = groups.find(g => g.day === day && g.hours === hours);
    if (!group) { group = { day, hours, dates: [] }; groups.push(group); }
    group.dates.push(row);
  }
  groups.sort((a, b) => a.day - b.day || a.hours - b.hours);
  groups.forEach(g => g.dates.sort((a, b) => a.fecha.localeCompare(b.fecha)));
  const options = combinations(groups, remainingBudget);
  const bestOptions = combinations(groups, remainingBudget + pendingHours);
  return { available: true, total, minimum, attended, adjustment, future, futureHours, pastPending, pendingHours,
    absences, personalRows, conflicts, examRows, planRows, groups, options, budget, remainingBudget,
    maxAdditional: Math.max(0, ...options.map(o => o.count)),
    optimisticAdditional: Math.max(0, ...bestOptions.map(o => o.count)),
    projected: total ? (attended + futureHours - planHours) / total * 100 : 0,
    achieved: total ? attended / total * 100 : 0,
    portalPercent: Number(global.porc_asistencia), reachable: budget >= -1e-8,
    safe: remainingBudget >= -1e-8 };
}
