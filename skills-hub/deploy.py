#!/usr/bin/env python3
"""
Idempotent deployer for the Kyoto skills hub.

Provisions (or updates) on AWS:
  - DynamoDB table `kyoto-skills`
  - IAM role `kyoto-skills-lambda-role` with DynamoDB + CloudWatch access
  - Lambda function `kyoto-skills-api` (Python 3.12)
  - Lambda Function URL (public, AWS_IAM=NONE — auth is API-key-in-header)

Re-runs safely: every step checks for existing resources before creating.
On first run it generates a random API key and writes it to
`skills-hub/.deploy-state.json` next to this script.

Optional: pass --setup-domain to create a CF DNS CNAME for
skills.kryvik.com pointing at the Lambda Function URL + a Transform
Rule that rewrites the Host header so Lambda accepts the request.
Requires CLOUDFLARE_API_TOKEN in env. (Default is "skip the domain
step" — the Lambda URL works on its own.)

Reads creds from environment. Source Projects/.env first:
  set -a; source ~/Projects/.env; set +a; python3 deploy.py
"""

import argparse
import io
import json
import os
import secrets
import sys
import time
import zipfile
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / '.deploy-state.json'

REGION = os.environ.get('AWS_REGION', 'us-east-1')
TABLE_NAME = 'kyoto-skills'
ROLE_NAME = 'kyoto-skills-lambda-role'
FN_NAME = 'kyoto-skills-api'
FN_RUNTIME = 'python3.12'
FN_HANDLER = 'lambda_function.handler'
FN_TIMEOUT = 30
FN_MEMORY = 256
SUBDOMAIN = 'skills.kryvik.com'


def log(msg):
    print(f'[deploy] {msg}', flush=True)


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True))


# ---------- DynamoDB --------------------------------------------------------

GSI_BY_SKILL_ID = 'skill_id_index'


def ensure_table():
    ddb = boto3.client('dynamodb', region_name=REGION)
    created = False
    try:
        desc = ddb.describe_table(TableName=TABLE_NAME)
        log(f'DynamoDB table {TABLE_NAME!r} already exists')
    except ClientError as e:
        if e.response['Error']['Code'] != 'ResourceNotFoundException':
            raise
        log(f'Creating DynamoDB table {TABLE_NAME!r} (PK=domain, SK=skill_id)...')
        ddb.create_table(
            TableName=TABLE_NAME,
            AttributeDefinitions=[
                {'AttributeName': 'domain', 'AttributeType': 'S'},
                {'AttributeName': 'skill_id', 'AttributeType': 'S'},
            ],
            KeySchema=[
                {'AttributeName': 'domain', 'KeyType': 'HASH'},
                {'AttributeName': 'skill_id', 'KeyType': 'RANGE'},
            ],
            GlobalSecondaryIndexes=[{
                'IndexName': GSI_BY_SKILL_ID,
                'KeySchema': [{'AttributeName': 'skill_id', 'KeyType': 'HASH'}],
                'Projection': {'ProjectionType': 'ALL'},
            }],
            BillingMode='PAY_PER_REQUEST',
        )
        ddb.get_waiter('table_exists').wait(TableName=TABLE_NAME)
        log(f'Table {TABLE_NAME!r} active')
        created = True
        desc = ddb.describe_table(TableName=TABLE_NAME)

    # If the table existed already from a pre-v14.6.8 deploy, it won't
    # have skill_id_index. Add it now so GET/DELETE /v1/skills/<id> can
    # work without the caller supplying domain. Backfill is automatic;
    # we just have to wait for ACTIVE.
    if not created:
        gsis = desc['Table'].get('GlobalSecondaryIndexes') or []
        has_idx = any(g['IndexName'] == GSI_BY_SKILL_ID for g in gsis)
        if not has_idx:
            log(f'Adding GSI {GSI_BY_SKILL_ID!r} to existing table (backfill can take minutes)...')
            ddb.update_table(
                TableName=TABLE_NAME,
                AttributeDefinitions=[
                    {'AttributeName': 'skill_id', 'AttributeType': 'S'},
                ],
                GlobalSecondaryIndexUpdates=[{
                    'Create': {
                        'IndexName': GSI_BY_SKILL_ID,
                        'KeySchema': [{'AttributeName': 'skill_id', 'KeyType': 'HASH'}],
                        'Projection': {'ProjectionType': 'ALL'},
                    }
                }],
            )
            # Poll until the GSI is ACTIVE — backfill is best-effort
            # capped at 20 min so the script doesn't hang forever.
            for i in range(80):
                time.sleep(15)
                d = ddb.describe_table(TableName=TABLE_NAME)
                gsi = next((g for g in d['Table'].get('GlobalSecondaryIndexes') or []
                            if g['IndexName'] == GSI_BY_SKILL_ID), None)
                status = gsi['IndexStatus'] if gsi else 'unknown'
                if status == 'ACTIVE':
                    log('  GSI is ACTIVE')
                    break
                log(f'  GSI {GSI_BY_SKILL_ID} status: {status}')
            else:
                log(f'  WARN: GSI never reached ACTIVE; lookups by skill_id alone may 500 until it does')


