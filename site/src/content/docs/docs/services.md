---
title: Services
description: Which AWS services are tested, which accept calls but run nothing, and what runs on a timer.
---

| Service | Status |
| --- | --- |
| S3 | Tested, including bucket notifications into SQS |
| SQS | Tested |
| DynamoDB | Tested, including TTL expiry |
| Lambda | Tested with Node functions, in Node and in a page |
| SNS | Tested, fanning out to SQS |
| EventBridge | Tested, routing matched events to SQS |
| Secrets Manager, SSM Parameter Store, KMS, CloudWatch Logs, Kinesis | Tested |
| Step Functions | Doesn't work yet: executions stay `RUNNING` |
| RDS, ElastiCache, ECS, EKS, Batch, OpenSearch, Athena | Accept calls but run nothing. Databases, caches, and clusters report ready with no endpoint behind them, tasks and jobs report running or done, and Athena returns made-up rows |
| The rest of [MiniStack](https://ministack.org/)'s services | Untested. They may respond, but nothing here checks them |

## Scheduled work

MiniStack runs scheduled EventBridge rules, EventBridge Scheduler schedules, and the DynamoDB TTL
reaper on background threads, which Pyodide doesn't have. Pocket Region runs them from a timer
instead, checking once a second. Anything already due fires within about a second, such as a
one-time schedule in the past or an expired TTL. `rate()` and `cron()` wait real time, so a
`rate(1 minute)` rule first fires a minute after it's created. EventBridge rules that target
Lambda don't reach the handler, found by reading MiniStack's source and not yet run. Schedules
that invoke Lambda are untested.
