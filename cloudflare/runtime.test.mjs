import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('la consulta usa el fetch nativo de Workers con el contexto correcto', async () => {
  // Node fetch and injected mocks do not enforce the receiver check that workerd enforces.
  const source = (await readFile(new URL('./worker.js', import.meta.url), 'utf8')).replace(
    'export default {fetch(request, env) { return handle(request, env); }};',
    `export default {async fetch() {
      try {return Response.json({body:await new Portal().request('/')});}
      catch(error) {return Response.json({error:error.message}, {status:500});}
    }};`
  );
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules:true, script:source, compatibilityDate:'2026-10-21',
    outboundService(request) {
      assert.equal(new URL(request.url).origin, 'https://apialumnos.sapientia.uc.edu.py');
      calls++;
      return new Response('portal de prueba');
    }
  }));
  try {
    const response = await mf.dispatchFetch('http://localhost/');
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    assert.deepEqual(result, {body:'portal de prueba'});
    assert.equal(calls, 1);
  } finally {await mf.dispose();}
});
