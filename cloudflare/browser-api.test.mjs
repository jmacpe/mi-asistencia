import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,mergeSnapshot,updatePersonal,updateExamWeeks,request} from './browser-api.js';
import {handle} from './worker.js';

function state(account='A',semester='1') {
  return {...emptyState(),accountKey:account,activeSemester:semester,courses:[{id:'demo',rows:[{asis_clase_id:'a',fecha:'2026-10-05',cnt_horas_asistidas:'2'},{asis_clase_id:'b',fecha:'2026-10-20',cnt_horas_asistidas:'2'}]}],personal:{demo:{overrides:{a:{status:'present'}},planned:['b']}},examWeeks:['2026-10-05',null]};
}
test('actualizar mantiene marcas; otra cuenta o semestre no las hereda',()=> {
  const original=state();
  const snapshot={accountKey:'A',activeSemester:'1',courses:original.courses};
  assert.deepEqual(mergeSnapshot(snapshot,original).personal,original.personal);
  for(const change of [{accountKey:'B'},{activeSemester:'2'}]) {
    const merged=mergeSnapshot({...snapshot,...change},original);
    assert.deepEqual(merged.personal.demo,{overrides:{},planned:[]});
    assert.deepEqual(merged.examWeeks,[null,null]);
  }
});
test('rechaza guardados de otra revisión y clases ajenas',()=> {
  const s=state();
  assert.throws(()=>updatePersonal(s,{revision:s.revision-1}),/otra ventana/);
  assert.throws(()=>updatePersonal(s,{revision:s.revision,courseId:'demo',overrides:{bad:{status:'present'}},planned:[]}),/inválida/);
  const result=updatePersonal(s,{revision:s.revision,courseId:'demo',overrides:{a:{status:'absent'}},planned:['b','b']});
  assert.equal(result.personal.demo.overrides.a.status,'absent');
  assert.deepEqual(result.personal.demo.planned,['b']);
});
test('parciales se normalizan; rechaza fechas imposibles, invertidas o fuera de semestre',()=> {
  const s=state();
  assert.deepEqual(updateExamWeeks(s,{revision:s.revision,examWeeks:['2026-10-06','2026-10-20']}).examWeeks,['2026-10-05','2026-10-19']);
  for(const weeks of [['2026-02-30',null],['2026-10-20','2026-10-05'],['2027-01-01',null]]) assert.throws(()=>updateExamWeeks(s,{revision:s.revision,examWeeks:weeks}));
});

test('flujo completo: login, guardar, cambiar cuenta, logout y recuperar sin mezclar datos',async()=> {
  const originalFetch=globalThis.fetch, originalStorage=globalThis.localStorage;
  const storage=new Map(); let cookie='';
  globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
  const env={SESSION_KEY:'c3'.repeat(32)};
  const portalFetch=async url=> {
    const path=new URL(url).pathname;
    if(path==='/') return new Response('login',{headers:{'Set-Cookie':'session=example; Path=/'}});
    if(path==='/login/try') return new Response('var usuario_logueado = "Cuenta ficticia";');
    const records=path.endsWith('current-index')?[{prg_curso_id:'demo',periodo_lectivo_id:'1',asignatura:'Ejemplo'}]
      :path.endsWith('get-asistencia-por-tipo')?[{tipo_clase:'GLOBAL',cnt_horas_catedras:'2',porc_asistencia:'100'}]
      :[{asis_clase_id:'a',fecha:'2026-10-05',cnt_horas_catedras:'2',cnt_horas_asistidas:'2',asistencia_cargada:'S'}];
    return new Response(JSON.stringify({records,numResults:records.length}));
  };
  globalThis.fetch=async(path,options={})=> {
    const response=await handle(new Request('https://test.pages.dev'+path,{...options,headers:{...options.headers,Origin:'https://test.pages.dev',Cookie:cookie}}),env,portalFetch);
    if(response.headers.has('Set-Cookie')) cookie=response.headers.get('Set-Cookie').split(';')[0];
    return response;
  };
  try {
    assert.equal((await request('/api/state')).accountKey,null);
    let a=await request('/api/connect',{username:'alice',password:'fake-password'});
    a=await request('/api/personal',{revision:a.revision,courseId:'demo',overrides:{a:{status:'absent'}},planned:[]},a);
    const b=await request('/api/connect',{username:'bob',password:'fake-password'},a);
    assert.notEqual(a.accountKey,b.accountKey);
    assert.deepEqual(b.personal.demo.overrides,{});
    await assert.rejects(request('/api/personal',{revision:a.revision,courseId:'demo',overrides:{},planned:[]},a),/cuenta cambió/);
    assert.equal((await request('/api/logout',{},b)).accountKey,null);
    assert.equal((await request('/api/state')).accountKey,null);
    a=await request('/api/connect',{username:'alice',password:'fake-password'});
    assert.equal(a.personal.demo.overrides.a.status,'absent');
    a=await request('/api/sync',{},a);
    assert.equal(a.personal.demo.overrides.a.status,'absent');
    a=await request('/api/disconnect',{},a);
    assert.equal(a.sync.connected,false);
    assert.equal((await request('/api/state')).personal.demo.overrides.a.status,'absent');
    assert.ok(![...storage.values()].join('').includes('fake-password'));
  } finally {
    globalThis.fetch=originalFetch;
    if(originalStorage===undefined) delete globalThis.localStorage; else globalThis.localStorage=originalStorage;
  }
});
