"""Bounded cold Office conversion with private noninteractive security profile."""
from typing import TYPE_CHECKING
import os
import resource
import subprocess
import sys
from pathlib import Path
if TYPE_CHECKING or __package__:
    from .env_config import env_int
else:
    from env_config import env_int


if __name__ == '__main__':
    source, directory, bin_path = sys.argv[1:]
    output = Path(directory)
    profile = output / 'profile'
    user = profile / 'user'
    user.mkdir(parents=True)
    # No macros, Java or automatic link updates. Do not use a shared running
    # office session/profile, whose settings could override these restrictions.
    (user / 'registrymodifications.xcu').write_text('''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Java"><prop oor:name="Enable" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateLink" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
</oor:items>''')
    memory = env_int('PARSER_OFFICE_MEMORY_BYTES', 1024 * 1024 * 1024)
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_CPU, (110, 115))
    resource.setrlimit(resource.RLIMIT_FSIZE, (200 * 1024 * 1024, 200 * 1024 * 1024))
    result = subprocess.run([bin_path, '-env:UserInstallation=' + profile.as_uri(),
        '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', 'pptx',
        '--outdir', str(output), source], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode or not (output / (Path(source).stem + '.pptx')).is_file():
        raise RuntimeError('Legacy presentation conversion failed')
