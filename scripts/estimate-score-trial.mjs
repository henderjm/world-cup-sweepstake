import { readFile } from 'node:fs/promises';
const snapshot = JSON.parse(await readFile(new URL('../docs/costs/aws-ireland-rates.json', import.meta.url), 'utf8'));
const rate = (service, usage) => {
  const matches = snapshot.rates.filter(row => row.service === service && row.usage === usage);
  if (matches.length !== 1) throw Error(`Missing or ambiguous rate: ${service}/${usage}`);
  return Number(matches[0].usd);
};
const round = value => Math.round(value * 100) / 100;
const assumptions = {
  hours: 730, collectors: 2, vcpuEach: 0.25, memoryGiBEach: 0.5,
  lambdaMemoryGiB: 0.5, lambdaSecondsPerRequest: 0.15,
  dynamoReadUnitsPerApiRequest: 30,
  collectorReadUnits: 10000000, collectorWriteUnits: 10000000,
  responseKiB: 200, tableGiB: 1, imageGiB: 1, artifactGiB: 1,
  collectorLogsGiB: 1, readerLogKiBPerRequest: 1, logRetentionDays: 14,
  standardAlarms: 4, customMetrics: 4, secrets: 1, secretReads: 1000,
  artifactWrites: 100, artifactReads: 1000,
  monitorDays: 30, monitorCompetitions: 2, monitorIntervalSeconds: 15,

};
const scenarios = [100000, 1000000, 10000000].map(visitorRequests => {
  const a = assumptions;
  const monitorRequests = a.monitorDays * 86400 * a.monitorCompetitions / a.monitorIntervalSeconds;
  const requests = visitorRequests + monitorRequests;
  const responseGiB = requests * a.responseKiB / 1024 / 1024;
  const logGiB = a.collectorLogsGiB + requests * a.readerLogKiBPerRequest / 1024 / 1024;
  const costs = {
    collectorCompute: a.collectors * a.hours * (a.vcpuEach * rate('AmazonECS', 'EU-Fargate-vCPU-Hours:perCPU') + a.memoryGiBEach * rate('AmazonECS', 'EU-Fargate-GB-Hours')),
    collectorDatabase: a.collectorReadUnits * rate('AmazonDynamoDB', 'EU-ReadRequestUnits') + a.collectorWriteUnits * rate('AmazonDynamoDB', 'EU-WriteRequestUnits'),
    readerDatabase: requests * a.dynamoReadUnitsPerApiRequest * rate('AmazonDynamoDB', 'EU-ReadRequestUnits'),
    lambda: requests * (rate('AWSLambda', 'EU-Request') + a.lambdaMemoryGiB * a.lambdaSecondsPerRequest * rate('AWSLambda', 'EU-Lambda-GB-Second')),
    httpApi: requests * rate('AmazonApiGateway', 'EU-ApiGatewayHttpRequest'),
    internetResponseTransfer: responseGiB * rate('AWSDataTransfer', 'EU-DataTransfer-Out-Bytes'),
    publicIpv4: a.collectors * a.hours * rate('AmazonVPC', 'EU-PublicIPv4:InUseAddress'),
    tableStorageAndPitr: a.tableGiB * (rate('AmazonDynamoDB', 'EU-TimedStorage-ByteHrs') + rate('AmazonDynamoDB', 'EU-TimedPITRStorage-ByteHrs')),
    logs: logGiB * (rate('AmazonCloudWatch', 'EU-DataProcessing-Bytes') + a.logRetentionDays / 30 * rate('AmazonCloudWatch', 'EU-TimedStorage-ByteHrs')),
    metricsAndAlarms: a.standardAlarms * rate('AmazonCloudWatch', 'EU-CW:AlarmMonitorUsage') + a.customMetrics * rate('AmazonCloudWatch', 'EU-CW:MetricMonitorUsage'),
    secrets: a.secrets * rate('AWSSecretsManager', 'EU-AWSSecretsManager-Secrets') + a.secretReads * rate('AWSSecretsManager', 'EU-AWSSecretsManager-APIRequests'),
    imageStorage: a.imageGiB * rate('AmazonECR', 'EU-TimedStorage-ByteHrs'),
    artifacts: a.artifactGiB * rate('AmazonS3', 'EU-TimedStorage-ByteHrs') + a.artifactWrites * rate('AmazonS3', 'EU-Requests-Tier1') + a.artifactReads * rate('AmazonS3', 'EU-Requests-Tier2'),
  };
  return { visitorRequests, monitorRequests, requests, responseGiB: round(responseGiB), logGiB: round(logGiB),
    subtotalUsd: round(Object.values(costs).reduce((sum, value) => sum + value, 0)),
    componentsUsd: Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, round(value)])) };
});
console.log(JSON.stringify({ rateDate: snapshot.checked, region: snapshot.region, assumptions, scenarios,
  excluded: ['independent monitor hosting, watchdog and paging', 'data subscription',
    'other network transfer, build compute, log queries and restore operations',
    'tax, support and existing Cloudflare charges'],
  notes: ['Public-subnet design uses no NAT gateway.',
    'Paid storage/transfer tiers are applied from the first byte; no account-wide free allowances assumed.',
    'Log storage conservatively assumes no compression and 14/30 month retention.',
    'Metrics/alarms are cost allowances, not installed monitoring.',
    'Visitor scenarios include an additional 345,600 monthly PL/CL monitor reads; browser journeys and watchdog calls are extra.',
    'All quantities are scenario assumptions, not measured production usage.'],
  status: 'Scenario subtotal only; not a total budget, bill forecast or spending approval. No free-tier or volume discounts applied.' }, null, 2));
