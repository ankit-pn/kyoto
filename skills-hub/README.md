# Kyoto skills hub

A small DynamoDB-backed playbook store the Kyoto extension can pull
from and write to. Domain-scoped (`youtube.com`, `github.com`, …) so
the agent fetches exactly what's relevant before tackling a task,
and writes back distilled skills when a `/goal` completes.

## Deploy

```bash
set -a; source ~/Projects/.env; set +a
python3 deploy.py                  # provision Lambda + DDB + APIGW
python3 deploy.py --setup-domain   # also wire skills.kryvik.com via ACM + CF DNS
```

The script is idempotent — re-run after editing `lambda_function.py` to
push new code. State (API key, IDs) is cached in `.deploy-state.json`.

## What gets created on AWS

- DynamoDB table `kyoto-skills` (PAY_PER_REQUEST; PK=domain, SK=skill_id)
- IAM role `kyoto-skills-lambda-role`
- Lambda function `kyoto-skills-api` (Python 3.12)
- API Gateway HTTP API + `$default` stage with auto-deploy
- ACM cert + custom domain mapping (with `--setup-domain`)

Cost at low volume (single-user hub): pennies/month, well within
free tier for DDB + Lambda + APIGW.

## Wire the extension

Open Kyoto → Settings → Skills hub. Paste the URL + API key the
deploy script printed. Hit **Test connection** — you should see
`✓ Connected · kyoto-skills-hub`.

## API

All authed routes need header `X-Kyoto-Auth: <key>`. `domain` is
case-insensitive and accepts full URLs (gets normalized to eTLD+1).

| Method  | Path                       | Body / query                                          |
| ------- | -------------------------- | ----------------------------------------------------- |
| GET     | `/v1/healthz`              | (no auth)                                             |
| GET     | `/v1/skills`               | `?domain=&limit=`                                     |
| POST    | `/v1/skills`               | `{ domain, name, description, content, tags, skill_id? }` |
| POST    | `/v1/skills/search`        | `{ domain, query, limit, includeGlobal }`             |
| GET     | `/v1/skills/{skill_id}`    | `?domain=`                                            |
| DELETE  | `/v1/skills/{skill_id}`    | `?domain=`                                            |
