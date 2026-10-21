import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const out = new URL('dist/', root);
await mkdir(out, {recursive:true});
const allowed = new Set(['index.html','app.js','model.js','style.css','favicon.svg','api.js','_worker.js']);
const unexpected = (await readdir(out)).filter(name=>!allowed.has(name));
if (unexpected.length) throw new Error('dist contiene archivos adicionales. Revisalos antes de publicar: '+unexpected.join(', '));
for (const name of ['index.html', 'app.js', 'model.js', 'style.css', 'favicon.svg']) {
  await copyFile(new URL(`app/static/${name}`, root), new URL(name, out));
}
const api = (await readFile(new URL('cloudflare/browser-api.js', root), 'utf8')).replace("'../app/static/model.js'", "'./model.js'");
await writeFile(new URL('api.js', out), api);
await copyFile(new URL('cloudflare/worker.js', root), new URL('_worker.js', out));
let js = await readFile(new URL('app.js', out), 'utf8');
js = js.replaceAll('computadora', 'navegador')
  .replace('La app local no responde. Abrí iniciar.cmd para reconectar; tus datos están guardados.', 'No se pudo conectar. Revisá tu conexión y recargá; tus registros siguen en este navegador.')
  .replace('Abrí iniciar.cmd y recargá esta página.', 'Revisá tu conexión y recargá esta página.');
await writeFile(new URL('app.js', out), js);
let html = await readFile(new URL('index.html', out), 'utf8');
html = html.replace('La conexión se pierde al cerrar la app.', 'La sesión dura hasta 8 horas. Las credenciales pasan por esta app en Cloudflare para conectar con Sapientia; tus marcas se guardan solo en este navegador.');
await writeFile(new URL('index.html', out), html);
console.log('Pages: dist contiene solo la interfaz y la API, sin datos personales.');
