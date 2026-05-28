/**
 * CMP API client for server-side use in Astro pages.
 * Handles OAuth token management and structured content fetching.
 */

import { CMP_CLIENT_ID, CMP_CLIENT_SECRET } from 'astro:env/server';

const CMP_API_BASE = 'https://api.welcomesoftware.com/v3';
const CMP_TOKEN_URL = 'https://accounts.cmp.optimizely.com/o/oauth2/v1/token';

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
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
        throw new Error(`CMP OAuth failed: ${response.status} ${body}`);
    }

    const data = await response.json();
    tokenCache = {
        token: data.access_token,
        expiresAt: now + (data.expires_in ?? 3600) * 1000,
    };
    return tokenCache.token;
}

export async function fetchCmpContent(contentId: string, versionId: string): Promise<any> {
    const token = await getAccessToken();
    const response = await fetch(
        `${CMP_API_BASE}/structured-content/contents/${contentId}/versions/${versionId}`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
    );
    if (!response.ok) {
        throw new Error(`CMP content fetch failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
}

export async function fetchCmpAssetUrl(assetGuid: string): Promise<string | null> {
    try {
        const token = await getAccessToken();
        const response = await fetch(`${CMP_API_BASE}/asset-urls/${assetGuid}`, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: 'follow',
            cache: 'no-store',
        });
        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
            const data = await response.json();
            return data.original_url ?? data.url ?? data.thumbnail_url ?? null;
        }
        // Some CDN endpoints redirect directly to the image
        return response.url !== `${CMP_API_BASE}/asset-urls/${assetGuid}` ? response.url : null;
    } catch {
        return null;
    }
}

// ── Field extraction helpers ──────────────────────────────────────────────────
// CMP fields structure: { key: [{ locale: "en", field_values: [{ text_value|rich_text_value|asset_guid: ... }] }] }

export function getCmpTextField(fields: any, key: string): string {
    return fields?.[key]?.[0]?.field_values?.[0]?.text_value ?? '';
}

export function getCmpRichTextField(fields: any, key: string): string {
    return fields?.[key]?.[0]?.field_values?.[0]?.rich_text_value ?? '';
}

export function getCmpAssetGuid(fields: any, key: string): string {
    return fields?.[key]?.[0]?.field_values?.[0]?.asset_guid ?? '';
}
