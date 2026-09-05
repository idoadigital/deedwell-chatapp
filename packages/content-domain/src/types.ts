/** The four things the Content surface can make. Kept as a closed union so
 *  the DB CHECK, the API schema and the design guidance never drift apart. */
export const CONTENT_KINDS = ["social", "flyer", "buying_guide", "event_promo"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const CONTENT_KIND_LABELS: Record<ContentKind, string> = {
  social: "Social media content",
  flyer: "Flyer",
  buying_guide: "Buying guide",
  event_promo: "Event promo",
};

/** What each kind is physically for — feeds both the strategy step and the
 *  image prompts, so a flyer is composed as a flyer rather than as a square. */
export const CONTENT_KIND_SPEC: Record<ContentKind, { surface: string; size: string; aspect: string }> = {
  social: { surface: "an Instagram / LinkedIn feed post", size: "1024x1024", aspect: "square" },
  flyer: { surface: "a printable one-page flyer", size: "1024x1536", aspect: "portrait" },
  buying_guide: { surface: "the cover of a downloadable guide", size: "1024x1536", aspect: "portrait" },
  event_promo: { surface: "an event announcement graphic", size: "1536x1024", aspect: "landscape" },
};

export interface DesignBrief {
  /** Short human label shown under the design in the campaign view. */
  caption: string;
  /** The full image prompt, already carrying the design guidelines. */
  prompt: string;
  /** The social media caption to post alongside the image: hook, point,
   *  call to action, hashtags. Written from the same strategy so the words
   *  and the picture say one thing. */
  postText?: string;
}

export interface ContentStrategy {
  audience: string;
  message: string;
  tone: string;
  palette: string;
  designs: DesignBrief[];
}
