"""
Kyoto skills hub — AWS Lambda handler.

Routes (all under /v1):
  GET    /healthz                       liveness, no auth
  GET    /skills?domain=&limit=         list skills for a domain
  POST   /skills                        save (create or update by skill_id)
  GET    /skills/{skill_id}?domain=     get one
  DELETE /skills/{skill_id}?domain=     delete one
  POST   /skills/search                 substring + tag search across a domain

Auth: every non-/healthz request must carry header `X-Kyoto-Auth: <key>`
matching env var SKILL_API_KEY. Single shared key for now — multi-tenant
auth can come later.

Storage: DynamoDB table `kyoto-skills`
  PK domain (S), SK skill_id (S)
  Attrs: name, description, content, tags (SS), createdAt (N),
         updatedAt (N), usageCount (N), version (S), createdBy (S)

This file is uploaded verbatim as the Lambda handler. Keep it
single-file + stdlib-only (boto3 is provided by the Lambda runtime).
"""

import hmac
import json
import os
import re
import time
import uuid

import boto3
from boto3.dynamodb.conditions import Key

TABLE_NAME = os.environ.get('SKILL_TABLE', 'kyoto-skills')
API_KEY = os.environ.get('SKILL_API_KEY', '')
MAX_CONTENT_BYTES = 200_000

_dynamodb = boto3.resource('dynamodb')
_table = _dynamodb.Table(TABLE_NAME)


def _resp(status, body, *, extra_headers=None):
    headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,X-Kyoto-Auth',
    }
    if extra_headers:
        headers.update(extra_headers)
    return {
        'statusCode': status,
        'headers': headers,
        'body': json.dumps(body, default=_json_default),
    }


def _json_default(o):
    # DynamoDB Decimal -> int/float
    from decimal import Decimal
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    if isinstance(o, set):
        return sorted(o)
    raise TypeError(f'not JSON serialisable: {type(o)}')


def _slugify(s, *, max_len=48):
    s = re.sub(r'[^a-z0-9]+', '-', (s or '').lower()).strip('-')
    return s[:max_len] or 'skill'


def _new_skill_id(name):
    return f'{_slugify(name)}-{uuid.uuid4().hex[:6]}'


def _norm_domain(d):
    # Accept "youtube.com", "https://www.youtube.com/...", or "*"/"global"
    if not d:
        return 'global'
    d = d.strip().lower()
    if d in ('*', 'global', 'any'):
        return 'global'
    m = re.match(r'(?:https?://)?(?:www\.)?([^/]+)', d)
    return (m.group(1) if m else d)[:200]


def _require_auth(event):
    if not API_KEY:
        return _resp(500, {'error': 'server misconfigured: SKILL_API_KEY unset'})
    hdrs = {k.lower(): v for k, v in (event.get('headers') or {}).items()}
    # Constant-time compare — equality check on strings leaks the matched
    # prefix length via response time, making the key brute-forceable.
    if not hmac.compare_digest(hdrs.get('x-kyoto-auth') or '', API_KEY):
        return _resp(401, {'error': 'unauthorized'})
    return None


def _parse_int(v, default, *, max_value=None):
    """Coerce a query/body value to int. Return `default` on bad input
    (ValueError → 500 avoided) AND on non-positive input (limit=-5 or
    limit=0 should not silently produce zero results)."""
    try:
        n = int(v) if v is not None else default
    except (TypeError, ValueError):
        return default
    if n <= 0:
        return default
    return min(n, max_value) if max_value is not None else n


# ---------- handlers --------------------------------------------------------

def _healthz(_event):
    return _resp(200, {'ok': True, 'service': 'kyoto-skills-hub', 'table': TABLE_NAME})


def _list(event):
    qs = event.get('queryStringParameters') or {}
    domain = _norm_domain(qs.get('domain'))
    limit = _parse_int(qs.get('limit'), 100, max_value=500)
    r = _table.query(
        KeyConditionExpression=Key('domain').eq(domain),
        Limit=limit,
    )
    items = [_strip_internal(x) for x in r.get('Items', [])]
    return _resp(200, {'domain': domain, 'count': len(items), 'items': items})


def _strip_internal(item):
    out = dict(item)
    # tags stored as String Set; convert to list for JSON.
    if isinstance(out.get('tags'), set):
        out['tags'] = sorted(out['tags'])
    return out


