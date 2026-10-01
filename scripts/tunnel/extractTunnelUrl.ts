const TUNNEL_URL = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi;

/**
 * Finds the quick tunnel URL in cloudflared output, e.g. the boxed "Your quick Tunnel has been created!" block.
 * `api.trycloudflare.com` is skipped: cloudflared prints it in error messages, and it is not our tunnel.
 */
export function extractTunnelUrl(text: string): string | null {
  for (const match of text.matchAll(TUNNEL_URL)) {
    if (match[1]?.toLowerCase() !== "api") return match[0].toLowerCase();
  }
  return null;
}

export function webhookUrl(tunnelUrl: string): string {
  return `${tunnelUrl.replace(/\/+$/, "")}/webhooks/github`;
}
