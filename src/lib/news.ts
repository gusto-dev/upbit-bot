// Simple news/sentiment gate for KR crypto context
// - Pulls headlines from configured feeds (RSS/Atom/JSON)
// - Matches titles against negative/positive keyword lists
// - Provides a shouldRestrict() boolean for entry gating

type NewsItem = { title: string; published: number; link?: string };

export type NewsFilterOpts = {
  timeWindowMs: number; // consider items within this window
  negativeKeywords: string[]; // comma-split from env
  positiveKeywords?: string[]; // optional
  blockIfNegativeCount: number; // threshold to trigger restriction
};

export class SimpleNewsSentiment {
  private feeds: string[];
  private opts: NewsFilterOpts;
  private items: NewsItem[] = [];
  private lastFetched = 0;
  private lastReason = "";

  constructor(feeds: string[], opts: NewsFilterOpts) {
    this.feeds = feeds.filter(Boolean);
    this.opts = opts;
  }

  getLastReason() {
    return this.lastReason;
  }

  async refreshNow(): Promise<void> {
    if (!this.feeds.length) return;
    const all: NewsItem[] = [];
    for (const url of this.feeds) {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "upbit-bot" },
        });
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        const text = await res.text();
        const parsed = ct.includes("application/json")
          ? this.parseJson(text)
          : this.parseXmlLike(text);
        all.push(...parsed);
      } catch {
        // ignore per-feed errors
      }
    }
    const now = Date.now();
    const floor = now - this.opts.timeWindowMs;
    this.items = all.filter((i) => i.published > 0 && i.published >= floor);
    this.lastFetched = now;
  }

  // Naive JSON parser: supports arrays of objects with {title, publishedAt/isoDate/date}
  private parseJson(text: string): NewsItem[] {
    try {
      const data = JSON.parse(text);
      const arr: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data && (data.items || data.articles))
        ? data.items || data.articles
        : [];
      const out: NewsItem[] = [];
      for (const it of arr) {
        const title = String(it.title || it.headline || "").trim();
        if (!title) continue;
        const tRaw =
          it.publishedAt || it.isoDate || it.updated || it.date || it.pubDate;
        const ts = tRaw ? Date.parse(tRaw) : 0;
        out.push({
          title,
          published: Number.isFinite(ts) ? ts : 0,
          link: it.link || it.url,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  // Minimal XML/Atom/RSS parsing via regex for <item> / <entry>
  private parseXmlLike(xml: string): NewsItem[] {
    const out: NewsItem[] = [];
    // Try RSS <item>
    const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    if (items.length) {
      for (const block of items) {
        const title = this.extractTag(block, "title");
        if (!title) continue;
        const pub =
          this.extractTag(block, "pubDate") || this.extractTag(block, "date");
        const ts = pub ? Date.parse(pub) : 0;
        const link = this.extractTag(block, "link");
        out.push({
          title: title.trim(),
          published: Number.isFinite(ts) ? ts : 0,
          link: link || undefined,
        });
      }
      return out;
    }
    // Try Atom <entry>
    const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
    for (const block of entries) {
      const title = this.extractTag(block, "title");
      if (!title) continue;
      const pub =
        this.extractTag(block, "updated") ||
        this.extractTag(block, "published");
      const ts = pub ? Date.parse(pub) : 0;
      const link = this.extractHref(block);
      out.push({
        title: title.trim(),
        published: Number.isFinite(ts) ? ts : 0,
        link: link || undefined,
      });
    }
    return out;
  }

  private extractTag(block: string, tag: string): string | undefined {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(
      block
    );
    if (!m) return undefined;
    // strip CDATA
    return m[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "");
  }

  private extractHref(block: string): string | undefined {
    const m = /<link[^>]*href=["']([^"']+)["'][^>]*\/>/i.exec(block);
    return m ? m[1] : undefined;
  }

  // Evaluate whether to restrict entries due to negative headlines
  shouldRestrict(): boolean {
    const now = Date.now();
    const floor = now - this.opts.timeWindowMs;
    const relevant = this.items.filter((i) => i.published >= floor);
    const negKw = this.opts.negativeKeywords
      .map((k) => k.trim())
      .filter(Boolean);
    let negCount = 0;
    const hitTitles: string[] = [];
    for (const it of relevant) {
      const lower = it.title.toLowerCase();
      if (negKw.some((kw) => kw && lower.includes(kw.toLowerCase()))) {
        negCount++;
        hitTitles.push(it.title);
      }
    }
    const restrict = negCount >= this.opts.blockIfNegativeCount;
    this.lastReason = restrict
      ? `neg=${negCount} in window: ${hitTitles.slice(0, 3).join(" | ")}`
      : "";
    return restrict;
  }
}