# ---------- IAM -------------------------------------------------------------

TRUST_POLICY = {
    'Version': '2012-10-17',
    'Statement': [{
        'Effect': 'Allow',
        'Principal': {'Service': 'lambda.amazonaws.com'},
        'Action': 'sts:AssumeRole',
    }],
}

INLINE_POLICY = {
    'Version': '2012-10-17',
    'Statement': [
        {
            'Effect': 'Allow',
            'Action': ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            'Resource': 'arn:aws:logs:*:*:*',
        },
        {
            'Effect': 'Allow',
            'Action': [
                'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
                'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan',
            ],
            'Resource': [
                f'arn:aws:dynamodb:{REGION}:*:table/{TABLE_NAME}',
                # GSI Query needs the index ARN, not just the base table.
                f'arn:aws:dynamodb:{REGION}:*:table/{TABLE_NAME}/index/*',
            ],
        },
    ],
}


def ensure_role():
    iam = boto3.client('iam')
    try:
        r = iam.get_role(RoleName=ROLE_NAME)
        log(f'IAM role {ROLE_NAME!r} already exists')
    except ClientError as e:
        if e.response['Error']['Code'] != 'NoSuchEntity':
            raise
        log(f'Creating IAM role {ROLE_NAME!r}...')
        r = iam.create_role(
            RoleName=ROLE_NAME,
            AssumeRolePolicyDocument=json.dumps(TRUST_POLICY),
            Description='Execution role for Kyoto skills hub Lambda.',
        )
        # IAM eventual consistency: Lambda creation needs the role to be
        # assumable, which takes a few seconds to propagate.
        time.sleep(10)
    iam.put_role_policy(
        RoleName=ROLE_NAME,
        PolicyName='kyoto-skills-inline',
        PolicyDocument=json.dumps(INLINE_POLICY),
    )
    return r['Role']['Arn']


# ---------- Lambda ----------------------------------------------------------

def build_zip():
    src = (HERE / 'lambda_function.py').read_bytes()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('lambda_function.py', src)
    return buf.getvalue()


