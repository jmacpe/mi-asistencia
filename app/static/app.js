import { calculate, DAYS, weekday, rowStatus, localDate, isExam, weekStart, weekEnd } from './model.js';
import { request } from './api.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (value, digits = 1) => Number(value).toLocaleString('es-PY', { maximumFractionDigits: digits });
const dateLabel = (value, long = false) => new Intl.DateTimeFormat('es-PY', {
  day: 'numeric', month: long ? 'long' : 'short', timeZone: 'UTC'
}).format(new Date(`${value}T12:00:00Z`));
const icons = {
  check: '<path d="m5 12 4 4L19 6"/>', calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  leaf: '<path d="M20 4C8 1 2 8 7 15s15 1 13-11ZM5 20l10-10"/>', chart: '<path d="M4 4v16h16M8 15l4-5 4 2 4-7"/>',
  save: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>', lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  book: '<path d="M12 5v16M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2Z"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.check}</svg>`;
let state, selected = '', panel = 'plan', recordFilter = 'all', busy = false, loadingSync = false;
let today = localDate(), toastTimer;

function notify(message, error = false) {
  $('#toast').textContent = message;
  $('#toast').className = `show ${error ? 'bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').className = ''; }, 5000);
}

async function api(path, body) {
  return request(path, body, state);
}

function personal(courseId = selected) {
  return structuredClone(state.personal[courseId] || { overrides: {}, planned: [] });
}

async function savePersonal(next, message) {
  if (busy) return;
  busy = true;
  const id = selected, previous = state.personal[id];
  state.personal[id] = next;
  render();
  try {
    state = await api('/api/personal', { revision: state.revision, courseId: id, ...next });
    notify(message || 'Guardado en tu computadora');
  } catch (error) {
    state.personal[id] = previous;
    notify(error.message, true);
    try { state = await api('/api/state'); } catch { /* Keep the last saved version. */ }
  } finally { busy = false; render(); }
}

function stamp() {
  if (!state.lastSync) return 'Conectá Sapientia para cargar tus materias';
  return `Última consulta: ${new Intl.DateTimeFormat('es-PY', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Asuncion' }).format(new Date(state.lastSync))}`;
}

async function saveExamWeeks(weeks) {
  if (busy) return;
  busy = true;
  const previous = state.examWeeks;
  state.examWeeks = weeks;
  render();
  try {
    state = await api('/api/exam-weeks', { revision: state.revision, examWeeks: weeks });
    notify('Parciales guardados. Todas tus materias ya se recalcularon.');
  } catch (error) {
    state.examWeeks = previous;
    notify(error.message, true);
    try { state = await api('/api/state'); } catch {}
  } finally { busy = false; render(); }
}

function renderExamWeeks() {
  const allDates = state.courses.flatMap(c => c.rows.map(r => r.fecha)).sort();
  if (!allDates.length) return '';
  return `<section class="panel exam-panel" aria-label="Semanas de parciales"><div class="panel-heading"><div><h3>Semanas de parciales</h3><p>Dos semanas, sin clases. Se cuentan como presentes en todas tus materias.</p></div><span class="tag">TODO EL SEMESTRE</span></div><div class="exam-weeks">${(state.examWeeks || [null, null]).map((start, index) => {
    const label = start ? `${dateLabel(start)} al ${dateLabel(weekEnd(start))}` : 'Todavía sin definir';
    const status = start ? (weekEnd(start) < today ? 'Ya pasó' : start > today ? 'Programada' : 'Esta semana') : 'Pendiente';
    return `<div class="exam-week"><div class="exam-week-heading"><strong>${index + 1}.ª semana</strong><span class="tag">${status}</span></div><label for="exam-week-${index}">Elegí cualquier día de esa semana</label><input id="exam-week-${index}" data-exam-index="${index}" type="date" value="${start || ''}" min="${weekStart(allDates[0])}" max="${weekEnd(allDates.at(-1))}" ${busy ? 'disabled' : ''}><div class="exam-week-range"><span>${label}</span>${start ? `<button class="text-button" data-clear-exam="${index}" ${busy ? 'disabled' : ''}>Quitar</button>` : ''}</div></div>`;
  }).join('')}</div><p class="exam-explanation">Se aplica de lunes a domingo. Sus fechas dejan de aparecer como faltas posibles y el margen se recalcula automáticamente. Podés corregir o quitar una semana; tus registros originales se conservan. Es tu criterio personal de cálculo, no una confirmación de Sapientia.</p></section>`;
}

