import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {handle, seal, unseal, Portal, semestersOf} from './worker.js';

const SECRET = 'a1'.repeat(32);
const env = {SESSION_KEY:SECRET,ASSETS:{fetch:async()=>new Response('asset')}};
const origin = 'https://example.pages.dev';
const jsonResponse = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const record = {prg_curso_id:'demo',periodo_lectivo_id:'current',asignatura:'Materia ficticia',anho_academico:2026,periodo_lectivo_orden:2};
const rows = [{asis_clase_id:'row',fecha:'2026-10-19',cnt_horas_catedras:'2',cnt_horas_asistidas:'2',asistencia_cargada:'S'}];
const summary = [{tipo_clase:'GLOBAL',cnt_horas_catedras:'2',porc_asistencia:'100'}];
function mockPortal() {
  const calls=[];
  return {calls,fetcher:async(url,options)=> {
    calls.push({url,options});
    const path = new URL(url).pathname;
    if (path === '/') return new Response('login',{headers:{'Set-Cookie':'PHPSESSID=sample; Path=/; HttpOnly; Secure'}});
    if (path === '/login/try') return new Response('var usuario_logueado = "Persona de prueba - Alumno";');
    assert.equal(options.headers.Cookie,'PHPSESSID=sample');
    const records = path.endsWith('current-index') ? [record] : path.endsWith('get-asistencia-por-tipo') ? summary : rows;
    return jsonResponse({records,numResults:records.length});
  }};
}
const post = (path, body, cookie) => new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});

test('cifrado autenticado: sesiones vencidas, alteradas y de otra clave no abren',async()=> {
  const session={accountKey:'account',expires:Date.now()+60000,cookies:[]};
  const token=await seal(session,SECRET);
  assert.deepEqual(await unseal(token,SECRET),session);
  assert.equal(await unseal(token,'b2'.repeat(32)),null);
  assert.equal(await unseal(token.slice(0,30)+(token[30]==='A'?'B':'A')+token.slice(31),SECRET),null);
  assert.equal(await unseal(await seal({...session,expires:1},SECRET),SECRET),null);
  assert.ok(!token.includes('account'));
});

test('login entrega solo datos de cuenta, cookie HttpOnly y ninguna contraseña',async()=> {
  const mock=mockPortal();
  const response=await handle(post('/api/connect',{username:'demo',password:'test-secret'}),env,mock.fetcher);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.courses.length,1);
  assert.equal(body.owner,'Persona de prueba');
  assert.equal(body.activeSemester,'current');
  assert.ok(!JSON.stringify(body).includes('test-secret'));
  const cookie=response.headers.get('Set-Cookie');
  assert.match(cookie,/Secure; HttpOnly; SameSite=Strict/);
  const session=await unseal(cookie.split(';')[0].split('=')[1],SECRET);
  assert.equal(session.cookies[0].value,'sample');
  assert.ok(!JSON.stringify(session).includes('test-secret'));
  assert.equal(mock.calls.filter(c=>c.options.body?.includes('test-secret')).length,1);
  const state=await handle(new Request(origin+'/api/session',{headers:{Cookie:cookie.split(';')[0]}}),env);
  assert.equal((await state.json()).accountKey,body.accountKey);
});

test('rechaza solicitudes cruzadas y no permite seleccionar un semestre ajeno',async()=> {
  const mock=mockPortal();
  const malicious=new Request(origin+'/api/connect',{method:'POST',headers:{Origin:'https://other.test','Content-Type':'application/json'},body:'{}'});
  assert.equal((await handle(malicious,env,mock.fetcher)).status,403);
  assert.equal(mock.calls.length,0);
  const cookie='__Host-asistencia='+await seal({accountKey:'A',owner:'A',activeSemester:'current',cookies:[{name:'PHPSESSID',value:'sample',path:'/'}],expires:Date.now()+60000},SECRET);
  const response=await handle(post('/api/semester',{semesterId:'not-owned'},cookie),env,mock.fetcher);
  assert.equal(response.status,400);
  assert.equal(mock.calls.length,1);
});

test('desconectar retiene identidad sin cookies del portal; logout borra cookie',async()=> {
  const cookie='__Host-asistencia='+await seal({accountKey:'A',cookies:[{name:'s',value:'x',path:'/'}],expires:Date.now()+60000},SECRET);
  const response=await handle(post('/api/disconnect',{},cookie),env);
  const token=response.headers.get('Set-Cookie').split(';')[0].split('=')[1];
  const session=await unseal(token,SECRET);
  assert.equal(session.accountKey,'A'); assert.deepEqual(session.cookies,[]);
  assert.match((await handle(post('/api/logout',{},cookie),env)).headers.get('Set-Cookie'),/Max-Age=0/);
});

test('los visitantes anónimos no ven perfiles ajenos ni consultan el portal',async()=> {
  const mock=mockPortal();
  const response=await handle(new Request(origin+'/api/session'),env,mock.fetcher);
  assert.deepEqual(await response.json(),{accountKey:null,connected:false});
  assert.equal((await handle(post('/api/sync',{}),env,mock.fetcher)).status,401);
  assert.equal(mock.calls.length,0);
});

test('no reenvía credenciales ni cookies a redirecciones de otro dominio',async()=> {
  let count=0;
  const portal=new Portal([],async()=>{count++;return new Response(null,{status:307,headers:{Location:'https://elsewhere.test'}});});
  await assert.rejects(portal.request('/login/try','sensitive'),/otro sitio/);
  assert.equal(count,1);
});

test('paginación completa y repetición detectada',async()=> {
  let calls=0;
  const portal=new Portal([],async()=>jsonResponse({records:[{id:++calls}],numResults:2}));
  assert.deepEqual(await portal.fetchRows('/list'),[{id:1},{id:2}]);
  const repeated=new Portal([],async()=>jsonResponse({records:[{id:1}],numResults:2}));
  await assert.rejects(repeated.fetchRows('/list'),/incompleta/);
});

test('resumen inconsistente invalida solamente esa materia',async()=> {
  const portal=new Portal();
  portal.fetchRows=async path=>path.endsWith('por-tipo')?[{...summary[0],cnt_horas_catedras:'10'}]:rows;
  const courses=await portal.courses([record]);
  assert.match(courses[0].error,/no coinciden/);
  assert.deepEqual(courses[0].rows,[]);
});

test('períodos ordenados y sin duplicados',()=> {
  const periods=semestersOf([record,{...record,periodo_lectivo_id:'old',anho_academico:2025},record]);
  assert.equal(periods.length,2); assert.equal(periods[0].id,'current'); assert.equal(periods[0].count,2);
});

test('firma real del Worker acepta ExecutionContext y aplica cabeceras a assets',async()=> {
  const result=await worker.fetch(new Request(origin+'/app.js'),env,{});
  assert.equal(await result.text(),'asset');
  assert.equal(result.headers.get('Cache-Control'),'no-store');
  assert.equal((await worker.fetch(new Request(origin+'/seed.json'),env,{})).status,404);
  assert.equal((await worker.fetch(new Request(origin+'/api/session'),env,{})).status,200);
});
