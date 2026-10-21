"""Personal, loopback-only attendance tracker. Python standard library only."""
from __future__ import annotations

import argparse
import copy
import hashlib
import html
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
DATA_FILE = ROOT / 'data' / 'state.json'
BASE = 'https://alumnos.sapientia.uc.edu.py'
COLORS = ['violet', 'blue', 'teal']


def account_key(username):
    return hashlib.sha256(username.strip().encode('utf8')).hexdigest()


def empty_state():
    return dict(version=1, revision=0, owner='Mi cuenta', career='', semester='',
                accountKey=None, activeSemester=None, semesters=[], lastSync=None,
                sourceDate=now_iso()[:10], courses=[], personal={}, examWeeks=[None, None])


def semester_id(row):
    return str(row.get('periodo_lectivo_id') or row.get('cal_periodo_lectivo_id') or
               f'{row.get("anho_academico", "")}-{row.get("periodo_lectivo_orden", "")}-{row.get("periodo_lectivo", "Sin período")}')


def semester_options(records):
    result = {}
    for row in records:
        sid = semester_id(row)
        option = result.setdefault(sid, dict(id=sid, label=str(row.get('periodo_lectivo') or 'Período sin nombre'),
                   year=int(row.get('anho_academico') or 0), order=int(row.get('periodo_lectivo_orden') or 0), count=0))
        option['count'] += 1
    return sorted(result.values(), key=lambda r: (r['year'], r['order'], r['id']), reverse=True)


def now_iso():
    return datetime.now(timezone(timedelta(hours=-3))).isoformat(timespec='seconds')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


class PortalError(Exception):
    pass


class SameSiteRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlparse(newurl).hostname != 'alumnos.sapientia.uc.edu.py':
            raise PortalError('El portal redirigió a otro sitio. No se continuó el acceso.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Portal:
    def __init__(self):
        self.catalog = []
        self.owner = 'Mi cuenta'
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), SameSiteRedirect())

    def request(self, path, body=None):
        request = urllib.request.Request(BASE + path, data=body, headers={
            'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': 'MiAsistencia/1.0 (personal attendance tracker)'})
        with self.opener.open(request, timeout=25) as response:
            return response.read(3_000_000).decode('utf-8-sig')

    def login(self, username, password):
        self.request('/')
        payload = urllib.parse.urlencode({'Credenciales[cedula]': username,
                                         'Credenciales[contrasenha]': password, 'preinsc': ''}).encode()
        page = self.request('/login/try', payload)
        match = re.search(r'var\s+usuario_logueado\s*=\s*("(?:[^"\\]|\\.)*")', page)
        if match:
            try:
                self.owner = html.unescape(json.loads(match.group(1)).split(' - ')[0]).strip() or 'Mi cuenta'
            except ValueError:
                pass
        # Verify through an authenticated read, not merely the HTTP status of the login.
        self.refresh_catalog()

    def refresh_catalog(self):
        self.catalog = self.fetch('/cursos/cursos/current-index', {'p[limit]': 100, 'p[page]': 1})
        if any(not r.get('prg_curso_id') for r in self.catalog):
            raise PortalError('No se pudo identificar las materias de esta cuenta.')

    def fetch(self, path, params):
        result, expected, seen_pages = [], None, set()
        params = dict(params)
        for page_number in range(1, 101):
            params['p[page]'] = page_number
            try:
                data = json.loads(self.request(path + '?' + urllib.parse.urlencode(params)))
            except json.JSONDecodeError:
                raise PortalError('Sapientia no devolvió datos. Revisá tus credenciales o reconectá la sesión.') from None
            rows = data.get('records') if isinstance(data, dict) else None
            if not isinstance(rows, list):
                raise PortalError('La respuesta del portal es inválida.')
            total = int(data.get('numResults', len(rows)))
            if expected is None:
                expected = total
            if expected != total or (len(result) < total and not rows):
                raise PortalError('La respuesta está incompleta. Se conservaron los datos anteriores.')
            signature = json.dumps(rows, sort_keys=True)
            if signature in seen_pages:
                raise PortalError('El portal repitió una página de resultados.')
            seen_pages.add(signature)
            result.extend(rows)
            if len(result) == expected:
                return result
            if len(result) > expected:
                break
        raise PortalError('No se pudo obtener el listado completo del portal.')

    def courses(self, selected_semester):
        result = []
        records = [r for r in self.catalog if semester_id(r) == selected_semester]
        unique = {str(r['prg_curso_id']): r for r in records}
        for index, (cid, record) in enumerate(unique.items()):
            name = str(record.get('asignatura') or f'Materia {cid}')
            code = str(record.get('codigo') or '')
            short = re.sub(r'\s*\([^)]*\)\s*$', '', name).strip()
            course = dict(id=cid, name=short, short=short, code=code, color=COLORS[index % len(COLORS)],
                          section=str(record.get('seccion') or '').strip(), rows=[], summary=[], error=None)
            params = {'s[id]': cid, 'p[limit]': 200, 'p[page]': 1}
            try:
                rows = self.fetch('/cursos/cursos/get-asistencia', {**params, 'sort[property]': 'fecha', 'sort[direction]': 'ASC'})
                summary = self.fetch('/cursos/cursos/get-asistencia-por-tipo', params)
                global_row = next((r for r in summary if r.get('tipo_clase') == 'GLOBAL'), None)
                if not rows or not global_row or float(global_row['cnt_horas_catedras']) <= 0:
                    raise PortalError('Esta materia todavía no tiene un calendario de asistencia calculable.')
                if len({r.get('asis_clase_id') for r in rows}) != len(rows):
                    raise PortalError('El detalle del portal contiene clases duplicadas.')
                if sum(float(r['cnt_horas_catedras']) for r in rows) != float(global_row['cnt_horas_catedras']):
                    raise PortalError('El resumen y el calendario no coinciden; no se puede proyectar con seguridad.')
                course.update(rows=rows, summary=summary)
            except PortalError as error:
                if 'credenciales' in str(error):
                    raise
                course['error'] = str(error)
            except (ValueError, KeyError, TypeError):
                course['error'] = 'El portal devolvió datos de asistencia que no se pueden calcular.'
            result.append(course)
        return result


