"""Verify the installed Beacon command in fresh login shells using isolated articles."""
import fcntl
import json
import os
import pathlib
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time


class Terminal:
    def __init__(self, command, cwd, env):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
        # Positional parameters preserve the executable path without shell interpolation.
        self.proc = subprocess.Popen(
            ['/bin/zsh', '-lic', 'exec "$1"', 'beacon-test', command],
            cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave,
        )
        os.close(slave)
        self.output = b''

    def wait_text(self, text, timeout=5):
        deadline = time.monotonic() + timeout
        while text.encode() not in self.output:
            if time.monotonic() >= deadline:
                raise AssertionError((text, self.output[-3000:]))
            if select.select([self.master], [], [], .05)[0]:
                try:
                    self.output += os.read(self.master, 65536)
                except OSError:
                    raise AssertionError(('terminal exited', self.proc.poll(), self.output[-3000:]))

    def send(self, text):
        self.output = b''
        os.write(self.master, text.encode())

    def drain(self):
        while select.select([self.master], [], [], 0)[0]:
            try:
                self.output += os.read(self.master, 65536)
            except OSError:
                break

    def finish(self):
        self.send('\x03')
        deadline = time.monotonic() + 5
        # Continue draining redraws so the PTY output buffer cannot block exit.
        while self.proc.poll() is None and time.monotonic() < deadline:
            if select.select([self.master], [], [], .05)[0]:
                try:
                    self.output += os.read(self.master, 65536)
                except OSError:
                    break
        self.proc.wait(timeout=1)
        assert self.proc.returncode == 0, self.output[-3000:]

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        os.close(self.master)


def wait_for(predicate, terminal, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        terminal.drain()
        try:
            if predicate():
                return
        except (OSError, ValueError):
            pass
        time.sleep(.05)
    raise AssertionError(('Timed out waiting for saved article', terminal.output[-3000:]))


project = pathlib.Path(__file__).resolve().parents[1]
command = os.environ.get('BEACON_TEST_COMMAND', 'beacon')
with tempfile.TemporaryDirectory(prefix='beacon-launcher-') as temporary:
    base = pathlib.Path(temporary)
    workspace = base / 'isolated-workspace'
    elsewhere = base / '其他 当前目录'
    elsewhere.mkdir()
    env = dict(os.environ, BEACON_WORKSPACE=str(workspace), BEACON_CONFIG=str(base / 'config.json'))
    drafts = workspace / 'src/content/drafts'
    state_file = workspace / '.beacon/state.json'
    body = '第一行\n中文写作ABC'

    terminal = Terminal(command, project, env)
    try:
        terminal.wait_text('Enter 继续写作／新建文章')
        assert '^N 新建文章'.encode() in terminal.output
        assert '^O 打开文章'.encode() in terminal.output
        terminal.send('\x0e')
        terminal.wait_text('^S 保存')
        terminal.send('\x1b[200~' + body + '\x1b[201~')
        terminal.wait_text('中文写作ABC')
        wait_for(lambda: len(list(drafts.glob('*.md'))) == 1, terminal)
        article = next(drafts.glob('*.md'))
        wait_for(lambda: body in article.read_text(), terminal)
        terminal.send('\x1b[D\x1b[D')
        terminal.wait_text('已保存到本地')
        terminal.finish()
    finally:
        terminal.close()
    state = json.loads(state_file.read_text())
    article_id = state['lastId']
    cursor = state['positions'][article_id]['cursor']
    assert cursor == len(body) - 2, state

    terminal = Terminal(command, elsewhere, env)
    try:
        terminal.wait_text('中文写作ABC')
        terminal.send('续')
        expected = body[:cursor] + '续' + body[cursor:]
        wait_for(lambda: expected in article.read_text(), terminal)
        terminal.finish()
    finally:
        terminal.close()
    assert len(list(drafts.glob('*.md'))) == 1
    assert json.loads(state_file.read_text())['lastId'] == article_id
    assert not (elsewhere / 'src').exists()
    assert not (elsewhere / '.beacon').exists()

    # Missing recent article: choose another surviving article.
    alternative = drafts / 'alternative.md'
    alternative.write_text('可继续的另一篇文章\n')
    article.unlink()
    terminal = Terminal(command, elsewhere, env)
    try:
        terminal.wait_text('打开文章')
        terminal.send('\r')
        terminal.wait_text('可继续的另一篇文章')
        terminal.finish()
    finally:
        terminal.close()

    # No articles remain: create a writable draft instead of failing startup.
    alternative.unlink()
    terminal = Terminal(command, elsewhere, env)
    try:
        terminal.wait_text('^S 保存')
        terminal.send('重新开始写作')
        wait_for(lambda: any('重新开始写作' in p.read_text() for p in drafts.glob('*.md')), terminal)
        terminal.finish()
    finally:
        terminal.close()
    print('LAUNCHER PTY PASS: fresh login shells, first start, cross-directory launch, same workspace, article/cursor resume, missing-article selection, empty-workspace writing')
