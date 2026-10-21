import { localDate, weekStart, weekEnd } from '../app/static/model.js';
const PREFIX = 'mi-asistencia:v1:';
export function emptyState() {
  return {version:1,revision:Date.now(),owner:'Mi cuenta',career:'',semester:'',accountKey:null,activeSemester:null,semesters:[],lastSync:null,sourceDate:localDate(),courses:[],personal:{},examWeeks:[null,null],csrf:'same-origin',sync:{connected:false,running:false,auto:false,intervalMinutes:15,message:'Iniciá sesión en Sapientia para cargar tus materias.'}};
}
const profileKey = (account,semester) => PREFIX + account + ':' + String(semester);
function load(account,semester) {
  const raw = localStorage.getItem(profileKey(account,semester));
  if (!raw) return null;
  try { const value = JSON.parse(raw); return value.accountKey === account && value.activeSemester === semester ? value : null; }
  catch { throw new Error('El registro local no se puede leer. Conservá una copia antes de borrar los datos del navegador.'); }
}
function save(state) {
  state.revision = Math.max(Date.now(),state.revision+1);
  try { localStorage.setItem(profileKey(state.accountKey,state.activeSemester),JSON.stringify(state)); }
  catch { throw new Error('El navegador no pudo guardar tus registros. Liberá espacio o habilitá el almacenamiento del sitio.'); }
  return state;
}
async function remote(path,body) {
  const response = await fetch(path, {credentials:'same-origin',cache:'no-store',...(body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'No se pudo conectar con Sapientia.');
  return result;
}
export function mergeSnapshot(snapshot, saved) {
  const same = saved?.accountKey === snapshot.accountKey && saved?.activeSemester === snapshot.activeSemester;
  const state = {...(same ? saved : emptyState()),...snapshot};
  for (const c of state.courses) state.personal[c.id] ||= {overrides:{},planned:[]};
  state.sync = {connected:true,auto:true,running:false,intervalMinutes:15,message:`Sapientia actualizado: ${state.courses.length} materias. Registros guardados en este navegador.`};
  return state;
}
async function sync(path,body) {
  const snapshot = await remote(path,body);
  return save(mergeSnapshot(snapshot,load(snapshot.accountKey,snapshot.activeSemester)));
}
function checkRevision(body,state) {
  if (body.revision !== state.revision) throw new Error('Los datos cambiaron en otra ventana. Se actualizará la pantalla; repetí tu cambio.');
}
export function updatePersonal(state,body) {
  checkRevision(body,state);
  const course = state.courses.find(c=>c.id===body.courseId);
  if (!course) throw new Error('Materia desconocida.');
  const rows = new Map(course.rows.map(r=>[String(r.asis_clase_id),r]));
  if (!body.overrides || typeof body.overrides !== 'object' || Array.isArray(body.overrides) || !Array.isArray(body.planned)) throw new Error('Registro inválido.');
  const overrides = {};
  for (const [id,value] of Object.entries(body.overrides)) {
    const row = rows.get(id);
    if (!row || !['present','absent','pending'].includes(value?.status) || row.fecha > localDate() || row.cnt_horas_asistidas === 'Feriado') throw new Error('Asistencia inválida.');
    overrides[id] = {status:value.status,updatedAt:new Date().toISOString()};
  }
  if (body.planned.some(id=>typeof id !== 'string' || !rows.has(id))) throw new Error('Plan inválido.');
  state.personal[course.id] = {overrides,planned:[...new Set(body.planned)]};
  return state;
}
export function updateExamWeeks(state,body) {
  checkRevision(body,state);
  if (!Array.isArray(body.examWeeks) || body.examWeeks.length !== 2) throw new Error('Elegí las dos semanas de parciales.');
  const dates = state.courses.flatMap(c=>c.rows.map(r=>r.fecha)).sort();
  if (!dates.length) throw new Error('Primero cargá un semestre con clases disponibles.');
  const clean = body.examWeeks.map(value=> {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value) throw new Error('Fecha de parcial inválida.');
    const monday = weekStart(value);
    if (monday > dates.at(-1) || weekEnd(monday) < dates[0]) throw new Error('La semana debe estar dentro de este semestre.');
    return monday;
  });
  if (clean[0] && clean[1] && clean[1] <= clean[0]) throw new Error('La segunda semana debe ser posterior a la primera.');
  state.examWeeks = clean;
  return state;
}
async function perform(path,body,previous) {
  if (path === '/api/connect') return sync(path,body);
  if (path === '/api/logout') { await remote(path,{}); return emptyState(); }
  // Validate the current visitor before showing a locally saved profile. Another tab may have switched accounts.
  const identity = await remote('/api/session');
  if (!identity.accountKey) {
    if (path === '/api/state') return emptyState();
    throw new Error('La sesión terminó. Volvé a iniciar sesión; tus marcas siguen guardadas.');
  }
  const current = load(identity.accountKey,identity.activeSemester);
  if (path === '/api/state') {
    if (!current) return identity.connected ? sync('/api/sync',{}) : emptyState();
    const changed = current.sync.connected !== identity.connected;
    current.sync.connected = identity.connected;
    if (identity.connected && current.sync.auto && Date.now()-Date.parse(current.lastSync)>900000) {
      try { return await sync('/api/sync',{}); }
      catch(error) { current.sync.auto=false; current.sync.message=error.message; return save(current); }
    }
    return changed ? save(current) : current;
  }
  if (!current || previous?.accountKey !== identity.accountKey || previous?.activeSemester !== identity.activeSemester) throw new Error('La cuenta cambió en otra ventana. Recargá antes de continuar.');
  if (path === '/api/sync') return sync(path,body);
  if (path === '/api/semester') { checkRevision(body,current); return sync(path,body); }
  if (path === '/api/disconnect') {
    await remote(path,{});
    current.sync = {...current.sync,connected:false,auto:false,message:'Desconectado. Tus registros siguen en este navegador.'};
    return save(current);
  }
  if (path === '/api/export') { const result=structuredClone(current); delete result.csrf; delete result.sync; return result; }
  if (path === '/api/personal') return save(updatePersonal(current,body));
  if (path === '/api/exam-weeks') return save(updateExamWeeks(current,body));
  throw new Error('Ruta desconocida.');
}
let queue = Promise.resolve();
export function request(path,body,previous) {
  const operation = () => globalThis.navigator?.locks ? navigator.locks.request('mi-asistencia',()=>perform(path,body,previous)) : perform(path,body,previous);
  const result = queue.then(operation,operation);
  queue = result.catch(()=>{});
  return result;
}