class Store:
    def __init__(self, path=DATA_FILE):
        self.path = path
        self.lock = threading.RLock()
        self.sync_lock = threading.Lock()
        self.csrf = secrets.token_urlsafe(32)
        self.portal = None
        self.auto_sync = False
        self.last_attempt = 0.0
        self.sync_status = {'connected': False, 'running': False, 'message': 'Iniciá sesión en Sapientia para cargar o actualizar tus materias.'}
        self.state = read_json(path) if path.exists() else empty_state()
        if 'examWeeks' not in self.state:
            self.state['examWeeks'] = [None, None]
            self.state['revision'] += 1
        self.save()

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.tmp')
        temp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temp, self.path)
        profile = self.profile_path(self.state.get('accountKey'), self.state.get('activeSemester'))
        if profile is not None:
            profile.parent.mkdir(parents=True, exist_ok=True)
            temp = profile.with_suffix('.tmp')
            temp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(temp, profile)

    def profile_path(self, key, semester):
        if not key or semester is None:
            return None
        safe_key = hashlib.sha256(str(key).encode()).hexdigest()
        safe_semester = hashlib.sha256(str(semester).encode()).hexdigest()
        return self.path.parent / 'accounts' / safe_key / f'{safe_semester}.json'

    def snapshot(self):
        with self.lock:
            return {**copy.deepcopy(self.state), 'csrf': self.csrf,
                    'sync': {**self.sync_status, 'auto': self.auto_sync, 'intervalMinutes': 15}}

    def personal(self, body):
        with self.lock:
            if body.get('revision') != self.state['revision']:
                raise ValueError('Los datos cambiaron en otra ventana. Se actualizará la pantalla; repetí tu cambio.')
            cid = str(body.get('courseId'))
            course = next((c for c in self.state['courses'] if c['id'] == cid), None)
            if course is None:
                raise ValueError('Materia desconocida.')
            rows = {str(r['asis_clase_id']): r for r in course['rows']}
            overrides = body.get('overrides', {})
            planned = body.get('planned', [])
            if not isinstance(overrides, dict) or not isinstance(planned, list):
                raise ValueError('Registro inválido.')
            clean = {}
            for rid, override in overrides.items():
                if rid not in rows or not isinstance(override, dict) or override.get('status') not in ('present', 'absent', 'pending'):
                    raise ValueError('Asistencia inválida.')
                if rows[rid]['cnt_horas_asistidas'] == 'Feriado' or rows[rid]['fecha'] > now_iso()[:10]:
                    raise ValueError('Las marcas personales solo corresponden a clases pasadas o de hoy.')
                clean[rid] = {'status': override['status'], 'updatedAt': override.get('updatedAt', now_iso())}
            if any(not isinstance(rid, str) or rid not in rows for rid in planned):
                raise ValueError('Plan inválido.')
            self.state['personal'][cid] = {'overrides': clean, 'planned': list(dict.fromkeys(planned))}
            self.state['revision'] += 1
            self.save()

    def exam_weeks(self, body):
        with self.lock:
            if body.get('revision') != self.state['revision']:
                raise ValueError('Los datos cambiaron en otra ventana. Se actualizará la pantalla; repetí tu cambio.')
            weeks = body.get('examWeeks')
            if not isinstance(weeks, list) or len(weeks) != 2:
                raise ValueError('Elegí como máximo las dos semanas de parciales.')
            all_dates = [date.fromisoformat(r['fecha']) for c in self.state['courses'] for r in c['rows']]
            if not all_dates:
                raise ValueError('Primero cargá un semestre con clases disponibles.')
            semester_start, semester_end = min(all_dates), max(all_dates)
            clean = []
            for value in weeks:
                if value is None or value == '':
                    clean.append(None)
                    continue
                if not isinstance(value, str) or len(value) != 10:
                    raise ValueError('Fecha de parcial inválida.')
                try:
                    selected = date.fromisoformat(value)
                except ValueError:
                    raise ValueError('Fecha de parcial inválida.') from None
                monday = selected - timedelta(days=selected.weekday())
                if monday > semester_end or monday + timedelta(days=6) < semester_start:
                    raise ValueError('La semana debe estar dentro de este semestre.')
                clean.append(monday.isoformat())
            if all(clean) and clean[1] <= clean[0]:
                raise ValueError('La segunda semana debe ser posterior a la primera.')
            self.state['examWeeks'] = clean
            self.state['revision'] += 1
            self.save()

    def sync(self, username=None, password=None, selected_semester=None):
        if not self.sync_lock.acquire(blocking=False):
            raise PortalError('Ya hay una actualización en curso.')
        with self.lock:
            self.sync_status['running'] = True
        try:
            portal = self.portal
            key = self.state.get('accountKey')
            if username is not None:
                portal = Portal()
                portal.login(username, password)
                key = account_key(username)
            elif portal is not None:
                portal.refresh_catalog()
            if portal is None:
                raise PortalError('Conectá Sapientia primero.')
            semesters = semester_options(portal.catalog)
            ids = [s['id'] for s in semesters]
            if selected_semester is not None and selected_semester not in ids:
                raise PortalError('Ese semestre no pertenece al listado de tu cuenta.')
            same_account = key == self.state.get('accountKey')
            target = selected_semester or (self.state.get('activeSemester') if same_account else None)
            if target not in ids:
                target = ids[0] if ids else None
            courses = portal.courses(target) if target else []
            with self.lock:
                same_profile = same_account and target == self.state.get('activeSemester')
                if same_profile:
                    updated = copy.deepcopy(self.state)
                else:
                    saved = self.profile_path(key, target)
                    updated = read_json(saved) if saved and saved.exists() else empty_state()
                updated.update(accountKey=key, activeSemester=target, semesters=semesters,
                               owner=portal.owner, career=' · '.join(sorted({str(r.get('carrera')) for r in portal.catalog
                               if semester_id(r) == target and r.get('carrera')})),
                               semester=next((s['label'] for s in semesters if s['id'] == target), 'Sin materias inscriptas'),
                               courses=courses, lastSync=now_iso(), revision=self.state['revision'] + 1)
                for course in courses:
                    updated['personal'].setdefault(course['id'], {'overrides': {}, 'planned': []})
                self.state = updated
                self.portal = portal
                self.auto_sync = True
                if not same_account:
                    self.csrf = secrets.token_urlsafe(32)
                self.save()
                self.sync_status = {'connected': True, 'running': False, 'message': f'Sapientia actualizado: {len(courses)} materias. Tus registros se guardan por cuenta y semestre.'}
        except Exception as error:
            with self.lock:
                message = str(error) if isinstance(error, PortalError) else 'No se pudo consultar Sapientia. Tus datos guardados siguen disponibles; probá reconectar.'
                self.sync_status = {'connected': self.portal is not None, 'running': False, 'message': message}
                self.auto_sync = False
            raise PortalError(message) from None
        finally:
            self.last_attempt = time.monotonic()
            self.sync_lock.release()

    def background(self):
        while True:
            time.sleep(20)
            if self.auto_sync and self.portal is not None and time.monotonic() - self.last_attempt >= 900:
                try:
                    self.sync()
                except PortalError:
                    pass


