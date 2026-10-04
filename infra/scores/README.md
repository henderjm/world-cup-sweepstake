# Score trial infrastructure

`trial.json` is an unapplied CloudFormation draft. Creating it spends money and
exposes a public stored-read endpoint; both require explicit approval. It does
not change the existing Worker, site, GitHub variables or provider plan.

Provide an existing Ireland VPC and two public subnets in distinct availability
zones with an internet-gateway route. The template checks distinct subnet IDs,
not their AZs, VPC membership or routing: verify those through EC2 before approval.
No inbound collector rule exists; outbound TCP 443 is allowed. This is not a
hostname allowlist. Public IPv4, transfer, logging, PITR and artifact storage
costs still need the completed estimate.

Supply a private ECR repository ARN and an image URI pinned to its digest, plus
an S3 bucket, key and nonempty object version for the reader ZIP from the same
release. Verify these refer to the approved artifact checksums. The deployer
needs artifact read permissions; the runtime reader does not. Supply the ARN of
an existing Secrets Manager secret containing only the provider key, encrypted
with the AWS-managed Secrets Manager key. Customer-managed KMS keys need a
separately reviewed decrypt policy. No secret value belongs in stack parameters.

The ECS execution role pulls that image and injects that one secret. The
collector application role can GetItem/PutItem only for PL/CL score/detail keys,
PL fantasy keys, COLLECTOR and PROVIDER_BUDGET; ConditionCheckItem only for the
lease. The reader can GetItem only for public dataset prefixes and write its own
logs. No Scan, Query, DeleteItem, UpdateItem, table administration or provider
secret access is granted to the reader. Transaction permissions follow the
[underlying DynamoDB item actions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html).
LeadingKeys conditions require a non-null context. IAM enforcement still needs
AWS simulation and assumed-role denial tests; DynamoDB Local does not enforce it.

`EnableCollection` defaults to false and both services start with desired count
zero. A missing budget also fails closed in the application. Initialization is
an explicit operator step requiring verified current provider usage and old
consumers stopped; a working operator command/runbook is still pending. Only
enable collection after approval and initialization. The two services use
separate subnets, each with one task when enabled, and rolling replacements
cannot temporarily increase that count. Natural lease expiry governs takeover.

The table retains data on stack deletion/replacement, has deletion protection
and point-in-time recovery, and no TTL that could reset fencing or quota state.
Retained resources continue costing money; deleting a stack is not full cleanup.
Reader concurrency is capped at 10; HTTP API is capped at 10 requests/second and
20 burst. These trial limits need load measurement and are not production sizing.

Before deployment, require schema lint, a reviewed change set, complete cost
estimate, subnet/artifact/secret preflight, an independent monitor and receiver,
and budget-preserving cutover/rollback instructions. In the approved trial, prove
reader denial for PutItem, lease/budget reads, scanning and secret reads, while
allowing stored manifests/parts. Prove collector transactional writes with the
lease ConditionCheck and denial on unrelated keys/tables. Then exercise task
loss, delayed writers, provider outage/429, cold/warm reads and real browser
journeys. No local policy assertion substitutes for those cloud tests.
