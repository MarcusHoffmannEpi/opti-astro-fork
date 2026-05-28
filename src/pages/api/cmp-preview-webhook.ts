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

// Process-lifetime token cache — reused across requests until near expiry
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getCmpAccessToken(): Promise<string> {
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt > now + 60_000) {
        return tokenCache.token;
    }

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

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`CMP OAuth token request failed: ${response.status} ${body}`);
    }

    const data = await response.json();
    tokenCache = {
        token: data.access_token,
        expiresAt: now + (data.expires_in ?? 3600) * 1000,
    };
    return tokenCache.token;
}

export const POST: APIRoute = async ({ request, url: requestUrl }) => {
    // 1. Validate Callback-Secret header — CMP sends the plain secret string configured
    //    in Settings > Apps & Webhooks > Webhooks.
    const callbackSecret = request.headers.get('Callback-Secret') ?? '';
    if (!validateWebhookSecret(callbackSecret, CMP_WEBHOOK_SECRET)) {
        return respond({ error: 'Unauthorized' }, 401);
    }

    let payload: CmpWebhookPayload;
    try {
        payload = await request.json();
    } catch {
        return respond({ error: 'Invalid JSON payload' }, 400);
    }

    // Only handle content_preview_requested — silently accept other events
    if (payload?.event_name !== 'content_preview_requested') {
        return respond({ ok: true }, 200);
    }

    const acknowledgeUrl = payload.data?.links?.acknowledge;
    const completeUrl = payload.data?.links?.complete;
    const structuredContents = payload.data?.assets?.structured_contents ?? [];
    const contentHash = structuredContents[0]?.content_body?.fields_version?.content_hash;

    if (!acknowledgeUrl || !completeUrl || !contentHash) {
        console.error('[CMP Webhook] Missing required fields: acknowledge URL, complete URL, or content_hash');
        return respond({ error: 'Missing required payload fields' }, 400);
    }

    // Extract content_id and version_id from the acknowledge URL path.
    // The CMP+CMS integration syncs structured content to CMS using content_id as
    // the CMS content key. Adjust parseCmpPreviewIds if your setup differs.
    const ids = parseCmpPreviewIds(acknowledgeUrl);
    if (!ids) {
        console.error('[CMP Webhook] Could not parse content IDs from URL:', acknowledgeUrl);
        return respond({ error: 'Cannot parse content IDs from acknowledge URL' }, 400);
    }
    const { contentId, versionId } = ids;

    let accessToken: string;
    try {
        accessToken = await getCmpAccessToken();
    } catch (err) {
        console.error('[CMP Webhook] Failed to obtain CMP access token:', err);
        return respond({ error: 'CMP authentication failed' }, 502);
    }

    // 2. Acknowledge — tells CMP that this system will generate the preview.
    //    Only one system should acknowledge per preview request.
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

    if (!ackResponse.ok) {
        const body = await ackResponse.text();
        // 409 means already acknowledged — safe to continue
        if (ackResponse.status !== 409) {
            console.error(`[CMP Webhook] Acknowledge failed: ${ackResponse.status} ${body}`);
            return respond({ error: 'Acknowledge step failed' }, 502);
        }
    }

    // 3. Build signed preview URL pointing to our cmp-preview page
    const token = generateCmpPreviewToken(contentId, versionId, CMP_WEBHOOK_SECRET);
    const previewUrl = new URL('/cmp-preview', requestUrl.origin);
    previewUrl.searchParams.set('content_id', contentId);
    previewUrl.searchParams.set('version_id', versionId);
    previewUrl.searchParams.set('token', token);

    // 4. Complete — deliver the preview URL to CMP.
    //    keyed_previews is a dict; the key is the label shown in CMP's preview dropdown.
    const completeResponse = await fetch(completeUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            keyed_previews: {
                'Live Preview': {
                    url: previewUrl.toString(),
                },
            },
        }),
    });

    if (!completeResponse.ok) {
        const body = await completeResponse.text();
        console.error(`[CMP Webhook] Complete failed: ${completeResponse.status} ${body}`);
        return respond({ error: 'Complete step failed' }, 502);
    }

    return respond({ success: true, previewUrl: previewUrl.toString() }, 200);
};

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