def handler_for(store):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # No request bodies, authentication data or personal records in logs.
            pass

        def allowed_host(self):
            return self.headers.get('Host') in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

        def send(self, status, data, content_type='application/json; charset=utf-8'):
            if not isinstance(data, bytes):
                data = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if not self.allowed_host():
                return self.send(403, {'error': 'Host no permitido.'})
            path = urllib.parse.urlparse(self.path).path
            if path == '/api/state':
                return self.send(200, store.snapshot())
            if path == '/api/export':
                state = store.snapshot()
                state.pop('csrf')
                state.pop('sync')
                return self.send(200, state)
            assets = {'/': ('index.html', 'text/html; charset=utf-8'),
                      '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                      '/api.js': ('api.js', 'text/javascript; charset=utf-8'),
                      '/model.js': ('model.js', 'text/javascript; charset=utf-8'),
                      '/style.css': ('style.css', 'text/css; charset=utf-8'),
                      '/favicon.svg': ('favicon.svg', 'image/svg+xml')}
            if path not in assets:
                return self.send(404, {'error': 'No encontrado.'})
            filename, mime = assets[path]
            self.send(200, (STATIC / filename).read_bytes(), mime)

        def do_POST(self):
            origin = self.headers.get('Origin')
            if (not self.allowed_host() or self.headers.get('X-CSRF-Token') != store.csrf or
                    (origin and origin not in (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'))):
                return self.send(403, {'error': 'Solicitud no permitida.'})
            try:
                length = int(self.headers.get('Content-Length', 0))
                if not 0 < length <= 100_000:
                    return self.send(400, {'error': 'Tamaño de solicitud inválido.'})
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError('Solicitud inválida.')
                if self.path == '/api/personal':
                    store.personal(body)
                elif self.path == '/api/exam-weeks':
                    store.exam_weeks(body)
                elif self.path == '/api/connect':
                    username, password = body.get('username', ''), body.get('password', '')
                    if not isinstance(username, str) or not isinstance(password, str) or not username.strip() or not password:
                        raise ValueError('Ingresá usuario y contraseña.')
                    store.sync(username.strip(), password)
                elif self.path == '/api/sync':
                    store.sync()
                elif self.path == '/api/semester':
                    if body.get('revision') != store.state['revision']:
                        raise ValueError('Los datos cambiaron en otra ventana. Volvé a elegir el semestre.')
                    store.sync(selected_semester=str(body.get('semesterId', '')))
                elif self.path == '/api/logout':
                    with store.sync_lock, store.lock:
                        revision = store.state['revision'] + 1
                        store.portal = None
                        store.auto_sync = False
                        store.state = empty_state()
                        store.state['revision'] = revision
                        store.csrf = secrets.token_urlsafe(32)
                        store.sync_status = {'connected': False, 'running': False, 'message': 'Sesión cerrada. Iniciá sesión para abrir tus registros.'}
                        store.save()
                elif self.path == '/api/disconnect':
                    with store.sync_lock, store.lock:
                        store.portal = None
                        store.auto_sync = False
                        store.sync_status = {'connected': False, 'running': False, 'message': 'Desconectado. Tus registros locales están guardados.'}
                else:
                    return self.send(404, {'error': 'Ruta desconocida.'})
                return self.send(200, store.snapshot())
            except ValueError as error:
                return self.send(409 if 'otra ventana' in str(error) else 400, {'error': str(error)})
            except PortalError as error:
                return self.send(502, {'error': str(error)})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    store = Store()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler_for(store))
    threading.Thread(target=store.background, daemon=True).start()
    print(f'Mi asistencia: http://127.0.0.1:{args.port}', flush=True)
    print('Datos guardados localmente. Ctrl+C para cerrar.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