function semesterPicker() {
  if (!state.semesters?.length) return `<div class="semester-picker"><span>${esc(state.semester || '')}</span><button class="text-button" data-action="connect">Conectar / cambiar cuenta</button>${state.accountKey ? '<button class="text-button" data-action="logout">Cerrar sesión</button>' : ''}</div>`;
  return `<div class="semester-picker"><label for="semester-select">Semestre</label><select id="semester-select" ${busy || loadingSync ? 'disabled' : ''}>${state.semesters.map(s=>`<option value="${esc(s.id)}" ${s.id === state.activeSemester ? 'selected' : ''}>${esc(s.label)} · ${s.count} materias</option>`).join('')}</select><button class="text-button" data-action="connect">Cambiar cuenta</button><button class="text-button" data-action="logout">Cerrar sesión</button></div>`;
}

function renderUnavailable(course) {
  const courses = state.courses;
  $('#app').innerHTML = `<main id="main" class="welcome"><a class="brand" href="/"><span class="brand-icon">${icon('check')}</span>mi asistencia.</a>${semesterPicker()}<section class="panel welcome-panel"><span class="eyebrow">TU ASISTENCIA EN SAPIENTIA</span><h1>${course ? esc(course.name) : state.accountKey ? 'Todavía no hay materias en este período' : 'Tu semestre empieza acá.'}</h1><p>${course ? esc(course.error || 'Todavía no hay un calendario de asistencia cargado para esta materia. No se puede calcular cuánto podés faltar.') : state.accountKey ? 'Probá otro período o actualizá el listado de Sapientia.' : 'Iniciá sesión con tu cuenta de alumnos. La app importa tus materias, detecta el período más reciente y calcula tus posibles faltas.'}</p><button class="button primary" data-action="connect">${state.accountKey ? 'Conectar / cambiar cuenta' : 'Iniciar sesión en Sapientia'}</button>${state.sync.connected ? '<button class="button secondary" data-action="sync">Actualizar</button>' : ''}<p class="small">Los datos quedan en esta computadora, separados por cuenta y semestre. No se guarda tu contraseña. Objetivo de asistencia: 75%.</p></section>${courses.length ? `<nav class="available-courses" aria-label="Materias">${courses.map(c=>`<button class="button secondary" data-course="${c.id}">${esc(c.name)}${c.error ? ' · Sin cálculo' : ''}</button>`).join('')}</nav>` : ''}</main>`;
  bindEvents();
}

