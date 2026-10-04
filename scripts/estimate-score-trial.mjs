import { readFile } from 'node:fs/promises';
const snapshot = JSON.parse(await readFile(new URL('../docs/costs/aws-ireland-rates.json', import.meta.url), 'utf8'));
const rate = usage => Number(snapshot.rates.find(row => row.usage === usage).usd);
const round = value => Math.round(value * 100) / 100;
const assumptions = {
  hours: 730, collectors: 2, vcpuEach: 0.25, memoryGiBEach: 0.5,
  lambdaMemoryGiB: 0.5, lambdaSecondsPerRequest: 0.15,
  dynamoReadUnitsPerApiRequest: 30,
  collectorReadUnits: 10000000, collectorWriteUnits: 10000000,
  responseKiB: 200,
};
const scenarios = [100000, 1000000, 10000000].map(requests => {
  const a = assumptions;
  const costs = {
    collectorCompute: a.collectors * a.hours * (a.vcpuEach * rate('EU-Fargate-vCPU-Hours:perCPU') + a.memoryGiBEach * rate('EU-Fargate-GB-Hours')),
    collectorDatabase: a.collectorReadUnits * rate('EU-ReadRequestUnits') + a.collectorWriteUnits * rate('EU-WriteRequestUnits'),
    readerDatabase: requests * a.dynamoReadUnitsPerApiRequest * rate('EU-ReadRequestUnits'),
    lambda: requests * (rate('EU-Request') + a.lambdaMemoryGiB * a.lambdaSecondsPerRequest * rate('EU-Lambda-GB-Second')),
    httpApi: requests * rate('EU-ApiGatewayHttpRequest'),
  };
  return { requests, responseGiB: round(requests * a.responseKiB / 1024 / 1024),
    subtotalUsd: round(Object.values(costs).reduce((sum, value) => sum + value, 0)),
    componentsUsd: Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, round(value)])) };
});
console.log(JSON.stringify({ rateDate: snapshot.checked, region: snapshot.region, assumptions, scenarios,
  excluded: ['network transfer', 'public IPv4 or NAT', 'logs, metrics and alarms', 'independent monitor and paging',
    'Secrets Manager, ECR and build artifacts', 'DynamoDB storage and backups', 'data subscription', 'tax, support and existing Cloudflare charges'],
  status: 'Scenario subtotal only; not a total budget, bill forecast or spending approval. No free-tier or volume discounts applied.' }, null, 2));
