/** Turn verbose Event Registry objects into compact, token-friendly shapes for LLM agents. */

type AnyObj = Record<string, any>;

/** Event Registry labels are often `{eng: "...", deu: "..."}` – pick the preferred language. */
export function label(v: unknown, prefLang = "eng"): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as AnyObj;
    return o[prefLang] ?? o.eng ?? (Object.values(o).find((x) => typeof x === "string") as string | undefined);
  }
  return String(v);
}

export function truncate(s: unknown, max: number): string | undefined {
  if (typeof s !== "string") return undefined;
  if (max < 0 || s.length <= max) return s;
  if (max === 0) return undefined;
  return s.slice(0, max).replace(/\s+\S*$/, "") + " …";
}

export function compactArticle(a: AnyObj, opts: { bodyChars: number; lang?: string }): AnyObj {
  const out: AnyObj = {
    uri: a.uri,
    title: a.title,
    url: a.url,
    source: a.source ? a.source.title ?? a.source.uri : undefined,
    sourceUri: a.source?.uri,
    published: a.dateTimePub ?? a.dateTime ?? a.date,
    lang: a.lang,
    dataType: a.dataType !== "news" ? a.dataType : undefined,
    authors: Array.isArray(a.authors) && a.authors.length ? a.authors.map((x: AnyObj) => x.name).filter(Boolean) : undefined,
    sentiment: typeof a.sentiment === "number" ? Math.round(a.sentiment * 100) / 100 : undefined,
    isDuplicate: a.isDuplicate || undefined,
    eventUri: a.eventUri || undefined,
    image: a.image || undefined,
    body: truncate(a.body, opts.bodyChars),
  };
  if (Array.isArray(a.concepts) && a.concepts.length) {
    out.concepts = a.concepts.slice(0, 10).map((c: AnyObj) => ({ uri: c.uri, label: label(c.label, opts.lang), type: c.type }));
  }
  if (Array.isArray(a.categories) && a.categories.length) {
    out.categories = a.categories.slice(0, 5).map((c: AnyObj) => c.label ?? c.uri);
  }
  return clean(out);
}

export function compactEvent(e: AnyObj, opts: { summaryChars: number; lang?: string }): AnyObj {
  const counts = e.articleCounts ?? {};
  return clean({
    uri: e.uri,
    title: label(e.title, opts.lang),
    summary: truncate(label(e.summary, opts.lang), opts.summaryChars),
    eventDate: e.eventDate,
    articleCount: e.totalArticleCount ?? counts.total,
    location: e.location
      ? [label(e.location.label, opts.lang), label(e.location.country?.label, opts.lang)].filter(Boolean).join(", ") || undefined
      : undefined,
    sentiment: typeof e.sentiment === "number" ? Math.round(e.sentiment * 100) / 100 : undefined,
    concepts: Array.isArray(e.concepts)
      ? e.concepts.slice(0, 8).map((c: AnyObj) => ({ uri: c.uri, label: label(c.label, opts.lang), type: c.type }))
      : undefined,
    categories: Array.isArray(e.categories) ? e.categories.slice(0, 5).map((c: AnyObj) => c.label ?? c.uri) : undefined,
    image: Array.isArray(e.images) ? e.images[0] : undefined,
  });
}

export function compactSuggestion(kind: string, s: AnyObj, lang?: string): AnyObj {
  switch (kind) {
    case "sources":
      return clean({ uri: s.uri, title: s.title, dataType: s.dataType });
    case "locations":
      return clean({
        uri: s.wikiUri ?? s.uri,
        label: label(s.label, lang),
        type: s.type,
        country: label(s.country?.label, lang),
      });
    case "categories":
      return clean({ uri: s.uri, label: s.label, parentUri: s.parentUri });
    case "authors":
      return clean({ uri: s.uri, name: s.name, source: s.source?.title ?? s.source?.uri });
    case "source_groups":
      return clean({ uri: s.uri, label: label(s.label, lang) ?? s.title, description: s.description });
    default:
      return clean({ uri: s.uri, label: label(s.label, lang), type: s.type });
  }
}

/** Remove undefined/empty values so the output stays small. */
export function clean<T extends AnyObj>(o: T): T {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) delete o[k];
  }
  return o;
}
