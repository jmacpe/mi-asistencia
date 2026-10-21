import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Store, Portal, PortalError, semester_options, account_key


def fake_course(cid):
    return dict(id=cid, name='Materia ' + cid, short='Materia ' + cid, code='TEST', color='blue', error=None,
                rows=[dict(asis_clase_id=int(cid)*10, fecha='2026-10-12', cnt_horas_catedras='2',
                           asistencia_cargada='N', cnt_horas_asistidas=None)],
                summary=[dict(tipo_clase='GLOBAL', cnt_horas_catedras='2', cnt_horas_asistidas='0', porc_asistencia='0')])


class FakePortal:
    def login(self, username, password):
        if password == 'wrong':
            raise PortalError('Credenciales inválidas')
        self.owner = 'Cuenta ' + username
        self.catalog = [] if username == 'empty' else [
            dict(prg_curso_id='91', asignatura='Antigua', periodo_lectivo_id=10, anho_academico=2026, periodo_lectivo_orden=1, periodo_lectivo='Primer semestre'),
            dict(prg_curso_id='92', asignatura='Actual', periodo_lectivo_id=20, anho_academico=2026, periodo_lectivo_orden=2, periodo_lectivo='Segundo semestre')]

    def refresh_catalog(self):
        pass

    def courses(self, period):
        return [fake_course('92' if period == '20' else '91')]


class AccountsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / 'state.json')
        self.mock = patch('server.Portal', FakePortal)
        self.mock.start()

    def tearDown(self):
        self.mock.stop()
        self.temp.cleanup()

    def test_clean_install_has_no_personal_data(self):
        self.assertEqual(self.store.state['courses'], [])
        self.assertEqual(self.store.state['examWeeks'], [None, None])
        self.assertIsNone(self.store.state['accountKey'])

    def test_accounts_and_semesters_do_not_mix_and_restore(self):
        s = self.store
        s.sync('alice', 'ok')
        self.assertEqual(s.state['activeSemester'], '20')
        initial_token = s.csrf
        s.personal(dict(revision=s.state['revision'], courseId='92', overrides={'920': {'status': 'present'}}, planned=[]))
        s.exam_weeks(dict(revision=s.state['revision'], examWeeks=['2026-10-12', None]))
        saved_marks = copy.deepcopy(s.state['personal'])
        s.sync(selected_semester='10')
        self.assertEqual(s.state['personal'], {'91': {'overrides': {}, 'planned': []}})
        self.assertEqual(s.state['examWeeks'], [None, None])
        s.sync(selected_semester='20')
        self.assertEqual(s.state['personal'], saved_marks)
        s.sync('bob', 'ok')
        self.assertNotEqual(s.csrf, initial_token)
        self.assertEqual(s.state['personal']['92']['overrides'], {})
        self.assertEqual(s.state['examWeeks'], [None, None])
        s.personal(dict(revision=s.state['revision'], courseId='92', overrides={'920': {'status': 'absent'}}, planned=[]))
        s.sync('alice', 'ok')
        self.assertEqual(s.state['personal'], saved_marks)
        self.assertEqual(s.state['examWeeks'], ['2026-10-12', None])
        self.assertEqual(Store(s.path).state['personal'], saved_marks)

    def test_failed_login_and_invalid_period_keep_current_data(self):
        self.store.sync('alice', 'ok')
        before = copy.deepcopy(self.store.state)
        with self.assertRaises(PortalError): self.store.sync('bob', 'wrong')
        self.assertEqual(self.store.state, before)
        with self.assertRaises(PortalError): self.store.sync(selected_semester='outside')
        self.assertEqual(self.store.state, before)

    def test_empty_account_can_sign_in_without_another_accounts_data(self):
        self.store.sync('alice', 'ok')
        self.store.sync('empty', 'ok')
        self.assertEqual(self.store.state['courses'], [])
        self.assertEqual(self.store.state['personal'], {})
        self.assertTrue(self.store.sync_status['connected'])


class CatalogTests(unittest.TestCase):
    def test_pagination_loads_all_pages(self):
        p = Portal()
        pages = [json.dumps(dict(records=[{'n':1},{'n':2}],numResults=3)), json.dumps(dict(records=[{'n':3}],numResults=3))]
        with patch.object(p, 'request', side_effect=pages) as request:
            self.assertEqual(len(p.fetch('/test', {'p[limit]':2})),3)
            self.assertIn('p%5Bpage%5D=2', request.call_args.args[0])

    def test_arbitrary_materias_and_missing_calendar(self):
        p = Portal()
        p.catalog = [dict(prg_curso_id='888', asignatura='Nueva materia (NEW)', codigo='NEW', periodo_lectivo_id=8)]
        course = fake_course('888')
        with patch.object(p, 'fetch', side_effect=[course['rows'],course['summary']]):
            result=p.courses('8')
        self.assertEqual(result[0]['id'],'888')
        self.assertEqual(result[0]['name'],'Nueva materia')
        with patch.object(p, 'fetch', side_effect=[[],[]]):
            result=p.courses('8')
        self.assertTrue(result[0]['error'])
        self.assertEqual(result[0]['rows'],[])

    def test_catalog_sorted_by_year_and_period_not_inscription_date(self):
        catalog=[dict(periodo_lectivo_id=1,anho_academico=2025,periodo_lectivo_orden=2),
                 dict(periodo_lectivo_id=2,anho_academico=2026,periodo_lectivo_orden=1),
                 dict(periodo_lectivo_id=3,anho_academico=2026,periodo_lectivo_orden=2)]
        self.assertEqual([s['id'] for s in semester_options(catalog)],['3','2','1'])


if __name__ == '__main__':
    unittest.main()
