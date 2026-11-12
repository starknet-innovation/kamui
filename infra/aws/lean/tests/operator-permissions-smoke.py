#!/usr/bin/env python3
"""Actual Linux UID/mode proof for operator/API secret separation; disposable DB only."""
import json
import os
import subprocess
import time
from pathlib import Path
import uuid

image=os.environ.get('KAMUI_OPERATOR_TEST_IMAGE','kamui-backend-lean-permissions:local')
prefix='kamui-permissions-'+uuid.uuid4().hex[:10]
network=prefix+'-net'; volume=prefix+'-files'; database=prefix+'-pg'

def docker(args,check=True):
    return subprocess.run(['docker',*args],capture_output=True,text=True,check=check)

def run(code=None,user='0:0',file='OPERATOR_DATABASE_URL',command=None,read_only=False):
    args=['run','--rm','--network',network,'--user',user,'--cap-drop','ALL','--security-opt','no-new-privileges:true','-v',volume+':/fixture'+(':ro' if read_only else ''),'-e','DATABASE_URL_FILE=/fixture/'+file,'-e','RESTORE_GATE_FILE=/fixture/gate/state.json',image]
    return docker(args+(command if command else ['bun','-e',code]),check=False)

try:
    docker(['image','inspect',image]); docker(['image','inspect','postgres:16'])
    docker(['network','create','--internal',network]); docker(['volume','create',volume])
    docker(['run','--detach','--rm','--name',database,'--network',network,'--network-alias','postgres','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=kamui_permissions','--tmpfs','/var/lib/postgresql/data:rw,size=256m','postgres:16'])
    for _ in range(100):
        if docker(['exec',database,'pg_isready','-U','postgres','-d','kamui_permissions'],check=False).returncode==0: break
        time.sleep(.1)
    else: raise RuntimeError('FIXTURE_DATABASE_UNAVAILABLE')
    # Prepare real Linux-owned files inside a named volume. No credential/password is used.
    seed="""const fs=await import('node:fs');for(const name of ['DATABASE_URL','OPERATOR_DATABASE_URL']){fs.writeFileSync('/fixture/'+name,'postgres://postgres@postgres:5432/kamui_permissions');fs.chmodSync('/fixture/'+name,0o400)}fs.chownSync('/fixture/DATABASE_URL',1000,1000);fs.mkdirSync('/fixture/gate',{mode:0o750});fs.chownSync('/fixture/gate',0,1000);"""
    seeded=docker(['run','--rm','--network','none','--user','0:0','-v',volume+':/fixture',image,'bun','-e',seed],check=False)
    if seeded.returncode: raise RuntimeError('FIXTURE_FILES_UNAVAILABLE')
    code="await (await import('/app/src/secrets.ts')).loadRuntimeSecretFiles(process.env,['DATABASE_URL']);console.log('loaded')"
    api_check=run(code,user='1000:1000',file='DATABASE_URL',read_only=True)
    if api_check.returncode:
        Path('/tmp/kamui-api-file-permissions-fixture-error.log').write_text(api_check.stderr)
        raise RuntimeError('API_SECRET_NOT_READABLE')
    if run(code,user='0:0',file='DATABASE_URL',read_only=True).returncode==0: raise RuntimeError('ROOT_UNEXPECTEDLY_BYPASSED_DAC')
    if run(command=['bun','run','src/scripts/restore-control.ts','initialize']).returncode: raise RuntimeError('OPERATOR_INITIALIZE_FAILED')
    ack="""const fs=await import('node:fs');const gate=JSON.parse(fs.readFileSync('/fixture/gate/state.json','utf8'));fs.chmodSync('/fixture/gate/state.json',0o644);fs.writeFileSync('/fixture/ack.json',JSON.stringify({version:1,generation:gate.generation,mode:'fresh',reviewRef:'local-permissions-fixture',apiAndRotatorStopped:true,originalWriterCannotRestart:true}));"""
    if run(ack).returncode: raise RuntimeError('FIXTURE_ACK_FAILED')
    if run(command=['bun','run','src/scripts/restore-control.ts','acknowledge','/fixture/ack.json']).returncode: raise RuntimeError('OPERATOR_ACK_FAILED')
    status=run(command=['bun','run','src/scripts/spending-control.ts','--api-stopped','status'])
    if status.returncode or json.loads(status.stdout).get('paused') is not True: raise RuntimeError('OPERATOR_DATABASE_STATUS_FAILED')
    read="const fs=await import('node:fs');const g=JSON.parse(fs.readFileSync('/fixture/gate/state.json','utf8'));if(g.state!=='ready')process.exit(1)"
    if run(read,user='1000:1000',read_only=True).returncode: raise RuntimeError('API_GATE_NOT_READABLE')
    print('Linux API/operator secret ownership, fresh acknowledgement and paused funding status passed')
finally:
    docker(['stop',database],check=False); docker(['volume','rm',volume],check=False); docker(['network','rm',network],check=False)
