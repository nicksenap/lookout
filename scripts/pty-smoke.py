#!/usr/bin/env python3
"""Step 10 smoke: drive the card stack in a PTY; dump screens; always ends with q; hard timeout.
Usage: scripts/pty-smoke.py <repo> <target> [rows cols]"""
import fcntl, os, pty, re, select, signal, struct, sys, termios, time

repo, target = sys.argv[1], sys.argv[2]
rows, cols = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 else (30, 100)
lookout = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin", "lookout")
signal.alarm(90)  # hard stop

env = dict(os.environ); env.pop("OPENAI_API_KEY", None)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(repo); os.execvpe("bun", ["bun", lookout, target], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

out = bytearray()
def pump(t):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: out.extend(os.read(fd, 65536))
            except OSError: return
def key(k, wait=0.25): os.write(fd, k.encode()); pump(wait)

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]")
def last_screen():
    text = out.decode("utf8", "replace")
    frame = text.rsplit("\x1b[2J", 1)[-1] if "\x1b[2J" in text else text
    return ANSI.sub("", frame)

pump(4)
screens = {"stack": last_screen()}
key("j"); key("j"); key("\r", 0.4); screens["expanded"] = last_screen()
key("J"); key("G"); key("\x1b", 0.3); screens["back"] = last_screen()
key("?", 0.3); screens["help"] = last_screen(); key("\x1b")
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0)); os.kill(pid, signal.SIGWINCH); pump(0.6)
screens["resized"] = last_screen()
key("q", 1.5)
_, status = os.waitpid(pid, 0)
text = out.decode("utf8", "replace")

if "--show" in sys.argv:
    for name, s in screens.items():
        print(f"\n##### {name}\n" + "\n".join(l for l in s.split("\n") if l.strip())[:3000])
checks = {
    "alt screen entered": "\x1b[?1049h" in text,
    "header has tier": any(t in screens["stack"] for t in ("LOW", "MEDIUM", "HIGH")),
    "stack has a card bar": "┃" in screens["stack"],
    "expanded shows a hunk header": "@@" in screens["expanded"],
    "back to stack": "┃" in screens["back"] and "@@" not in screens["back"].split("\n")[2],
    "help listed": "review this card" in screens["help"],
    "usable after resize": "┃" in screens["resized"],
    "alt screen left": "\x1b[?1049l" in text,
    "cursor shown": "\x1b[?25h" in text,
    "exit 0": os.WEXITSTATUS(status) == 0,
}
ok = True
for name, passed in checks.items():
    print(("PASS " if passed else "FAIL ") + name); ok &= passed
sys.exit(0 if ok else 1)