def _save(event):
    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return _resp(400, {'error': 'invalid JSON body'})

    name = (body.get('name') or '').strip()
    content = body.get('content') or ''
    if not name:
        return _resp(400, {'error': 'name is required'})
    if not content or not isinstance(content, str):
        return _resp(400, {'error': 'content (string) is required'})
    if len(content.encode('utf-8')) > MAX_CONTENT_BYTES:
        return _resp(400, {'error': f'content too large (>{MAX_CONTENT_BYTES} bytes)'})

    domain = _norm_domain(body.get('domain'))
    skill_id = (body.get('skill_id') or '').strip() or _new_skill_id(name)
    description = (body.get('description') or '').strip()
    tags = body.get('tags') or []
    if not isinstance(tags, list):
        return _resp(400, {'error': 'tags must be a list of strings'})
    tags = [str(t).strip().lower() for t in tags if t and isinstance(t, str)]
    created_by = (body.get('createdBy') or 'agent').strip()[:40]
    version = (body.get('version') or '1').strip()[:16]

    now = int(time.time() * 1000)
    # Preserve createdAt + usageCount on update.
    existing = _table.get_item(Key={'domain': domain, 'skill_id': skill_id}).get('Item')
    created_at = existing.get('createdAt') if existing else now
    usage_count = existing.get('usageCount', 0) if existing else 0

    item = {
        'domain': domain,
        'skill_id': skill_id,
        'name': name,
        'description': description,
        'content': content,
        'createdAt': created_at,
        'updatedAt': now,
        'usageCount': usage_count,
        'version': version,
        'createdBy': created_by,
    }
    if tags:
        item['tags'] = set(tags)  # SS in DynamoDB
    _table.put_item(Item=item)
    return _resp(200, {'ok': True, 'skill_id': skill_id, 'domain': domain, 'updated': existing is not None})


def _get(event, skill_id):
    qs = event.get('queryStringParameters') or {}
    raw_domain = (qs.get('domain') or '').strip()
    item = None
    domain = None
    if raw_domain:
        # Fast path — caller knows the domain so we GetItem with both keys.
        domain = _norm_domain(raw_domain)
        r = _table.get_item(Key={'domain': domain, 'skill_id': skill_id})
        item = r.get('Item')
    if not item:
        # Domain unknown (or wrong) — fall back to a GSI Query by skill_id.
        # Skill IDs are globally unique (name-slug + 6-hex suffix), so this
        # finds the one matching item across all partitions cheaply.
        try:
            r = _table.query(
                IndexName='skill_id_index',
                KeyConditionExpression=Key('skill_id').eq(skill_id),
                Limit=1,
            )
            items = r.get('Items', [])
            if items:
                item = items[0]
                domain = item['domain']
        except Exception:
            # GSI may not exist yet on legacy tables — bubble the original 404.
            pass
    if not item:
        return _resp(404, {'error': 'not found', 'skill_id': skill_id,
                           'hint': 'try calling skill_search first to discover the right skill_id'})
    # Bump usage counter on read — best-effort, no transaction.
    try:
        _table.update_item(
            Key={'domain': domain, 'skill_id': skill_id},
            UpdateExpression='ADD usageCount :one',
            ExpressionAttributeValues={':one': 1},
        )
    except Exception:
        pass
    return _resp(200, _strip_internal(item))


def _delete(event, skill_id):
    qs = event.get('queryStringParameters') or {}
    raw_domain = (qs.get('domain') or '').strip()
    domain = None
    if raw_domain:
        domain = _norm_domain(raw_domain)
    else:
        # Resolve via GSI when caller doesn't know the domain.
        try:
            r = _table.query(
                IndexName='skill_id_index',
                KeyConditionExpression=Key('skill_id').eq(skill_id),
                Limit=1,
            )
            items = r.get('Items', [])
            if items:
                domain = items[0]['domain']
        except Exception:
            pass
    if not domain:
        return _resp(404, {'error': 'not found', 'skill_id': skill_id})
    r = _table.delete_item(
        Key={'domain': domain, 'skill_id': skill_id},
        ReturnValues='ALL_OLD',
    )
    existed = bool(r.get('Attributes'))
    return _resp(200, {'ok': True, 'deleted': existed, 'domain': domain, 'skill_id': skill_id})


