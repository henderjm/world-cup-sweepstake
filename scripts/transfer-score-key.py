"""Transfer the approved GitHub provider secret through a scoped OIDC identity."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request

if os.environ.get('GITHUB_REPOSITORY') != 'henderjm/world-cup-sweepstake' or os.environ.get('GITHUB_REF') != 'refs/heads/codex/aws-credential-transfer':
    raise SystemExit('Transfer restricted to the approved repository branch')
key = os.environ.get('API_FOOTBALL_KEY', '').strip()
if not key:
    raise SystemExit('Provider secret missing')
request = urllib.request.Request(os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'] + '&audience=sts.amazonaws.com',
    headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
with urllib.request.urlopen(request, timeout=15) as response:
    token = json.load(response)['value']
with tempfile.TemporaryDirectory() as directory:
    token_path, key_path = Path(directory) / 'identity', Path(directory) / 'provider'
    for path, value in [(token_path, token), (key_path, key)]:
        path.touch(mode=0o600)
        path.write_text(value)
    env = dict(os.environ, AWS_REGION='eu-west-1', AWS_DEFAULT_REGION='eu-west-1',
        AWS_ROLE_ARN='arn:aws:iam::134471064301:role/kickoff-draft-credential-transfer',
        AWS_WEB_IDENTITY_TOKEN_FILE=str(token_path), AWS_ROLE_SESSION_NAME='kickoff-key-transfer')
    for name in ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']:
        env.pop(name, None)
    result = subprocess.run(['aws', 'secretsmanager', 'put-secret-value', '--secret-id',
        'arn:aws:secretsmanager:eu-west-1:134471064301:secret:kickoff-draft/api-football-key-JQeoxy',
        '--secret-string', 'file://' + str(key_path), '--query', 'VersionId', '--output', 'text'],
        env=env, check=True, capture_output=True, text=True)
    print('Transferred provider key; version:', result.stdout.strip())
