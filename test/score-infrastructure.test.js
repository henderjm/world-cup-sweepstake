import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = JSON.parse(readFileSync(new URL('../infra/scores/trial.json', import.meta.url)));
const resources = template.Resources;
const statements = role => resources[role].Properties.Policies.flatMap(p => p.PolicyDocument.Statement);

test('trial reader has no provider, coordination, or write authority in its declared policies', () => {
  const policies = statements('ReaderRole');
  assert.deepEqual(policies.flatMap(p => p.Action).sort(), ['dynamodb:GetItem', 'logs:CreateLogStream', 'logs:PutLogEvents']);
  const read = policies.find(p => p.Action.includes('dynamodb:GetItem'));
  assert.deepEqual(read.Resource, { 'Fn::GetAtt': ['Scores', 'Arn'] });
  assert.deepEqual(read.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'],
    ['SCORE#PL#*', 'SCORE#CL#*', 'DETAIL#PL#*', 'DETAIL#CL#*', 'FANTASY#PL#*']);
  assert.equal(read.Condition.Null['dynamodb:LeadingKeys'], 'false');
  assert.equal(resources.ReaderRole.Properties.ManagedPolicyArns, undefined);
  assert.deepEqual(Object.keys(resources.Reader.Properties.Environment.Variables).sort(), ['SCORE_SEASONS', 'SCORE_TABLE_NAME']);
});

test('collector uses item permissions for fenced transactions without table administration', () => {
  const policies = statements('CollectorRole');
  assert.deepEqual(policies.flatMap(p => p.Action).sort(), ['dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:PutItem']);
  for (const p of policies) {
    assert.deepEqual(p.Resource, { 'Fn::GetAtt': ['Scores', 'Arn'] });
    assert.equal(p.Condition.Null['dynamodb:LeadingKeys'], 'false');
  }
  assert.deepEqual(policies.find(p => p.Action.includes('dynamodb:ConditionCheckItem')).Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'], ['COLLECTOR']);
  assert.equal(resources.CollectorRole.Properties.ManagedPolicyArns, undefined);
  assert.equal(statements('ExecutionRole').some(p => p.Action.some(a => a.startsWith('dynamodb:'))), false);
});

test('trial starts no collectors, preserves durable coordination, and isolates task placement', () => {
  assert.equal(template.Parameters.EnableCollection.Default, 'false');
  for (const suffix of ['A', 'B']) {
    const service = resources[`Collector${suffix}`].Properties;
    assert.deepEqual(service.DesiredCount, { 'Fn::If': ['CollectionEnabled', 1, 0] });
    assert.deepEqual(service.NetworkConfiguration.AwsvpcConfiguration.Subnets, [{ Ref: `Subnet${suffix}` }]);
    assert.equal(service.DeploymentConfiguration.MaximumPercent, 100);
  }
  assert.equal(resources.Scores.DeletionPolicy, 'Retain');
  assert.equal(resources.Scores.UpdateReplacePolicy, 'Retain');
  assert.equal(resources.Scores.Properties.DeletionProtectionEnabled, true);
  assert.equal(resources.Scores.Properties.TimeToLiveSpecification, undefined);
  assert.equal(resources.CollectorTask.Properties.ContainerDefinitions[0].ReadonlyRootFilesystem, true);
  assert.equal(resources.CollectorNetwork.Properties.SecurityGroupIngress, undefined);
});
