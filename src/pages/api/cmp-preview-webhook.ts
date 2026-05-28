/**
 * CMP Preview Webhook Handler
 *
 * Receives `content_preview_requested` events from Optimizely Content Marketing
 * Platform (CMP), acknowledges them, and completes the preview by posting a
 * signed preview URL back to CMP.
 *
 * Three-step protocol:
 *  1. CMP sends POST to this endpoint (Callback-Secret header for validation)
 *  2. We acknowledge via the URL in payload.data.links.acknowledge
 *  3. We complete via payload.data.links.complete with our signed preview URL
 *
 * Register this endpoint in CMP:
 *   Settings > Apps & Webhooks > Webhooks > Register New > General Webhook
 *   Event: content_preview_requested
 *   Callback URL: https://<your-domain>/api/cmp-preview-webhook
 *   Secret: value of CMP_WEBHOOK_SECRET env var
 *
 * CMP API credentials:
 *   Settings > Apps & Webhooks > Apps > Register New App
 *   Grant type: Client Credentials (machine-to-machine)
 *   Copy the resulting client_id → CMP_CLIENT_ID
 *                    client_secret → CMP_CLIENT_SECRET
 */

import type { APIRoute } from 'astro';
import { validateWebhookSecret, parseCmpPreviewIds, generateCmpPreviewToken } from '../../lib/cmp-preview-utils';
import { CMP_WEBHOOK_SECRET, CMP_CLIENT_ID, CMP_CLIENT_SECRET } from 'astro:env/server';

export const prerender = false;

const CMP_TOKEN_URL = 'https://accounts.cmp.optimizely.com/o/oauth2/v1/token';
const LOG = '[CMP Webhook]';

// Process-lifetime token cache — reused across requests until near expiry
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getCmpAccessToken(): Promise<string> {
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt > now + 60_000) {
        console.log(`${LOG} Using cached access token (expires in ${Math.round((tokenCache.expiresAt - now) / 1000)}s)`);
        return tokenCache.token;
    }

    console.log(`${LOG} Requesting new CMP access token from ${CMP_TOKEN_URL}`);
    const response = await fetch(CMP_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: CMP_CLIENT_ID,
            client_secret: CMP_CLIENT_SECRET,
        }),
        cache: 'no-store',
    });

    const body = await response.text();
    if (!response.ok) {
        throw new Error(`CMP OAuth token request failed: ${response.status} ${body}`);
    }

    const data = JSON.parse(body);
    console.log(`${LOG} Access token obtained, expires_in=${data.expires_in}s`);
    tokenCache = {
        token: data.access_token,
        expiresAt: now + (data.expires_in ?? 3600) * 1000,
    };
    return tokenCache.token;
}

