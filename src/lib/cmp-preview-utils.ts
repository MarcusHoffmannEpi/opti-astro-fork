import crypto from 'crypto';

/**
 * Generates a short HMAC token used to authenticate CMP preview URLs.
 * Signed with the configured CMP_WEBHOOK_SECRET.
 */
export function generateCmpPreviewToken(contentId: string, versionId: string, secret: string): string {
    return crypto
        .createHmac('sha256', secret)
        .update(`${contentId}:${versionId}`)
        .digest('hex')
        .substring(0, 32);
}

/**
 * Validates a CMP preview token using a timing-safe comparison.
 */
export function validateCmpPreviewToken(
    contentId: string,
    versionId: string,
    token: string,
    secret: string
): boolean {
    const expected = generateCmpPreviewToken(contentId, versionId, secret);
    if (token.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch {
        return false;
    }
}

/**
 * Validates the Callback-Secret header sent by CMP using a timing-safe comparison.
 */
export function validateWebhookSecret(received: string, configured: string): boolean {
    if (received.length !== configured.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(configured, 'utf8'));
    } catch {
        return false;
    }
}

// ── Embedded-data preview URL helpers ────────────────────────────────────────
// Content fields are base64url-encoded + HMAC-signed directly in the URL so
// the preview page requires zero CMP API calls, keeping render time < 5s.

export interface CmpPreviewData {
    heading: string;
    subHeading: string;
    author: string;
    bodyHtml: string;
    publishedDate: string;
    promoImageUrl: string | null;
}

export function encodePreviewData(data: CmpPreviewData): string {
    return Buffer.from(JSON.stringify(data)).toString('base64url');
}

export function decodePreviewData(encoded: string): CmpPreviewData {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

export function signPreviewData(encoded: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(encoded).digest('hex').substring(0, 32);
}

export function verifyPreviewData(encoded: string, sig: string, secret: string): boolean {
    const expected = signPreviewData(encoded, secret);
    if (sig.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch {
        return false;
    }
}

/**
 * Parses content_id, version_id, and preview_id out of a CMP acknowledge or complete URL.
 * Example: https://api.cmp.optimizely.com/v3/structured-content/contents/{content_id}/versions/{version_id}/previews/{preview_id}/acknowledge
 */
export function parseCmpPreviewIds(url: string): { contentId: string; versionId: string; previewId: string } | null {
    const match = url.match(/contents\/([^/]+)\/versions\/([^/]+)\/previews\/([^/]+)/);
    if (!match) return null;
    return { contentId: match[1], versionId: match[2], previewId: match[3] };
}