def ensure_function(role_arn, api_key):
    lam = boto3.client('lambda', region_name=REGION)
    code = build_zip()
    env = {'Variables': {'SKILL_API_KEY': api_key, 'SKILL_TABLE': TABLE_NAME}}
    try:
        lam.get_function(FunctionName=FN_NAME)
        log(f'Updating Lambda code + config for {FN_NAME!r}...')
        lam.update_function_code(FunctionName=FN_NAME, ZipFile=code, Publish=True)
        # update_function_code returns before the function is ready to be
        # configured again — wait until it's in "Active" state.
        lam.get_waiter('function_updated_v2').wait(FunctionName=FN_NAME)
        lam.update_function_configuration(
            FunctionName=FN_NAME,
            Role=role_arn, Handler=FN_HANDLER, Runtime=FN_RUNTIME,
            Timeout=FN_TIMEOUT, MemorySize=FN_MEMORY, Environment=env,
        )
        lam.get_waiter('function_updated_v2').wait(FunctionName=FN_NAME)
    except ClientError as e:
        if e.response['Error']['Code'] != 'ResourceNotFoundException':
            raise
        log(f'Creating Lambda function {FN_NAME!r}...')
        lam.create_function(
            FunctionName=FN_NAME,
            Runtime=FN_RUNTIME, Role=role_arn, Handler=FN_HANDLER,
            Code={'ZipFile': code}, Timeout=FN_TIMEOUT, MemorySize=FN_MEMORY,
            Environment=env, Publish=True,
        )
        lam.get_waiter('function_active_v2').wait(FunctionName=FN_NAME)
    log('Lambda code + config in sync')


def ensure_http_api():
    """
    Create an API Gateway HTTP API ($default stage, $default route) that
    proxies to the Lambda. We use HTTP API (apigatewayv2) rather than
    REST API because it's cheaper, faster to provision, and natively
    supports the Lambda payload format v2 our handler expects.

    Function URLs are blocked in newer AWS accounts by a non-overridable
    public-access default; APIGW sidesteps that.
    """
    apigw = boto3.client('apigatewayv2', region_name=REGION)
    lam = boto3.client('lambda', region_name=REGION)
    account = boto3.client('sts').get_caller_identity()['Account']
    api_name = 'kyoto-skills-api'

    # 1) API
    apis = apigw.get_apis(MaxResults='100').get('Items', [])
    api = next((a for a in apis if a['Name'] == api_name), None)
    if not api:
        log(f'Creating HTTP API {api_name!r}...')
        api = apigw.create_api(
            Name=api_name, ProtocolType='HTTP',
            CorsConfiguration={
                'AllowOrigins': ['*'],
                'AllowMethods': ['GET', 'POST', 'DELETE', 'OPTIONS'],
                'AllowHeaders': ['content-type', 'x-kyoto-auth'],
                'MaxAge': 3600,
            },
        )
    else:
        log(f'HTTP API {api_name!r} already exists ({api["ApiId"]})')
    api_id = api['ApiId']
    lambda_arn = f'arn:aws:lambda:{REGION}:{account}:function:{FN_NAME}'

    # 2) Integration (Lambda proxy, payload v2)
    ints = apigw.get_integrations(ApiId=api_id).get('Items', [])
    integ = next((i for i in ints if i.get('IntegrationUri') == lambda_arn), None)
    if not integ:
        log('Creating Lambda integration...')
        integ = apigw.create_integration(
            ApiId=api_id, IntegrationType='AWS_PROXY',
            IntegrationUri=lambda_arn, PayloadFormatVersion='2.0',
            TimeoutInMillis=29000,
        )
    int_id = integ['IntegrationId']

    # 3) $default route → integration
    routes = apigw.get_routes(ApiId=api_id).get('Items', [])
    target = f'integrations/{int_id}'
    default_route = next((r for r in routes if r['RouteKey'] == '$default'), None)
    if not default_route:
        log('Creating $default route...')
        apigw.create_route(ApiId=api_id, RouteKey='$default', Target=target)
    elif default_route.get('Target') != target:
        apigw.update_route(ApiId=api_id, RouteId=default_route['RouteId'], Target=target)

    # 4) $default stage with auto-deploy
    stages = apigw.get_stages(ApiId=api_id).get('Items', [])
    if not any(s['StageName'] == '$default' for s in stages):
        log('Creating $default stage (auto-deploy)...')
        apigw.create_stage(ApiId=api_id, StageName='$default', AutoDeploy=True)

    # 5) Lambda resource-policy: allow this API to invoke the function.
    src_arn = f'arn:aws:execute-api:{REGION}:{account}:{api_id}/*/*'
    try:
        lam.add_permission(
            FunctionName=FN_NAME, StatementId='AllowAPIGatewayInvoke',
            Action='lambda:InvokeFunction', Principal='apigateway.amazonaws.com',
            SourceArn=src_arn,
        )
    except ClientError as e:
        if e.response['Error']['Code'] != 'ResourceConflictException':
            raise

    invoke_url = f'https://{api_id}.execute-api.{REGION}.amazonaws.com'
    return invoke_url, api_id