export const POST: APIRoute = async ({ request, url: requestUrl }) => {
    console.log(`${LOG} Received POST from ${request.headers.get('user-agent') ?? 'unknown'}`);

    // 1. Validate Callback-Secret header — CMP sends the plain secret string configured
    //    in Settings > Apps & Webhooks > Webhooks.
    const callbackSecret = request.headers.get('Callback-Secret') ?? '';
    if (!validateWebhookSecret(callbackSecret, CMP_WEBHOOK_SECRET)) {
        console.error(`${LOG} Callback-Secret validation failed (received length: ${callbackSecret.length}, expected length: ${CMP_WEBHOOK_SECRET.length})`);
        return respond({ error: 'Unauthorized' }, 401);
    }
    console.log(`${LOG} Callback-Secret validated OK`);

    let payload: CmpWebhookPayload;
    try {
        payload = await request.json();
    } catch (err) {
        console.error(`${LOG} Failed to parse JSON payload:`, err);
        return respond({ error: 'Invalid JSON payload' }, 400);
    }

    console.log(`${LOG} event_name="${payload?.event_name}", task_id="${payload?.data?.task?.id}"`);

    // Only handle content_preview_requested — silently accept other events
    if (payload?.event_name !== 'content_preview_requested') {
        console.log(`${LOG} Ignoring event "${payload?.event_name}"`);
        return respond({ ok: true }, 200);
    }

    const acknowledgeUrl = payload.data?.links?.acknowledge;
    const completeUrl    = payload.data?.links?.complete;
    const structuredContents = payload.data?.assets?.structured_contents ?? [];
    const contentHash = structuredContents[0]?.content_body?.fields_version?.content_hash;

    console.log(`${LOG} acknowledgeUrl="${acknowledgeUrl}"`);
    console.log(`${LOG} completeUrl="${completeUrl}"`);
    console.log(`${LOG} structuredContents count=${structuredContents.length}, contentHash="${contentHash}"`);
    console.log(`${LOG} Full structured content payload: ${JSON.stringify(structuredContents[0], null, 2)}`);

    if (!acknowledgeUrl || !completeUrl || !contentHash) {
        console.error(`${LOG} Missing required fields — acknowledgeUrl=${!!acknowledgeUrl}, completeUrl=${!!completeUrl}, contentHash=${!!contentHash}`);
        return respond({ error: 'Missing required payload fields' }, 400);
    }

    const ids = parseCmpPreviewIds(acknowledgeUrl);
    if (!ids) {
        console.error(`${LOG} Could not parse content IDs from acknowledge URL: ${acknowledgeUrl}`);
        return respond({ error: 'Cannot parse content IDs from acknowledge URL' }, 400);
    }
    const { contentId, versionId } = ids;
    console.log(`${LOG} Parsed contentId="${contentId}", versionId="${versionId}"`);

    let accessToken: string;
    try {
        accessToken = await getCmpAccessToken();
    } catch (err) {
        console.error(`${LOG} Failed to obtain CMP access token:`, err);
        return respond({ error: 'CMP authentication failed' }, 502);
    }

    // 2. Acknowledge
    console.log(`${LOG} Sending acknowledge to ${acknowledgeUrl}`);
    const ackResponse = await fetch(acknowledgeUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            acknowledged_by: 'cms-preview-handler',
            content_hash: contentHash,
        }),
    });

    const ackBody = await ackResponse.text();
    console.log(`${LOG} Acknowledge response: ${ackResponse.status} ${ackBody}`);

    // 409 = already acknowledged, 412 = not in requested state (e.g. expired or re-triggered) — both are recoverable, still attempt complete
    if (!ackResponse.ok && ackResponse.status !== 409 && ackResponse.status !== 412) {
        console.error(`${LOG} Acknowledge failed (non-recoverable): ${ackResponse.status} ${ackBody}`);
        return respond({ error: 'Acknowledge step failed' }, 502);
    }

    // 3. Build signed preview URL
    const token = generateCmpPreviewToken(contentId, versionId, CMP_WEBHOOK_SECRET);
    const previewUrl = new URL('/cmp-preview', requestUrl.origin);
    previewUrl.searchParams.set('content_id', contentId);
    previewUrl.searchParams.set('version_id', versionId);
    previewUrl.searchParams.set('token', token);
    console.log(`${LOG} Preview URL: ${previewUrl.toString()}`);

    // 4. Complete — fire and forget so CMP's 29s API Gateway timeout doesn't block
    //    our webhook response. Vercel's Node runtime keeps the function alive while
    //    the promise is pending (up to maxDuration in vercel.json).
    void callComplete(completeUrl, previewUrl.toString(), accessToken);

    console.log(`${LOG} Returning 200 to CMP; complete running in background`);
    return respond({ success: true, previewUrl: previewUrl.toString() }, 200);
};

async function callComplete(completeUrl: string, previewUrl: string, accessToken: string): Promise<void> {
    const body = JSON.stringify({ keyed_previews: { 'Live Preview': previewUrl } });
    console.log(`${LOG} [bg] Sending complete to ${completeUrl}`);
    try {
        const res = await fetch(completeUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body,
        });
        const resBody = await res.text();
        if (res.ok) {
            console.log(`${LOG} [bg] Complete response: ${res.status} — preview registered`);
        } else {
            console.error(`${LOG} [bg] Complete failed: ${res.status} ${resBody}`);
        }
    } catch (err) {
        console.error(`${LOG} [bg] Complete threw:`, err);
    }
}

function respond(data: object, status: number): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// ── Payload types ─────────────────────────────────────────────────────────────

interface CmpStructuredContent {
    content_body?: {
        fields_version?: {
            content_hash?: string;
        };
    };
}

interface CmpWebhookPayload {
    event_name?: string;
    data?: {
        assets?: {
            structured_contents?: CmpStructuredContent[];
        };
        task?: {
            id?: string;
        };
        links?: {
            acknowledge?: string;
            complete?: string;
        };
    };
}
