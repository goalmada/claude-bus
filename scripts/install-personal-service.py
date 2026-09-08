#!/usr/bin/env python3
"""Install the explicitly authorized local supervisor; no credential or budget changes."""
import os
import pathlib
import plistlib
import shutil
import subprocess
import time

repo = pathlib.Path(__file__).resolve().parent.parent
root = pathlib.Path.home() / '.local/state/claude-personal-queue'
root.mkdir(parents=True, exist_ok=True, mode=0o700)
node = shutil.which('node')
if not node:
    raise SystemExit('Node runtime required')
label = 'com.goalmada.claude-personal-queue'
plist = pathlib.Path.home() / 'Library/LaunchAgents' / (label + '.plist')
plist.parent.mkdir(parents=True, exist_ok=True)
content = {
    'Label': label,
    'ProgramArguments': [node, str(repo / 'bin/personal-queue'), 'serve'],
    'WorkingDirectory': str(repo),
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 10,
    'AbandonProcessGroup': True,
    'EnvironmentVariables': {k: os.environ[k] for k in ['HOME', 'PATH', 'TMPDIR', 'LANG', 'USER', 'LOGNAME', 'SHELL'] if k in os.environ},
    'StandardOutPath': str(root / 'service.log'),
    'StandardErrorPath': str(root / 'service-error.log'),
}
for name in ['service.log', 'service-error.log']:
    target = root / name
    target.touch(mode=0o600, exist_ok=True)
    target.chmod(0o600)
plist.write_bytes(plistlib.dumps(content))
plist.chmod(0o600)
domain = 'gui/' + str(os.getuid())
subprocess.run(['launchctl', 'bootout', domain + '/' + label], capture_output=True)
for attempt in range(20):
    present = subprocess.run(['launchctl', 'print', domain + '/' + label], capture_output=True)
    if present.returncode != 0:
        break
    time.sleep(0.25)
else:
    raise SystemExit('Previous supervisor has not unloaded; inspect it before retrying')
# launchd can still be releasing a removed job after print no longer finds it.
for attempt in range(5):
    loaded = subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], capture_output=True)
    if loaded.returncode == 0:
        break
    if subprocess.run(['launchctl', 'print', domain + '/' + label], capture_output=True).returncode == 0:
        raise SystemExit('Supervisor exists after uncertain bootstrap; inspect before retrying')
    time.sleep(1)
else:
    raise SystemExit('Supervisor bootstrap failed after bounded retries')
print(label)
