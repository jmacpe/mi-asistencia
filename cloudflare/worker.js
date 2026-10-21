// Pages advanced-mode Worker. No passwords or attendance are persisted on the server.
const BASE = 'https://alumnos.sapientia.uc.edu.py';
const COOKIE = '__Host-asistencia';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TTL = 8 * 60 * 60;
class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unb64 = str => Uint8Array.from(atob(str.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
async function key(secret) {
  if (!/^[a-f0-9]{64}$/i.test(secret || '')) throw new AppError('Falta configurar la clave de sesión del sitio.', 503);
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g), x => parseInt(x, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(session, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:encoder.encode(COOKIE)}, await key(secret), encoder.encode(JSON.stringify(session)));
  const token = `${b64(iv)}.${b64(new Uint8Array(cipher))}`;
  if (token.length > 3700) throw new AppError('La sesión del portal es demasiado grande para este sitio.', 502);
  return token;
}
export async function unseal(token, secret) {
  const cryptoKey = await key(secret);
  try {
    const [iv, data, extra] = token.split('.');
    if (extra) return null;
    const clear = await crypto.subtle.decrypt({name:'AES-GCM', iv:unb64(iv), additionalData:encoder.encode(COOKIE)}, cryptoKey, unb64(data));
    const session = JSON.parse(decoder.decode(clear));
    return session.expires > Date.now() && typeof session.accountKey === 'string' ? session : null;
  } catch { return null; }
}
const headers = {
  'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};
const json = (value, status = 200, cookie) => new Response(JSON.stringify(value), {status, headers:{...headers, 'Content-Type':'application/json; charset=utf-8', ...(cookie ? {'Set-Cookie':cookie} : {})}});
const setCookie = token => `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${TTL}`;
const clearCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
export const semesterId = r => String(r.periodo_lectivo_id || r.cal_periodo_lectivo_id || `${r.anho_academico || ''}-${r.periodo_lectivo_orden || ''}-${r.periodo_lectivo || 'Sin período'}`);
export function semestersOf(catalog) {
  const result = new Map();
  for (const r of catalog) {
    const id = semesterId(r);
    if (!result.has(id)) result.set(id, {id, label:String(r.periodo_lectivo || 'Período sin nombre'), year:Number(r.anho_academico || 0), order:Number(r.periodo_lectivo_orden || 0), count:0});
    result.get(id).count++;
  }
  return [...result.values()].sort((a,b) => b.year-a.year || b.order-a.order || b.id.localeCompare(a.id));
}
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, c) => {
    if (c[0] === '#') { const n = c[1].toLowerCase() === 'x' ? parseInt(c.slice(2),16) : Number(c.slice(1)); return n <= 0x10ffff ? String.fromCodePoint(n) : m; }
    return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[c] || m;
  });
}
export class Portal {
  constructor(cookies = [], fetcher = fetch) {
    this.cookies = cookies;
    // Workers fetch rejects a Portal instance as its receiver; invoke it as a standalone function.
    this.fetcher = (...args) => fetcher(...args);
    this.owner = 'Mi cuenta';
  }
  async request(path, body) {
    let url = new URL(path, BASE), method = body ? 'POST' : 'GET';
    for (let hop = 0; hop < 8; hop++) {
      if (url.origin !== BASE) throw new AppError('El portal redirigió a otro sitio.', 502);
      const requestHeaders = {'Accept':'application/json','X-Requested-With':'XMLHttpRequest','User-Agent':'MiAsistencia/1.0'};
      const now = Date.now();
      const eligible = this.cookies.filter(c => (!c.expires || c.expires > now) && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')));
      if (eligible.length) requestHeaders.Cookie = eligible.map(c => `${c.name}=${c.value}`).join('; ');
      if (body) requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      const response = await this.fetcher(url.toString(), {method, body, headers:requestHeaders, redirect:'manual', signal:AbortSignal.timeout(25000)});
      const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.getAll('Set-Cookie');
      for (const raw of cookies) {
        const [pair, ...attrs] = raw.split(';'); const equal = pair.indexOf('=');
        if (equal < 1) continue;
        const name = pair.slice(0,equal).trim(), value = pair.slice(equal+1).trim();
        const attributes = Object.fromEntries(attrs.map(a => { const i=a.indexOf('='); return i<0 ? [a.trim().toLowerCase(),true] : [a.slice(0,i).trim().toLowerCase(),a.slice(i+1).trim()]; }));
        if (attributes.domain && !['alumnos.sapientia.uc.edu.py','sapientia.uc.edu.py','uc.edu.py'].includes(String(attributes.domain).replace(/^\./,''))) continue;
        const cookiePath = typeof attributes.path === 'string' && attributes.path.startsWith('/') ? attributes.path : url.pathname.slice(0,url.pathname.lastIndexOf('/')+1) || '/';
        let expires = attributes.expires ? Date.parse(attributes.expires) : null;
        if (attributes['max-age'] !== undefined) expires = now + Number(attributes['max-age']) * 1000;
        this.cookies = this.cookies.filter(c => !(c.name === name && c.path === cookiePath));
        if (!expires || expires > now) this.cookies.push({name,value,path:cookiePath,expires});
      }
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('Location');
        await response.body?.cancel();
        if (!location) throw new AppError('Redirección inválida de Sapientia.',502);
        url = new URL(location, url);
        if ([301,302,303].includes(response.status)) { method = 'GET'; body = undefined; }
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new AppError('Sapientia no está disponible. Probá nuevamente.',502); }
      const text = await response.text();
      if (text.length > 3000000) throw new AppError('La respuesta del portal es demasiado grande.',502);
      return text.replace(/^\uFEFF/, '');
    }
    throw new AppError('Demasiadas redirecciones de Sapientia.',502);
  }
  async login(username,password) {
    await this.request('/');
    const page = await this.request('/login/try',new URLSearchParams({'Credenciales[cedula]':username,'Credenciales[contrasenha]':password,preinsc:''}).toString());
    const match = page.match(/var\s+usuario_logueado\s*=\s*("(?:[^"\\]|\\.)*")/);
    if (match) { try { this.owner = decodeEntities(JSON.parse(match[1]).split(' - ')[0]).trim() || this.owner; } catch {} }
    return this.catalog();
  }
  async fetchRows(path, params = {}) {
    const result = [], seen = new Set(); let expected;
    for (let page = 1; page <= 100; page++) {
      let data;
      try { data = JSON.parse(await this.request(`${path}?${new URLSearchParams({...params,'p[page]':page})}`)); }
      catch (error) { if (error instanceof AppError) throw error; throw new AppError('Sapientia no devolvió datos. Revisá tus credenciales o reconectá la sesión.',401); }
      if (!Array.isArray(data.records)) throw new AppError('La respuesta del portal es inválida.',502);
      const rows = data.records, total = Number(data.numResults ?? rows.length);
      if (!Number.isSafeInteger(total) || total < 0) throw new AppError('Cantidad inválida de registros.',502);
      expected ??= total;
      const signature = JSON.stringify(rows);
      if (total !== expected || (result.length < total && !rows.length) || seen.has(signature)) throw new AppError('La respuesta está incompleta. Se conservaron los datos anteriores.',502);
      seen.add(signature); result.push(...rows);
      if (result.length === expected) return result;
      if (result.length > expected) break;
    }
    throw new AppError('No se pudo obtener el listado completo del portal.',502);
  }
  async catalog() {
    const rows = await this.fetchRows('/cursos/cursos/current-index', {'p[limit]':100});
    if (rows.some(r => !r.prg_curso_id)) throw new AppError('No se pudo identificar las materias de esta cuenta.',502);
    return rows;
  }
  async courses(records) {
    const result = [];
    for (const [id, record] of new Map(records.map(r => [String(r.prg_curso_id), r]))) {
      const name = String(record.asignatura || `Materia ${id}`).replace(/\s*\([^)]*\)\s*$/, '').trim();
      const course = {id,name,short:name,code:String(record.codigo || ''),section:String(record.seccion || '').trim(),color:['violet','blue','teal'][result.length%3],rows:[],summary:[],error:null};
      const params = {'s[id]':id,'p[limit]':200};
      try {
        const rows = await this.fetchRows('/cursos/cursos/get-asistencia', {...params,'sort[property]':'fecha','sort[direction]':'ASC'});
        const summary = await this.fetchRows('/cursos/cursos/get-asistencia-por-tipo',params);
        const global = summary.find(r => r.tipo_clase === 'GLOBAL');
        if (!rows.length || !(Number(global?.cnt_horas_catedras) > 0)) throw new AppError('Esta materia todavía no tiene un calendario de asistencia calculable.');
        if (new Set(rows.map(r => r.asis_clase_id)).size !== rows.length || rows.some(r=>!/^\d{4}-\d{2}-\d{2}$/.test(r.fecha) || !Number.isFinite(Number(r.cnt_horas_catedras))) || Math.abs(rows.reduce((n,r)=>n+Number(r.cnt_horas_catedras),0)-Number(global.cnt_horas_catedras))>1e-8) throw new AppError('El resumen y el calendario no coinciden; no se puede proyectar con seguridad.');
        Object.assign(course,{rows,summary});
      } catch (error) { if (!(error instanceof AppError) || error.status === 401) throw error; course.error = error.message; }
      result.push(course);
    }
    return result;
  }
}
async function hashed(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join(''); }
export async function handle(request, env, fetcher = fetch) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/')) {
    const assets = new Set(['/','/index.html','/app.js','/api.js','/model.js','/style.css','/favicon.svg']);
    if (!assets.has(path)) return new Response('No encontrado.',{status:404,headers});
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [k,v] of Object.entries(headers)) response.headers.set(k,v);
    return response;
  }
  try {
    if (!['GET','POST'].includes(request.method)) return json({error:'Método no permitido.'},405);
    if (request.method === 'POST' && (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json'))) return json({error:'Solicitud no permitida.'},403);
    const token = request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    const session = token ? await unseal(token,env.SESSION_KEY) : null;
    if (path === '/api/session' && request.method === 'GET') return json(session ? {accountKey:session.accountKey,activeSemester:session.activeSemester,connected:session.cookies.length>0} : {accountKey:null,connected:false});
    if (request.method !== 'POST') return json({error:'Ruta desconocida.'},404);
    if (path === '/api/logout') return json({ok:true},200,clearCookie);
    const raw = await request.text();
    if (raw.length > 10000) return json({error:'Solicitud demasiado grande.'},413);
    let body; try { body = JSON.parse(raw); } catch { throw new AppError('Solicitud inválida.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Solicitud inválida.');
    if (path === '/api/disconnect') {
      if (!session) return json({ok:true},200,clearCookie);
      session.cookies = [];
      return json({ok:true},200,setCookie(await seal(session,env.SESSION_KEY)));
    }
    if (!['/api/connect','/api/sync','/api/semester'].includes(path)) return json({error:'Ruta desconocida.'},404);
    let portal, catalog, identity;
    if (path === '/api/connect') {
      if (typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username.trim() || !body.password || body.username.length > 128 || body.password.length > 1024) throw new AppError('Ingresá usuario y contraseña.');
      portal = new Portal([], fetcher);
      catalog = await portal.login(body.username.trim(),body.password);
      const accountKey = await hashed(body.username.trim());
      identity = {accountKey,owner:portal.owner,activeSemester:session?.accountKey === accountKey ? session.activeSemester : null,expires:Date.now()+TTL*1000};
    } else {
      if (!session?.cookies.length) throw new AppError('Conectá Sapientia primero.',401);
      portal = new Portal(session.cookies, fetcher); catalog = await portal.catalog(); identity = session;
    }
    const semesters = semestersOf(catalog);
    const requested = path === '/api/semester' ? String(body.semesterId || '') : identity.activeSemester;
    if (path === '/api/semester' && !semesters.some(s=>s.id===requested)) throw new AppError('Ese semestre no pertenece a tu cuenta.');
    const target = semesters.some(s=>s.id===requested) ? requested : semesters[0]?.id ?? null;
    const records = catalog.filter(r=>semesterId(r)===target);
    const courses = await portal.courses(records);
    identity.activeSemester = target; identity.cookies = portal.cookies;
    const cookie = setCookie(await seal(identity,env.SESSION_KEY));
    return json({accountKey:identity.accountKey,owner:identity.owner,activeSemester:target,semesters,courses,
      career:[...new Set(records.map(r=>r.carrera).filter(Boolean))].sort().join(' · '),
      semester:semesters.find(s=>s.id===target)?.label || 'Sin materias inscriptas',lastSync:new Date().toISOString()},200,cookie);
  } catch (error) {
    return json({error:error instanceof AppError ? error.message : 'No se pudo consultar Sapientia. Tus registros siguen en este navegador; probá reconectar.'},error instanceof AppError ? error.status : 502);
  }
}
export default {fetch(request, env) { return handle(request, env); }};