# ---------- Cloudflare (optional, --setup-domain) ---------------------------

def _cf_http(cf_token):
    """Tiny CF v4 client. Returns a function: http(method, path, body=None) -> dict."""
    import urllib.request, urllib.error
    api = 'https://api.cloudflare.com/client/v4'
    hdrs = {'Authorization': f'Bearer {cf_token}', 'Content-Type': 'application/json'}

    def http(method, path, body=None):
        req = urllib.request.Request(api + path, method=method, headers=hdrs)
        data = json.dumps(body).encode() if body is not None else None
        try:
            with urllib.request.urlopen(req, data=data, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read())
    return http


def _cf_upsert_cname(http, zone_id, name, content, *, proxied):
    """Create or update a CNAME record. `name` is the leaf (e.g. 'skills' or full FQDN)."""
    r = http('GET', f'/zones/{zone_id}/dns_records?name={name}&type=CNAME')
    # Defensive: CF's `type=` filter should already constrain results, but
    # belt-and-braces in case the API misbehaves — we MUST NOT PUT a CNAME
    # body to e.g. an existing A record's ID.
    existing = [x for x in (r.get('result') or []) if x.get('type') == 'CNAME']
    payload = {'type': 'CNAME', 'name': name, 'content': content, 'proxied': proxied, 'ttl': 1}
    if existing:
        rid = existing[0]['id']
        r = http('PUT', f'/zones/{zone_id}/dns_records/{rid}', payload)
    else:
        r = http('POST', f'/zones/{zone_id}/dns_records', payload)
    return r