function render() {
  if (!state) return;
  today = localDate();
  if (!state.courses.length) { renderUnavailable(); return; }
  if (!state.courses.some(c => c.id === selected)) selected = state.courses[0].id;
  const course = state.courses.find(c => c.id === selected);
  const own = personal(), stats = calculate(course, own, today, state.examWeeks);
  if (!stats.available) { renderUnavailable(course); return; }
  const allStats = state.courses.map(c => calculate(c, personal(c.id), today, state.examWeeks));
  const todayRows = state.courses.flatMap(c => c.rows.filter(r => r.fecha === today && r.cnt_horas_asistidas !== 'Feriado' && !isExam(r, state.examWeeks)).map(r => ({ course: c, row: r })));
  const currentDay = DAYS[weekday(today)];
  const maxLabel = stats.planRows.length ? 'más, además de tu plan' : 'clases completas más';
  const maxTotal = stats.maxAdditional;
  const weeks = [...new Set(stats.future.map(r => r.fecha.slice(0, 7)))];
  const combinationContent = renderCombinations(stats);
  const pending = stats.pastPending.map(r => dateLabel(r.fecha)).join(', ');
  $('#app').innerHTML = `
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="Mi asistencia, inicio"><span class="brand-icon">${icon('check')}</span><span>mi asistencia<span class="brand-dot">.</span></span></a>
      <div class="workspace-label">TU ESPACIO PERSONAL</div>
      <div class="profile"><span class="avatar">${esc(state.owner.split(/\s+/).slice(0,2).map(s=>s[0]).join(''))}</span><div><strong>${esc(state.owner)}</strong><span>${esc(state.career || 'Mi cuenta de alumnos')}</span></div><span class="online-dot" title="Guardado local"></span></div>
      <div class="nav-label">MIS MATERIAS <span>${state.courses.length}</span></div>
      <nav aria-label="Materias">${state.courses.map((c, i) => `
        <button class="course-nav ${c.id === selected ? 'active' : ''}" data-course="${c.id}" ${c.id === selected ? 'aria-current="page"' : ''}>
          <span class="subject-dot ${c.color}"></span><span>${esc(c.short)}<small>${esc(c.code)}</small></span><span class="nav-count">${allStats[i].maxAdditional ?? '—'}</span>
        </button>`).join('')}</nav>
      <div class="sidebar-bottom"><div>${icon('lock')} Solo en tu computadora</div><button class="text-button light" data-action="export">${icon('save')} Descargar respaldo</button><span>${esc(state.semester)}</span></div>
    </aside>
    <div class="workspace">
      <header class="topbar"><span class="breadcrumb">Mi semestre <span>/</span> ${esc(course.short)}</span><div class="topbar-actions"><span class="save-state"><i></i>${busy ? 'Guardando…' : 'Guardado local'}</span><button class="button secondary compact" data-action="connect">${icon('refresh')} ${state.sync.connected ? 'Conexión' : 'Conectar Sapientia'}</button></div></header>
      <main id="main">
        ${semesterPicker()}
        <div class="page-heading"><div><p class="eyebrow">${esc(state.semester)} <span class="heading-divider">/</span> OBJETIVO 75%</p><h1>Tu asistencia, bajo control<span>.</span></h1><p class="muted">Elegí cuándo faltar. Sabé dónde estás parado.</p></div><div class="today-date"><span>${currentDay}</span><strong>${dateLabel(today, true)}</strong></div></div>
        ${todayRows.length ? `<section class="today-strip" aria-label="Asistencia de hoy"><span class="today-icon">${icon('calendar')}</span><div class="today-copy"><strong>Tu clase de hoy</strong><span>${todayRows.map(({ course: c }) => esc(c.name)).join(' · ')}</span></div><div class="today-actions">${todayRows.map(({ course: c, row: r }) => {
          const status = rowStatus(r, personal(c.id).overrides[String(r.asis_clase_id)]);
          return `<button class="button ${status === 'present' ? 'success' : 'secondary'} compact" data-today-course="${c.id}" data-row="${r.asis_clase_id}" data-status="present" ${busy ? 'disabled' : ''}>${icon('check')} ${status === 'present' ? 'Viniste' : 'Vine'}</button><button class="button ${status === 'absent' ? 'danger' : 'ghost'} compact" data-today-course="${c.id}" data-row="${r.asis_clase_id}" data-status="absent" ${busy ? 'disabled' : ''}>${status === 'absent' ? 'Faltaste' : 'Falté'}</button>`;
        }).join('')}</div></section>` : ''}
        ${renderExamWeeks()}
        <section class="course-title"><div><span class="subject-dot ${course.color}"></span><h2>${esc(course.name)}</h2><span class="tag">${esc(course.code)}</span></div><span class="schedule">${[...new Set(course.rows.map(r => weekday(r.fecha)))].sort().map(d => DAYS[d]).join(' + ')} · hasta ${dateLabel(course.rows.at(-1).fecha)}</span></section>
        <section class="metrics" aria-label="Resumen de asistencia">
          <article class="metric primary-metric"><div class="metric-label">PODÉS FALTAR ${icon('arrow')}</div><div class="metric-number">${maxTotal}<span>${maxLabel}</span></div><p>${stats.safe ? 'Depende de la combinación de días que elijas.' : 'Tu plan supera el límite. Quitá algunas faltas.'}</p></article>
          <article class="metric"><div class="metric-label">AL FINAL, CON TU PLAN ${icon('chart')}</div><div class="metric-number ${stats.safe ? 'green-text' : 'red-text'}">${fmt(stats.projected)}<span class="percent">%</span></div><div class="progress-track"><progress max="100" value="${Math.max(0, Math.min(100, stats.projected))}" aria-label="Asistencia proyectada"></progress><i></i></div><p>Si asistís a todas las demás clases · mínimo 75%</p></article>
          <article class="metric"><div class="metric-label">POR DELANTE ${icon('calendar')}</div><div class="metric-number">${stats.future.length}<span>clases sin registrar</span></div><p>${stats.planRows.length ? `${stats.planRows.length} ${stats.planRows.length === 1 ? 'falta planificada' : 'faltas planificadas'}` : 'Todavía no elegiste faltas para tu plan'}</p></article>
        </section>
        ${stats.pastPending.length ? `<div class="notice pending-notice"><span class="notice-symbol">!</span><div><strong>${stats.pastPending.length === 1 ? 'Hay una clase pasada sin cargar' : 'Hay clases pasadas sin cargar'}: ${pending}.</strong><p>El cálculo conservador no la${stats.pastPending.length === 1 ? '' : 's'} cuenta como presente${stats.pastPending.length === 1 ? '' : 's'}. Si confirmás que viniste, el máximo ${stats.planRows.length ? 'adicional ' : ''}puede subir de <b>${stats.maxAdditional}</b> a <b>${stats.optimisticAdditional} clases</b>.</p></div><button class="text-button" data-action="pending">Revisar ${icon('arrow')}</button></div>` : ''}
        ${stats.conflicts.length ? `<div class="notice conflict-notice"><span class="notice-symbol">!</span><div><strong>${stats.conflicts.length} ${stats.conflicts.length === 1 ? 'marca personal difiere' : 'marcas personales difieren'} de Sapientia.</strong><p>El cálculo usa lo que registraste vos. Revisá las diferencias en el registro.</p></div><button class="text-button" data-action="records">Ver registro</button></div>` : ''}
        ${!stats.reachable ? `<div class="notice conflict-notice"><strong>Con los registros actuales no alcanza con asistir a todas las clases restantes. Revisá las asistencias pendientes o incorrectas antes de planificar faltas.</strong></div>` : ''}
        <div class="view-tabs" role="tablist" aria-label="Vista de la materia"><button role="tab" aria-selected="${panel === 'plan'}" data-panel="plan" class="${panel === 'plan' ? 'selected' : ''}">${icon('calendar')} Planificar faltas</button><button role="tab" aria-selected="${panel === 'records'}" data-panel="records" class="${panel === 'records' ? 'selected' : ''}">${icon('book')} Mi registro <span>${stats.personalRows.length ? stats.personalRows.length + ' personal' : 'Sapientia'}</span></button></div>
        ${panel === 'plan' ? `<section class="planner-layout"><div class="panel calendar-panel"><div class="panel-heading"><div><h3>Probá tu próximo descanso</h3><p>Tocá una fecha para planificar una falta.</p></div><span class="tag">SIMULADOR</span></div><div class="calendar-body">${weeks.map(month => `<div class="month-group"><h4>${new Intl.DateTimeFormat('es-PY', {month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month + '-01T12:00:00Z'))}</h4><div class="date-grid">${stats.future.filter(r => r.fecha.startsWith(month)).map(r => {
          const isPlanned = own.planned.includes(String(r.asis_clase_id));
          return `<button class="date-card ${isPlanned ? 'planned' : ''}" data-plan="${r.asis_clase_id}" aria-pressed="${isPlanned}" aria-label="${DAYS[weekday(r.fecha)]} ${dateLabel(r.fecha, true)}: ${isPlanned ? 'falta planificada, quitar' : 'asistir, planificar falta'}" ${busy ? 'disabled' : ''}><span>${DAYS[weekday(r.fecha)].slice(0,3)}</span><strong>${Number(r.fecha.slice(8))}</strong><small>${isPlanned ? 'Faltaré' : r.fecha === today ? 'Hoy' : 'Asistiré'}</small>${isPlanned ? '<i>−</i>' : ''}</button>`;
        }).join('')}</div></div>`).join('') || '<div class="empty">No quedan clases por planificar. Podés revisar tu registro.</div>'}</div><div class="plan-footer"><div><span class="legend-dot"></span> Asistiré <span class="legend-dot chosen"></span> Faltaré</div><button class="text-button" data-action="clear-plan" ${!stats.planRows.length || busy ? 'disabled' : ''}>Limpiar plan</button></div><div class="plan-result ${stats.safe ? 'is-safe' : 'is-risk'}">${icon(stats.safe ? 'check' : 'chart')}<div><strong>${stats.planRows.length} ${stats.planRows.length === 1 ? 'falta seleccionada' : 'faltas seleccionadas'} · ${fmt(stats.projected)}% al finalizar</strong><span>${stats.safe ? 'Tu plan mantiene el mínimo de 75%.' : 'Este plan queda por debajo de 75%. Quitá faltas del calendario.'}</span></div></div></div><div class="panel combinations-panel"><div class="panel-heading"><div><h3>Combinaciones posibles</h3><p>${stats.planRows.length ? 'Faltas adicionales a las que ya elegiste.' : 'Alternativas máximas de clases completas.'}</p></div><span class="option-count">${stats.options.length}</span></div>${combinationContent}<div class="combinations-note">${icon('leaf')}<p>Las filas son alternativas, no se suman. También podés faltar menos. Una clase del día más largo consume más margen.</p></div></div></section>` : renderRecords(course, own, stats)}
        <details class="method panel"><summary>Cómo se calcula y qué datos se usan <span>+</span></summary><div class="method-content"><p>El objetivo es <strong>75% al final del semestre</strong>. Cada encuentro cuenta como una clase; la duración de cada día determina qué combinaciones son válidas. El calendario supone que las clases programadas se mantienen.</p><p>El porcentaje que muestra Sapientia ahora es <strong>${fmt(stats.portalPercent)}%</strong> sobre todo el semestre, incluidas las clases futuras. La proyección de esta app supone que asistís a las clases futuras que no seleccionaste para faltar.</p><p>Las semanas de parciales se cuentan como presentes, incluso si el portal no las cargó. Fuera de esas semanas, las marcas personales tienen prioridad sobre el portal. Ambas configuraciones se conservan al sincronizar. “Sin confirmar” no equivale a una falta oficial, pero no suma asistencia en el cálculo conservador. Una falta planificada que llega al pasado debe confirmarse en Mi registro.</p>${stats.adjustment > .01 ? `<p>El porcentaje de Sapientia incluye un crédito adicional equivalente a ${fmt(stats.adjustment)} horas cátedra. Puede incluir feriados o asistencias justificadas. La app conserva ese crédito al calcular.</p>` : ''}<p>Base de cálculo: ${fmt(stats.attended)} horas acreditadas de ${fmt(stats.total)}; mínimo ${fmt(stats.minimum)}. Estos datos se usan internamente para mostrarte cantidades enteras de clases.</p></div></details>
        <footer class="page-footer"><span>${icon('lock')} Tus marcas son personales. No modifican Sapientia.</span><span>${esc(stamp())}</span></footer>
        <div class="sync-message ${state.sync.connected ? '' : 'muted'}">${esc(state.sync.message)} ${state.sync.auto ? 'Actualización automática cada 15 min.' : ''} ${state.sync.connected ? `<button class="text-button" data-action="sync" ${loadingSync ? 'disabled' : ''}>${loadingSync ? 'Actualizando…' : 'Actualizar ahora'}</button><button class="text-button" data-action="disconnect">Desconectar</button>` : ''}</div>
      </main>
    </div>`;
  bindEvents();
}

