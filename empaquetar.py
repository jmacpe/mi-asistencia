"""Build a clean sharing archive from an explicit source-only allowlist."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent
FILES = ['iniciar.cmd', 'iniciar.ps1', 'cerrar.cmd', 'cerrar.ps1', 'README.md', 'empaquetar.py',
         'app/server.py', 'app/static/index.html', 'app/static/app.js', 'app/static/api.js', 'app/static/model.js',
         'app/static/style.css', 'app/static/favicon.svg']


def main():
    output = ROOT / 'mi-asistencia-compartir.zip'
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for filename in FILES:
            archive.write(ROOT / filename, 'mi-asistencia/' + filename)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == len(FILES)
        assert not any('/data/' in n or 'seed.json' in n or '.log' in n for n in archive.namelist())
    print(f'Paquete limpio: {output.name} ({output.stat().st_size:,} bytes, {len(FILES)} archivos)')


if __name__ == '__main__':
    main()
