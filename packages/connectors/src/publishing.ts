import type { OAuthTokens } from "./types.js";

export interface PublishRequest {
  content: string;
  /** Publicly reachable media URLs, in order. Meta fetches these itself. */
  mediaUrls?: string[];
  /** Provider-specific context stored on the connection (page id, page token). */
  connection: {
    provider: string;
    connectorType: string;
    providerAccountId: string;
    metadata: Record<string, unknown>;
  };
  tokens: OAuthTokens;
}

export interface PublishResult {
  providerPostId: string;
}

/** What a platform adapter must do. Facebook is one implementation, not the
 *  shape of the system — LinkedIn/TikTok/X slot in beside it. */
export interface PublishingProvider {
  readonly provider: string;
  publishPost(req: PublishRequest): Promise<PublishResult>;
  publishImage(req: PublishRequest): Promise<PublishResult>;
  publishVideo(req: PublishRequest): Promise<PublishResult>;
  publishCarousel(req: PublishRequest): Promise<PublishResult>;
}

const GRAPH = process.env.META_GRAPH_BASE ?? "https://graph.facebook.com/v21.0";

/** Facebook Pages and Instagram publishing. Instagram is a two-step protocol
 *  (create a media container, then publish it) and has no text-only post — an
 *  Instagram post without media is rejected rather than silently dropped. */
export class MetaPublishingProvider implements PublishingProvider {
  readonly provider = "meta";

  private pageToken(req: PublishRequest): string {
    return String(req.connection.metadata.pageAccessToken ?? req.tokens.accessToken);
  }

  async publishPost(req: PublishRequest): Promise<PublishResult> {
    if (req.connection.connectorType === "instagram_account") {
      if (!req.mediaUrls?.length) throw new Error("Instagram posts require at least one image or video.");
      return req.mediaUrls.length > 1 ? this.publishCarousel(req) : this.publishImage(req);
    }
    if (req.mediaUrls?.length) return this.publishImage(req);
    return post(`${GRAPH}/${req.connection.providerAccountId}/feed`, {
      message: req.content,
      access_token: this.pageToken(req),
    });
  }

  async publishImage(req: PublishRequest): Promise<PublishResult> {
    const [url] = req.mediaUrls ?? [];
    if (!url) throw new Error("No image to publish.");
    if (req.connection.connectorType === "instagram_account") {
      const container = await post(`${GRAPH}/${req.connection.providerAccountId}/media`, {
        image_url: url, caption: req.content, access_token: this.pageToken(req),
      });
      return this.finishInstagram(req, container.providerPostId);
    }
    return post(`${GRAPH}/${req.connection.providerAccountId}/photos`, {
      url, caption: req.content, access_token: this.pageToken(req),
    });
  }

  async publishVideo(req: PublishRequest): Promise<PublishResult> {
    const [url] = req.mediaUrls ?? [];
    if (!url) throw new Error("No video to publish.");
    if (req.connection.connectorType === "instagram_account") {
      const container = await post(`${GRAPH}/${req.connection.providerAccountId}/media`, {
        media_type: "REELS", video_url: url, caption: req.content, access_token: this.pageToken(req),
      });
      return this.finishInstagram(req, container.providerPostId);
    }
    return post(`${GRAPH}/${req.connection.providerAccountId}/videos`, {
      file_url: url, description: req.content, access_token: this.pageToken(req),
    });
  }

  async publishCarousel(req: PublishRequest): Promise<PublishResult> {
    const urls = req.mediaUrls ?? [];
    if (urls.length < 2) throw new Error("A carousel needs at least two items.");
    if (req.connection.connectorType !== "instagram_account") {
      // Facebook carousels are an ads format; organically this is just a
      // multi-photo post, which is not the same thing. Refuse rather than
      // quietly publish something different from what was approved.
      throw new Error("Carousels are supported on Instagram only.");
    }
    const children: string[] = [];
    for (const url of urls) {
      const child = await post(`${GRAPH}/${req.connection.providerAccountId}/media`, {
        image_url: url, is_carousel_item: "true", access_token: this.pageToken(req),
      });
      children.push(child.providerPostId);
    }
    const container = await post(`${GRAPH}/${req.connection.providerAccountId}/media`, {
      media_type: "CAROUSEL", children: children.join(","), caption: req.content,
      access_token: this.pageToken(req),
    });
    return this.finishInstagram(req, container.providerPostId);
  }

  private finishInstagram(req: PublishRequest, creationId: string): Promise<PublishResult> {
    return post(`${GRAPH}/${req.connection.providerAccountId}/media_publish`, {
      creation_id: creationId, access_token: this.pageToken(req),
    });
  }
}

const PROVIDERS = new Map<string, PublishingProvider>([["meta", new MetaPublishingProvider()]]);

/**
 * The one thing the rest of the app calls. Nothing above this layer knows what
 * Facebook is — adding LinkedIn means registering another PublishingProvider.
 */
export class SocialPublishingService {
  static forProvider(name: string): PublishingProvider {
    const provider = PROVIDERS.get(name);
    if (!provider) throw new Error(`No publishing provider registered for "${name}"`);
    return provider;
  }

  static register(provider: PublishingProvider): void {
    PROVIDERS.set(provider.provider, provider);
  }

  static publish(req: PublishRequest): Promise<PublishResult> {
    return SocialPublishingService.forProvider(req.connection.provider).publishPost(req);
  }
}

async function post(url: string, form: Record<string, string>): Promise<PublishResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(body?.error?.message ?? `Publish failed (${res.status})`);
  return { providerPostId: String(body.id ?? body.post_id ?? "") };
}
