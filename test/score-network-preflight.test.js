import test from 'node:test';
import assert from 'node:assert/strict';
import { checkScoreNetwork, validateNetworkTarget } from '../scripts/lib/score-network-preflight.mjs';
const target = { accountId: '123456789012', vpcId: 'vpc-12345678', subnetIds: ['subnet-11111111', 'subnet-22222222'] };
function responses() {
  return [{ Account: target.accountId }, { Vpcs: [{ VpcId: target.vpcId, OwnerId: target.accountId, State: 'available' }] },
    { Subnets: target.subnetIds.map((id, i) => ({ SubnetId: id, VpcId: target.vpcId, OwnerId: target.accountId,
      State: 'available', AvailableIpAddressCount: 10, AvailabilityZoneId: `euw1-az${i + 1}` })) },
    { RouteTables: [{ VpcId: target.vpcId, RouteTableId: 'rtb-main', Associations: [{ Main: true, AssociationState: { State: 'associated' } }],
      Routes: [{ DestinationCidrBlock: '0.0.0.0/0', State: 'active', GatewayId: 'igw-trial' }] }] },
    { InternetGateways: [{ InternetGatewayId: 'igw-trial', Attachments: [{ VpcId: target.vpcId, State: 'available' }] }] }];
}
async function check(data) {
  const calls = [];
  const result = await checkScoreNetwork(target, async args => { calls.push(args); return data[calls.length - 1]; });
  return { result, calls };
}
test('preflight resolves main route fallback and explicitly remains incomplete for deployment', async () => {
  const { result, calls } = await check(responses());
  assert.equal(result.routes.length, 2); assert.equal(result.deploymentReady, false);
  assert.deepEqual(calls.map(c => c[1]), ['get-caller-identity', 'describe-vpcs', 'describe-subnets', 'describe-route-tables', 'describe-internet-gateways']);
});
test('wrong account fails before touching network resources', async () => {
  let calls = 0;
  await assert.rejects(checkScoreNetwork(target, async () => { calls++; return { Account: '999999999999' }; }), /account/);
  assert.equal(calls, 1);
  assert.throws(() => validateNetworkTarget({ ...target, subnetIds: [target.subnetIds[0], target.subnetIds[0]] }));
});
test('same-zone, foreign, exhausted, unavailable and IPv6-only subnets fail closed', async () => {
  for (const patch of [{ AvailabilityZoneId: 'euw1-az1' }, { VpcId: 'vpc-87654321' }, { AvailableIpAddressCount: 0 },
    { State: 'pending' }, { Ipv6Native: true }, { OwnerId: '999999999999' }]) {
    const data = responses(); Object.assign(data[2].Subnets[1], patch);
    await assert.rejects(check(data));
  }
});
test('an explicit subnet route overrides main, and bad routes or detached gateways cannot pass', async () => {
  const data = responses();
  data[3].RouteTables.push({ ...structuredClone(data[3].RouteTables[0]), RouteTableId: 'rtb-private',
    Associations: [{ SubnetId: target.subnetIds[0], AssociationState: { State: 'associated' } }], Routes: [] });
  await assert.rejects(check(data), /default route/);
  for (const mutate of [d => { d[3].RouteTables[0].Routes[0].State = 'blackhole'; },
    d => { d[3].RouteTables[0].Routes[0].GatewayId = 'nat-private'; },
    d => { d[4].InternetGateways[0].Attachments = []; },
    d => { d[3].RouteTables[0].Associations[0].AssociationState.State = 'associating'; }]) {
    const fixture = responses(); mutate(fixture); await assert.rejects(check(fixture));
  }
});
