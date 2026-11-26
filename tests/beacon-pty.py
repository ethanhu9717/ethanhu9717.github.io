"""Optional macOS/Linux PTY integration check; uses only temporary user data."""
import fcntl
import json
import os
import pathlib
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

with tempfile.TemporaryDirectory(prefix='beacon-pty-') as root:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    env = dict(os.environ, BEACON_WORKSPACE=root, BEACON_CONFIG=root + '/config.json')
    proc = subprocess.Popen(['node', 'scripts/admin.mjs'], stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    output = b''

    def drain(delay=.2):
        global output
        stop = time.time() + delay
        while time.time() < stop:
            if select.select([master], [], [], .03)[0]:
                try:
                    output += os.read(master, 65536)
                except OSError:
                    break

    def send(data, delay=.2):
        os.write(master, data.encode())
        drain(delay)

    try:
        drain()
        send('\x0e')
        send('\x1b[200~中文写作🙂\n第二行\x1b[201~', 1.1)
        files = list(pathlib.Path(root, 'src/content/drafts').glob('*.md'))
        assert len(files) == 1, output[-1500:]
        assert '中文写作🙂\n第二行' in files[0].read_text()
        send('\x10')
        assert '终端阅读预览'.encode() in output
        send('\x1b')
        send('\x14')
        send('\r')
        send('测试标题\r', 1.1)
        assert '测试标题' in files[0].read_text(), files[0].read_text()
        send('\x0e')
        send('第二篇正文', 1.1)
        files = list(pathlib.Path(root, 'src/content/drafts').glob('*.md'))
        assert len(files) == 2
        assert sum('第二篇正文' in f.read_text() for f in files) == 1
        assert sum('中文写作🙂' in f.read_text() for f in files) == 1
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 8, 25, 0, 0))
        proc.send_signal(signal.SIGWINCH)
        drain()
        send('\x13')
        send('\x03')
        proc.wait(timeout=3)
        assert proc.returncode == 0
        assert json.loads(pathlib.Path(root, '.beacon/state.json').read_text())['lastId']
        os.close(master)
        # Restart with old-compatible preferences, then exercise Vim undo/redo.
        pathlib.Path(root, 'config.json').write_text(json.dumps({
            'editorKeymap': 'vim', 'editorLineNumbers': True,
            'autoSaveEnabled': True, 'theme': 'dark', 'obsoletePreference': 'ignored'
        }))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        proc = subprocess.Popen(['node', 'scripts/admin.mjs'], stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        output = b''
        drain(.4)
        assert '第二篇正文'.encode() in output
        send('a追加文字')
        send('\x1b')
        send('u', 1.1)
        assert not any('追加文字' in f.read_text() for f in files)
        send('\x12', 1.1)
        assert sum('追加文字' in f.read_text() for f in files) == 1
        send('\x13')
        proc.kill()
        proc.wait(timeout=3)
        os.close(master)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        proc = subprocess.Popen(['node', 'scripts/admin.mjs'], stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        output = b''
        drain(.4)
        assert '追加文字'.encode() in output
        send('\x03')
        proc.wait(timeout=3)
        print('PTY PASS: paste, autosave, preview/back, metadata, switching, resize, resume, Vim undo/redo, SIGKILL recovery')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
