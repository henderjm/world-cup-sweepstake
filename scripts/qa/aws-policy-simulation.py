import json,hashlib,subprocess,datetime,tempfile
from pathlib import Path
source=Path('infra/scores/trial.json').read_bytes()
template=json.loads(source)
account='134471064301';region='eu-west-1'
identity=json.loads(subprocess.check_output(['aws','sts','get-caller-identity','--output','json','--no-cli-pager']))
if identity['Account'] != account: raise RuntimeError('AWS account differs from selected target')
base=f'arn:aws:dynamodb:{region}:{account}:table/kickoff-policy-simulation'
refs={'Scores':base,'ReaderLogs':f'arn:aws:logs:{region}:{account}:log-group:/kickoff/simulation/reader:*','CollectorLogs':f'arn:aws:logs:{region}:{account}:log-group:/kickoff/simulation/collector:*','ImageRepositoryArn':f'arn:aws:ecr:{region}:{account}:repository/kickoff-policy-simulation','ProviderSecretArn':f'arn:aws:secretsmanager:{region}:{account}:secret:kickoff-policy-simulation-ABC123'}
def resolve(value):
 if isinstance(value,list): return [resolve(v) for v in value]
 if isinstance(value,dict):
  if 'Fn::GetAtt' in value:
   name,attr=value['Fn::GetAtt']
   if attr != 'Arn': raise ValueError('Unsupported template attribute')
   return refs[name]
  if 'Ref' in value:return refs[value['Ref']]
  return {k:resolve(v) for k,v in value.items()}
 return value
request_dir=tempfile.TemporaryDirectory(prefix='kickoff-policy-')
cases=[]
def case(role,action,keys,allowed,resource=base):cases.append((role,action,keys,allowed,resource))
for key in ['SCORE#PL#2026','SCORE#CL#2026','DETAIL#CL#2026#123','FANTASY#PL#2026']:
 case('ReaderRole','dynamodb:GetItem',[key],True)
for keys in [None,['COLLECTOR'],['PROVIDER_BUDGET'],['SCORE#PL#2026','PROVIDER_BUDGET'],['SCORE#OTHER#2026']]:
 case('ReaderRole','dynamodb:GetItem',keys,False)
case('ReaderRole','dynamodb:PutItem',['SCORE#PL#2026'],False)
case('ReaderRole','dynamodb:Scan',None,False)
case('ReaderRole','secretsmanager:GetSecretValue',None,False,refs['ProviderSecretArn'])
case('ReaderRole','dynamodb:GetItem',['SCORE#PL#2026'],False,base+'-other')
for key in ['COLLECTOR','PROVIDER_BUDGET','SCORE#CL#2026']:
 case('CollectorRole','dynamodb:PutItem',[key],True)
case('CollectorRole','dynamodb:ConditionCheckItem',['COLLECTOR'],True)
case('CollectorRole','dynamodb:ConditionCheckItem',['PROVIDER_BUDGET'],False)
case('CollectorRole','dynamodb:PutItem',None,False)
case('CollectorRole','dynamodb:DeleteTable',None,False)
case('CollectorRole','secretsmanager:GetSecretValue',None,False,refs['ProviderSecretArn'])
case('ExecutionRole','secretsmanager:GetSecretValue',None,True,refs['ProviderSecretArn'])
case('ExecutionRole','secretsmanager:GetSecretValue',None,False,refs['ProviderSecretArn']+'-other')
case('ExecutionRole','dynamodb:GetItem',['PROVIDER_BUDGET'],False)
results=[]
for i,(role,action,keys,allowed,resource) in enumerate(cases):
 policies=[resolve(p['PolicyDocument']) for p in template['Resources'][role]['Properties']['Policies']]
 request={'PolicyInputList':[json.dumps(p) for p in policies],'ActionNames':[action],'ResourceArns':[resource]}
 if keys is not None:request['ContextEntries']=[{'ContextKeyName':'dynamodb:LeadingKeys','ContextKeyValues':keys,'ContextKeyType':'stringList'}]
 path=Path(request_dir.name) / f'case-{i}.json';path.write_text(json.dumps(request))
 raw=json.loads(subprocess.check_output(['aws','iam','simulate-custom-policy','--cli-input-json','file://'+str(path),'--output','json','--no-cli-pager','--region',region]))
 decisions=[r['EvalDecision'] for r in raw['EvaluationResults']]
 passed=len(decisions)==1 and ((decisions[0]=='allowed')==allowed)
 results.append({'role':role,'action':action,'keys':keys,'resource':resource,'expected':'allowed' if allowed else 'denied','decisions':decisions,'passed':passed})
 print(i+1,role,action,decisions,flush=True)
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'accountId':account,'region':region,'templateSha256':hashlib.sha256(source).hexdigest(),'syntheticResourceArns':True,'runtimeRoleEnforcementVerified':False,'cases':results}
Path('docs/live-score-evidence/2026-10-04-aws-policy-simulation.json').write_text(json.dumps(report,indent=2)+'\n')
request_dir.cleanup()
if not all(r['passed'] for r in results): raise RuntimeError('Policy simulation did not match expected decisions')