function renderCombinations(stats) {
  if (!stats.safe) return '<div class="empty"><strong>Primero ajustá tu plan</strong><p>Las faltas seleccionadas ya superan el margen disponible.</p></div>';
  if (!stats.options.length) return '<div class="empty"><span class="empty-icon">✓</span><strong>No cabe otra clase completa</strong><p>Para mantener el 75%, asistí a las clases restantes o revisá las asistencias pendientes.</p></div>';
  return `<div class="combination-table-wrap"><table class="combination-table"><thead><tr>${stats.groups.map(g => `<th scope="col">${DAYS[g.day]}${stats.groups.filter(x => x.day === g.day).length > 1 ? `<small>${fmt(g.hours)} h</small>` : ''}</th>`).join('')}<th scope="col">Total</th><th><span class="sr-only">Agregar al plan</span></th></tr></thead><tbody>${stats.options.map((option, i) => `<tr>${option.counts.map(n => `<td>${n === 0 ? '<span class="zero">0</span>' : n}</td>`).join('')}<td><span class="total-pill">${option.count} ${option.count === 1 ? 'clase' : 'clases'}</span></td><td><button class="apply-combo" data-combo="${i}" aria-label="Agregar combinación ${option.counts.map((n,j) => `${n} ${DAYS[stats.groups[j].day]}`).join(', ')}" title="Agregar las primeras fechas disponibles al plan" ${busy ? 'disabled' : ''}>${icon('arrow')}</button></td></tr>`).join('')}</tbody></table></div><p class="table-hint">La flecha elige las primeras fechas disponibles; después podés cambiarlas.</p>`;
}