def _search(event):
    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return _resp(400, {'error': 'invalid JSON body'})
    query = (body.get('query') or '').strip().lower()
    # Treat missing/empty domain as "search everywhere". The caller can
    # explicitly opt into the original per-domain behaviour by passing
    # a non-empty domain string.
    raw_domain = (body.get('domain') or '').strip()
    domain = _norm_domain(raw_domain) if raw_domain else None
    limit = _parse_int(body.get('limit'), 10, max_value=50)
    include_global = bool(body.get('includeGlobal', True))

    items = []
    if domain:
        # Targeted: query the per-domain partition + optionally global.
        domains_to_query = [domain]
        if include_global and domain != 'global':
            domains_to_query.append('global')
        for d in domains_to_query:
            r = _table.query(KeyConditionExpression=Key('domain').eq(d), Limit=200)
            items.extend(r.get('Items', []))
    else:
        # No domain hint — scan the whole table. Skills are small + few
        # in practice; if the table grows past ~1000 items we should
        # add a per-tag GSI or a tokenised search index instead.
        scan_kwargs = {'Limit': 500}
        r = _table.scan(**scan_kwargs)
        items.extend(r.get('Items', []))
        # One follow-up page if we got the soft cap and a continuation token.
        # We deliberately don't loop forever — search is best-effort, not a dump.
        if r.get('LastEvaluatedKey') and len(items) < 500:
            r2 = _table.scan(ExclusiveStartKey=r['LastEvaluatedKey'], Limit=500 - len(items))
            items.extend(r2.get('Items', []))

    # Score: name hit (3pts) > description hit (2) > tag hit (2) > content hit (1).
    # Tie-break on usageCount. DynamoDB returns Decimals for N attrs, which
    # don't mix with Python float — coerce to int up front.
    def _uc(item):
        try:
            return int(item.get('usageCount') or 0)
        except (TypeError, ValueError):
            return 0

    def score(item):
        if not query:
            return _uc(item)
        s = 0
        name = (item.get('name') or '').lower()
        desc = (item.get('description') or '').lower()
        content = (item.get('content') or '').lower()
        tags = item.get('tags') or set()
        if isinstance(tags, list):
            tags = set(tags)
        if query in name:
            s += 3
        if query in desc:
            s += 2
        if any(query in t for t in tags):
            s += 2
        if query in content:
            s += 1
        return s + 0.001 * _uc(item)

    scored = [(score(i), i) for i in items]
    scored.sort(key=lambda x: x[0], reverse=True)
    # Drop zero-score hits when there's a query, but keep the top items
    # when the query is empty (treat as "popular skills for this domain").
    if query:
        scored = [(s, i) for s, i in scored if s > 0]
    top = [_strip_internal(i) for _s, i in scored[:limit]]
    # Trim heavy `content` from search results — caller can GET the
    # full skill by id. Saves tokens.
    summary = []
    for it in top:
        c = it.get('content') or ''
        summary.append({
            **{k: v for k, v in it.items() if k != 'content'},
            'contentPreview': c[:240] + ('…' if len(c) > 240 else ''),
        })
    return _resp(200, {
        'query': query,
        'domain': domain or '(all)',
        'count': len(summary),
        'items': summary,
    })


# ---------- router ----------------------------------------------------------

def handler(event, _context):
    method = (event.get('requestContext', {}).get('http', {}).get('method') or '').upper()
    raw_path = event.get('rawPath') or '/'

    # CORS preflight
    if method == 'OPTIONS':
        return _resp(200, {})

    # Strip /v1 prefix if present, route everything else.
    path = raw_path
    if path.startswith('/v1'):
        path = path[3:] or '/'

    if path in ('/', '/healthz', '/health'):
        return _healthz(event)

    auth_err = _require_auth(event)
    if auth_err:
        return auth_err

    if path == '/skills' and method == 'GET':
        return _list(event)
    if path == '/skills' and method == 'POST':
        return _save(event)
    if path == '/skills/search' and method == 'POST':
        return _search(event)
    m = re.match(r'^/skills/([A-Za-z0-9_\-]+)$', path)
    if m:
        if method == 'GET':
            return _get(event, m.group(1))
        if method == 'DELETE':
            return _delete(event, m.group(1))

    return _resp(404, {'error': 'unknown route', 'method': method, 'path': raw_path})
