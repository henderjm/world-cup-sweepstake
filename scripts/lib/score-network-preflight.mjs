export function validateNetworkTarget(target) {
  if (!/^\d{12}$/.test(target?.accountId ?? '') || !/^vpc-[a-f0-9]{8,17}$/.test(target?.vpcId ?? '')
    || !Array.isArray(target.subnetIds) || target.subnetIds.length !== 2
    || new Set(target.subnetIds).size !== 2 || target.subnetIds.some(id => !/^subnet-[a-f0-9]{8,17}$/.test(id)))
    throw Error('Supply accountId, vpcId and exactly two distinct subnetIds');
  return { accountId: target.accountId, vpcId: target.vpcId, subnetIds: [...target.subnetIds], region: 'eu-west-1' };
}

export async function checkScoreNetwork(target, aws) {
  const plan = validateNetworkTarget(target);
  const identity = await aws(['sts', 'get-caller-identity']);
  if (identity.Account !== plan.accountId) throw Error('AWS account does not match the approved target');
  const vpcs = await aws(['ec2', 'describe-vpcs', '--vpc-ids', plan.vpcId]);
  const vpc = vpcs.Vpcs?.find(v => v.VpcId === plan.vpcId);
  if (vpc?.OwnerId !== plan.accountId || vpc.State !== 'available') throw Error('VPC ownership/status is not valid');
  const data = await aws(['ec2', 'describe-subnets', '--subnet-ids', ...plan.subnetIds]);
  const subnets = plan.subnetIds.map(id => data.Subnets?.find(s => s.SubnetId === id));
  if (subnets.some(s => !s || s.VpcId !== plan.vpcId || s.OwnerId !== plan.accountId || s.State !== 'available'
    || s.Ipv6Native === true || !Number.isInteger(s.AvailableIpAddressCount) || s.AvailableIpAddressCount < 2
    || !s.AvailabilityZoneId)) throw Error('Subnet ownership, VPC, IPv4 capacity or status is not valid');
  if (subnets[0].AvailabilityZoneId === subnets[1].AvailabilityZoneId) throw Error('Collectors must use different availability zones');
  const tables = await aws(['ec2', 'describe-route-tables', '--filters', `Name=vpc-id,Values=${plan.vpcId}`]);
  const gateways = await aws(['ec2', 'describe-internet-gateways', '--filters', `Name=attachment.vpc-id,Values=${plan.vpcId}`]);
  const routes = subnets.map(subnet => {
    const matching = (tables.RouteTables ?? []).filter(t => t.VpcId === plan.vpcId
      && t.Associations?.some(a => a.SubnetId === subnet.SubnetId));
    const candidates = matching.length ? matching : (tables.RouteTables ?? []).filter(t => t.VpcId === plan.vpcId
      && t.Associations?.some(a => a.Main === true));
    if (candidates.length !== 1) throw Error(`Missing or ambiguous route table for ${subnet.SubnetId}`);
    const table = candidates[0];
    if (table.Associations.some(a => (a.SubnetId === subnet.SubnetId || (!matching.length && a.Main))
      && a.AssociationState?.State !== 'associated')) throw Error('Route association is not stable');
    const defaults = table.Routes?.filter(r => r.DestinationCidrBlock === '0.0.0.0/0') ?? [];
    const route = defaults[0];
    if (defaults.length !== 1 || route.State !== 'active' || !/^igw-/.test(route.GatewayId ?? ''))
      throw Error(`No active public IPv4 default route for ${subnet.SubnetId}`);
    const gateway = gateways.InternetGateways?.find(g => g.InternetGatewayId === route.GatewayId);
    if (!gateway?.Attachments?.some(a => a.VpcId === plan.vpcId && a.State === 'available'))
      throw Error('Internet gateway is not attached to the intended VPC');
    return { subnetId: subnet.SubnetId, availabilityZoneId: subnet.AvailabilityZoneId,
      availableIpv4: subnet.AvailableIpAddressCount, routeTableId: table.RouteTableId, gatewayId: route.GatewayId };
  });
  return { ...plan, checkedAt: new Date().toISOString(), checks: 'account, VPC, subnet placement and default routes', routes,
    remaining: ['Network ACLs and more-specific routes', 'DNS and actual HTTPS egress', 'Public-IP assignment on task ENIs',
      'Artifact identity, runtime IAM, old-consumer shutdown and provider acceptance'], deploymentReady: false };
}