function renderRecords(course, own, stats) {
  let rows = course.rows.filter(r => r.fecha <= today).toReversed();
  if (recordFilter === 'pending') rows = rows.filter(r => rowStatus(r, own.overrides[String(r.asis_clase_id)], state.examWeeks) === 'pending');
  if (recordFilter === 'absent') rows = rows.filter(r => rowStatus(r, own.overrides[String(r.asis_clase_id)], state.examWeeks) === 'absent');
  const statusNames = { present: 'Presente', absent: 'Falta', pending: 'Sin cargar', holiday: 'Feriado', partial: 'Parcial' };
  return `<section class="panel records-panel"><div class="panel-heading"><div><h3>Clase por clase</h3><p>Registrá lo que pasó. Tus cambios quedan guardados automáticamente.</p></div><label class="filter-label"><span class="sr-only">Filtrar registro</span><select id="record-filter"><option value="all" ${recordFilter === 'all' ? 'selected' : ''}>Todas las clases</option><option value="pending" ${recordFilter === 'pending' ? 'selected' : ''}>Sin confirmar</option><option value="absent" ${recordFilter === 'absent' ? 'selected' : ''}>Faltas</option></select></label></div><div class="records-table-wrap"><table class="records-table"><thead><tr><th>Fecha</th><th>Sapientia</th><th>Tu registro</th><th>Asistencia</th></tr></thead><tbody>${rows.map(r => {
    const rid = String(r.asis_clase_id), override = own.overrides[rid], official = rowStatus(r), status = rowStatus(r, override, state.examWeeks);
    const exam = isExam(r, state.examWeeks) && official !== 'holiday';
    const conflict = stats.conflicts.some(x => String(x.asis_clase_id) === rid);
    return `<tr class="${conflict ? 'conflict-row' : ''}"><td><strong>${dateLabel(r.fecha)}</strong><small>${DAYS[weekday(r.fecha)]}${r.fecha === today ? ' · Hoy' : ''}</small></td><td><span class="status ${official}">${statusNames[official]}</span>${official === 'partial' ? `<small>${esc(r.cnt_horas_asistidas)} de ${esc(r.cnt_horas_catedras)} h</small>` : ''}</td><td>${exam ? '<span class="personal-badge">Presente por parciales</span><small>Semana sin clases</small>' : override ? `<span class="personal-badge">${status === 'pending' ? 'Sin confirmar' : statusNames[status]}</span><button class="reset-mark" data-reset="${rid}" ${busy ? 'disabled' : ''}>Usar Sapientia</button>` : '<span class="muted">Usando Sapientia</span>'}${conflict ? '<small class="error-text">Difiere del portal</small>' : ''}</td><td>${status === 'holiday' ? '<span class="muted small">Feriado del portal</span>' : exam ? '<span class="status present">Presente automático</span>' : `<div class="attendance-controls" role="group" aria-label="Asistencia del ${dateLabel(r.fecha)}"><button class="mark ${status === 'present' ? 'yes selected' : ''}" data-mark="${rid}" data-status="present" aria-pressed="${status === 'present'}" ${busy ? 'disabled' : ''}>Vine</button><button class="mark ${status === 'absent' ? 'no selected' : ''}" data-mark="${rid}" data-status="absent" aria-pressed="${status === 'absent'}" ${busy ? 'disabled' : ''}>Falté</button><button class="mark ${status === 'pending' ? 'selected' : ''}" data-mark="${rid}" data-status="pending" aria-pressed="${status === 'pending'}" ${busy ? 'disabled' : ''}>No sé</button></div>`}</td></tr>`;
  }).join('') || '<tr><td colspan="4"><div class="empty">No hay clases con este filtro.</div></td></tr>'}</tbody></table></div></section>`;
}

