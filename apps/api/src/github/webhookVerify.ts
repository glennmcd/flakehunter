import { Webhooks } from "@octokit/webhooks";

export function createWebhookVerifier(secret: string) {
  const webhooks = new Webhooks({ secret });
  return {
    verify: (payload: string, signature: string | undefined) => {
      if (!signature) return Promise.resolve(false);
      return webhooks.verify(payload, signature);
    },
  };
}
