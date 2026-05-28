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

/**
 * Parses content_id, version_id, and preview_id out of a CMP acknowledge or complete URL.
 * Example: https://api.cmp.optimizely.com/v3/structured-content/contents/{content_id}/versions/{version_id}/previews/{preview_id}/acknowledge
 */
export function parseCmpPreviewIds(url: string): { contentId: string; versionId: string; previewId: string } | null {
    const match = url.match(/contents\/([^/]+)\/versions\/([^/]+)\/previews\/([^/]+)/);
    if (!match) return null;
    return { contentId: match[1], versionId: match[2], previewId: match[3] };
}