function bindEvents() {
  $('#semester-select')?.addEventListener('change', async event => {
    if (busy || loadingSync) return;
    const semesterId = event.target.value;
    loadingSync = true; render();
    try {
      state = await api('/api/semester', { revision: state.revision, semesterId });
      selected = ''; recordFilter = 'all'; notify('Semestre cargado. Tus registros anteriores se conservaron.');
    } catch (error) { notify(error.message, true); }
    finally { loadingSync = false; render(); }
  });
  document.querySelectorAll('[data-exam-index]').forEach(input => input.addEventListener('change', () => {
    const weeks = [...(state.examWeeks || [null, null])];
    weeks[Number(input.dataset.examIndex)] = input.value ? weekStart(input.value) : null;
    saveExamWeeks(weeks);
  }));
  document.querySelectorAll('[data-clear-exam]').forEach(button => button.addEventListener('click', () => {
    const weeks = [...state.examWeeks]; weeks[Number(button.dataset.clearExam)] = null; saveExamWeeks(weeks);
  }));
  document.querySelectorAll('[data-course]').forEach(b => b.addEventListener('click', () => { selected = b.dataset.course; recordFilter = 'all'; render(); }));
  document.querySelectorAll('[data-panel]').forEach(b => b.addEventListener('click', () => { panel = b.dataset.panel; render(); }));
  document.querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', () => {
    const own = personal(), id = b.dataset.plan;
    own.planned = own.planned.includes(id) ? own.planned.filter(x => x !== id) : [...own.planned, id];
    savePersonal(own, 'Plan actualizado. La proyección ya se recalculó.');
  }));
  document.querySelectorAll('[data-combo]').forEach(b => b.addEventListener('click', () => {
    const own = personal(), stats = calculate(state.courses.find(c => c.id === selected), own, today, state.examWeeks);
    const option = stats.options[Number(b.dataset.combo)];
    stats.groups.forEach((g, i) => own.planned.push(...g.dates.slice(0, option.counts[i]).map(r => String(r.asis_clase_id))));
    savePersonal(own, 'Combinación agregada. Podés cambiar las fechas del calendario.');
  }));
  document.querySelectorAll('[data-mark], [data-today-course]').forEach(b => b.addEventListener('click', () => {
    if (busy) return;
    if (b.dataset.todayCourse) selected = b.dataset.todayCourse;
    const id = b.dataset.mark || b.dataset.row, own = personal();
    own.overrides[id] = { status: b.dataset.status, updatedAt: new Date().toISOString() };
    own.planned = own.planned.filter(x => x !== id);
    savePersonal(own, b.dataset.status === 'present' ? 'Presente registrado. Tu margen ya está actualizado.' : 'Registro guardado. Tu margen ya está actualizado.');
  }));
  document.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', () => {
    const own = personal(); delete own.overrides[b.dataset.reset]; savePersonal(own, 'Ahora se usa el registro de Sapientia.');
  }));
  $('#record-filter')?.addEventListener('change', event => { recordFilter = event.target.value; render(); });
  document.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', async () => {
    const action = b.dataset.action;
    if (action === 'connect') { $('#login-error').textContent = ''; $('#connection').showModal(); }
    if (action === 'logout') {
      try { state = await api('/api/logout', {}); selected = ''; $('#login-form').reset(); render(); notify('Sesión cerrada. Tus datos quedan guardados en esta computadora.'); }
      catch (error) { notify(error.message, true); }
    }
    if (action === 'pending' || action === 'records') { panel = 'records'; recordFilter = action === 'pending' ? 'pending' : 'all'; render(); $('.records-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (action === 'clear-plan') { const own = personal(); own.planned = []; savePersonal(own, 'Plan limpio.'); }
    if (action === 'sync') syncPortal();
    if (action === 'disconnect') {
      try { state = await api('/api/disconnect', {}); render(); notify('Desconectado. Tus datos locales siguen guardados.'); } catch (error) { notify(error.message, true); }
    }
    if (action === 'export') {
      try {
        const exported = await api('/api/export');
        const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `mi-asistencia-${today}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { notify(error.message, true); }
    }
  }));
}

async function syncPortal() {
  if (loadingSync) return;
  loadingSync = true; render();
  try { state = await api('/api/sync', {}); notify('Sapientia actualizado. Se conservaron tus marcas.'); }
  catch (error) { notify(error.message, true); try { state = await api('/api/state'); } catch {} }
  finally { loadingSync = false; render(); }
}

$('#close-dialog').addEventListener('click', () => { $('#connection').close(); $('#login-form').elements.password.value = ''; });
$('#connection').addEventListener('close', () => { $('#login-form').elements.password.value = ''; });
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, username = form.elements.username.value, password = form.elements.password.value;
  $('#login-submit').disabled = true; $('#login-submit').textContent = 'Buscando tus materias y semestres…'; $('#login-error').textContent = '';
  form.elements.password.value = '';
  try {
    state = await api('/api/connect', { username, password });
    selected = ''; recordFilter = 'all';
    $('#connection').close(); render(); notify('Conectado. Los datos se actualizarán cada 15 minutos.');
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { $('#login-submit').disabled = false; $('#login-submit').textContent = 'Conectar y actualizar'; }
});

async function refresh() {
  if (busy || loadingSync || $('#connection').open) return;
  try {
    const next = await api('/api/state');
    const changed = !state || next.revision !== state.revision || JSON.stringify(next.sync) !== JSON.stringify(state.sync) || today !== localDate();
    if (busy || (state && next.revision < state.revision)) return;
    state = next;
    if (changed) render();
  } catch {
    notify('La app local no responde. Abrí iniciar.cmd para reconectar; tus datos están guardados.', true);
  }
}

try { state = await api('/api/state'); render(); }
catch (error) { $('#app').innerHTML = `<div class="loading"><h1>No se pudo abrir tu registro</h1><p>${esc(error.message)}</p><p>Abrí iniciar.cmd y recargá esta página.</p></div>`; }
setInterval(refresh, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