def cf_setup_domain(apigw_invoke_url, cf_token):
    """
    Provision a custom domain for the HTTP API:
      1. Request (or reuse) ACM cert for SUBDOMAIN
      2. Create DNS-validation CNAME in CF, wait for ISSUED
      3. Create API GW custom domain pinned to that cert
      4. Map api_id + $default stage to the custom domain
      5. Create the final CF CNAME to API GW's regional endpoint (DNS-only)

    Resumable: if any step already exists, we skip it. The whole thing
    takes ~3-8 min on first run (cert validation), seconds on re-runs.
    """
    zone_name = 'kryvik.com'
    http = _cf_http(cf_token)

    # Zone ID
    r = http('GET', f'/zones?name={zone_name}')
    if not r.get('success') or not r.get('result'):
        log(f'CF: cannot list zones: {r}')
        return None
    zone_id = r['result'][0]['id']

    # 1) ACM cert
    acm = boto3.client('acm', region_name=REGION)
    cert_arn = None
    paginator = acm.get_paginator('list_certificates')
    for page in paginator.paginate(CertificateStatuses=['ISSUED', 'PENDING_VALIDATION']):
        for c in page['CertificateSummaryList']:
            if c['DomainName'] == SUBDOMAIN:
                cert_arn = c['CertificateArn']
                break
        if cert_arn:
            break
    if not cert_arn:
        log(f'ACM: requesting cert for {SUBDOMAIN}')
        cert_arn = acm.request_certificate(
            DomainName=SUBDOMAIN, ValidationMethod='DNS',
            IdempotencyToken='kyotoskills',  # \w+ only — no hyphens
        )['CertificateArn']
        # ACM needs a few seconds before the validation record is populated
        time.sleep(8)

    # 2) DNS-validation CNAME
    desc = acm.describe_certificate(CertificateArn=cert_arn)['Certificate']
    if desc['Status'] == 'ISSUED':
        log('ACM cert already ISSUED')
    else:
        opts = desc.get('DomainValidationOptions', [])
        if opts and opts[0].get('ResourceRecord'):
            rr = opts[0]['ResourceRecord']
            log(f'ACM: validation record {rr["Name"]} → {rr["Value"]}')
            _cf_upsert_cname(http, zone_id, rr['Name'].rstrip('.'), rr['Value'].rstrip('.'), proxied=False)
        # Poll up to 10 min for ISSUED
        for i in range(40):
            time.sleep(15)
            st = acm.describe_certificate(CertificateArn=cert_arn)['Certificate']['Status']
            log(f'  ACM status check {i + 1}/40: {st}')
            if st == 'ISSUED':
                break
            if st == 'FAILED':
                log('ACM validation failed — bailing out of domain setup')
                return None
        else:
            log('ACM cert still not ISSUED after 10 min — bail')
            return None

    # 3) API GW custom domain
    apigw = boto3.client('apigatewayv2', region_name=REGION)
    try:
        cd = apigw.get_domain_name(DomainName=SUBDOMAIN)
        log(f'API GW custom domain {SUBDOMAIN!r} already exists')
    except apigw.exceptions.NotFoundException:
        log(f'API GW: creating custom domain {SUBDOMAIN!r}')
        cd = apigw.create_domain_name(
            DomainName=SUBDOMAIN,
            DomainNameConfigurations=[{
                'CertificateArn': cert_arn,
                'EndpointType': 'REGIONAL',
                'SecurityPolicy': 'TLS_1_2',
            }],
        )
    regional_domain = cd['DomainNameConfigurations'][0]['ApiGatewayDomainName']
    log(f'API GW regional target: {regional_domain}')

    # 4) API mapping
    api_id = load_state().get('apiId')
    if not api_id:
        log('apiId missing from state — re-run deploy.py without --setup-domain first')
        return None
    mappings = apigw.get_api_mappings(DomainName=SUBDOMAIN).get('Items', [])
    if not any(m['ApiId'] == api_id for m in mappings):
        log(f'API GW: creating mapping {SUBDOMAIN} → {api_id}/$default')
        apigw.create_api_mapping(DomainName=SUBDOMAIN, ApiId=api_id, Stage='$default')
    else:
        log('API GW mapping already exists')

    # 5) Final CF CNAME. Must be DNS-only (NOT proxied) because API GW
    # terminates SSL using the cert we provisioned — CF can't MITM that.
    log(f'CF: upserting {SUBDOMAIN} → {regional_domain} (DNS-only)')
    _cf_upsert_cname(http, zone_id, SUBDOMAIN, regional_domain, proxied=False)
    return f'https://{SUBDOMAIN}'


# ---------- main ------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--setup-domain', action='store_true',
                    help='Also configure CF DNS + Host rewrite for skills.kryvik.com')
    ap.add_argument('--regenerate-key', action='store_true',
                    help='Generate a new API key (invalidates the old one)')
    args = ap.parse_args()

    state = load_state()

    if args.regenerate_key or 'apiKey' not in state:
        state['apiKey'] = secrets.token_urlsafe(32)
        save_state(state)
        log('Generated new API key (saved to .deploy-state.json)')

    ensure_table()
    role_arn = ensure_role()
    ensure_function(role_arn, state['apiKey'])
    invoke_url, api_id = ensure_http_api()
    state['apiId'] = api_id
    state['lambdaUrl'] = invoke_url
    save_state(state)

    final_url = invoke_url
    if args.setup_domain:
        cf_token = os.environ.get('CLOUDFLARE_API_TOKEN')
        if not cf_token:
            log('CLOUDFLARE_API_TOKEN missing — skipping domain setup')
        else:
            custom = cf_setup_domain(invoke_url, cf_token)
            if custom:
                state['hubUrl'] = custom
                save_state(state)
                final_url = custom

    log('Done.')
    log(f'  Hub URL:    {final_url}')
    log(f'  APIGW URL:  {invoke_url}')
    log(f'  API key:    {state["apiKey"]}')
    log('Paste these into Kyoto → Settings → Skills hub.')


if __name__ == '__main__':
    main()
