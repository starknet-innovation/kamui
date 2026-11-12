#!/usr/bin/env python3
"""Local Caddy failed-upstream privacy probe. Uses an already-pulled test image only."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
image = os.environ.get('KAMUI_CADDY_TEST_IMAGE', 'caddy:2-alpine')
subprocess.run(['docker','image','inspect',image],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for role, variable, peer in [('backend','KEYCHAIN_HOST','keychain:5173'),('pepper','PEPPER_HOST','pepper:8787')]:
    config = (ROOT/'caddy'/f'{role}.Caddyfile').read_text()
    config = config.replace('auto_https disable_redirects','auto_https off')
    config = config.replace('https://{$'+variable+'}', 'http://127.0.0.1:8080').replace('http://{$'+variable+'}', 'http://127.0.0.1:8081').replace(peer,'127.0.0.1:9')
    name = 'kamui-proxy-log-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp)/'Caddyfile'; path.write_text(config)
        try:
            subprocess.run(['docker','run','--detach','--rm','--network','none','--name',name,'-v',str(path)+':/etc/caddy/Caddyfile:ro',image,'caddy','run','--config','/etc/caddy/Caddyfile'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            target = '/api/sponsor' if role == 'backend' else '/v1/pepper'
            sentinel_header = 'FIXTURE_SPONSOR_TOKEN_MUST_NOT_LOG'
            sentinel_query = 'FIXTURE_OAUTH_QUERY_MUST_NOT_LOG'
            for attempt in range(30):
                request = subprocess.run(['docker','exec',name,'wget','-S','-O','/dev/null','--header','x-kamui-sponsor-token: '+sentinel_header,'--post-data','{}','http://127.0.0.1:8080'+target+'?token='+sentinel_query],capture_output=True,text=True)
                if '502' in request.stderr:
                    break
                time.sleep(.05)
            else:
                raise RuntimeError('FAILED_PROXY_NOT_EXERCISED')
            logs = subprocess.run(['docker','logs',name],capture_output=True,text=True,check=True)
            output = logs.stdout + logs.stderr
            if sentinel_header in output or sentinel_query in output or 'http.log.error' in output:
                raise RuntimeError('REQUEST_DATA_ENTERED_LOGS')
            print(role+': failed-upstream request data excluded from logs')
        finally:
            subprocess.run(['docker','stop',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
