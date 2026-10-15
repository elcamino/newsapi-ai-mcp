import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NewsApiClient, NewsApiError, stripUndefined } from "./client.js";
import { compactArticle, compactEvent, compactSuggestion } from "./format.js";

const LANG_HINT = "ISO 639-2 three-letter codes, e.g. eng, deu, fra, spa, ita, zho";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const strOrArr = z.union([z.string(), z.array(z.string())]);
const toArr = (v?: string | string[]) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

const date = z.string().regex(DATE_RE, "Use YYYY-MM-DD");

const responseFormat = z
  .enum(["compact", "raw"])
  .default("compact")
  .describe("compact (default): trimmed, token-friendly JSON. raw: the unmodified API response.");

/** Filters shared by article and event search. */
const commonFilters = {
  keywords: strOrArr.optional().describe("Keyword(s) or phrase(s) to search for."),
  keyword_operator: z.enum(["and", "or"]).default("and").describe("Whether ALL (and) or ANY (or) keywords must match."),
  keyword_location: z
    .enum(["body", "title", "body,title"])
    .optional()
    .describe("Where keywords must appear: body (default), title (high precision), or body,title."),
  keyword_search_mode: z
    .enum(["simple", "exact", "phrase"])
    .optional()
    .describe("phrase (default): words of a phrase near each other; exact: exact match; simple: words anywhere."),
  ignore_keywords: strOrArr.optional().describe("Exclude results mentioning any of these keywords."),
  concept_uris: strOrArr.optional().describe("Concept URIs (Wikipedia URLs) – get them via newsapi_suggest kind=concepts."),
  concept_operator: z.enum(["and", "or"]).optional(),
  category_uris: strOrArr.optional().describe("Category URIs, e.g. dmoz/Computers/Artificial_Intelligence or news/Technology – via newsapi_suggest kind=categories."),
  source_uris: strOrArr.optional().describe("Source URIs (usually domains like heise.de, theverge.com) – via newsapi_suggest kind=sources."),
  source_group_uris: strOrArr.optional().describe("Source group URIs (curated lists such as top news sources) – via newsapi_suggest kind=source_groups."),
  source_location_uris: strOrArr.optional().describe("Only sources based in these locations (Wikipedia URLs, e.g. http://en.wikipedia.org/wiki/Germany)."),
  location_uris: strOrArr.optional().describe("Content about these locations (Wikipedia URLs) – via newsapi_suggest kind=locations."),
  ignore_source_uris: strOrArr.optional().describe("Exclude these sources."),
  lang: strOrArr.optional().describe(`Language filter, ${LANG_HINT}.`),
  date_start: date.optional().describe("Earliest publishing date, YYYY-MM-DD."),
  date_end: date.optional().describe("Latest publishing date, YYYY-MM-DD."),
  days_back: z.number().int().min(1).max(3650).optional().describe("Convenience: sets date_start to today minus N days (ignored if date_start is set)."),
  min_sentiment: z.number().min(-1).max(1).optional().describe("Min sentiment -1..1 (only English content has sentiment)."),
  max_sentiment: z.number().min(-1).max(1).optional(),
  force_max_data_time_window: z
    .union([z.literal(7), z.literal(31)])
    .optional()
    .describe("Restrict search to the last 7 or 31 days. Cheaper: queries reaching beyond 31 days consume more tokens (archive)."),
};

type Common = {
  keywords?: string | string[];
  keyword_operator?: "and" | "or";
  keyword_location?: string;
  keyword_search_mode?: string;
  ignore_keywords?: string | string[];
  concept_uris?: string | string[];
  concept_operator?: "and" | "or";
  category_uris?: string | string[];
  source_uris?: string | string[];
  source_group_uris?: string | string[];
  source_location_uris?: string | string[];
  location_uris?: string | string[];
  ignore_source_uris?: string | string[];
  lang?: string | string[];
  date_start?: string;
  date_end?: string;
  days_back?: number;
  min_sentiment?: number;
  max_sentiment?: number;
  force_max_data_time_window?: number;
};

function commonParams(a: Common): Record<string, unknown> {
  let dateStart = a.date_start;
  if (!dateStart && a.days_back) {
    const d = new Date(Date.now() - a.days_back * 86_400_000);
    dateStart = d.toISOString().slice(0, 10);
  }
  const kw = toArr(a.keywords);
  return stripUndefined({
    keyword: kw,
    keywordOper: kw && kw.length > 1 ? a.keyword_operator : undefined,
    keywordLoc: a.keyword_location,
    keywordSearchMode: a.keyword_search_mode,
    ignoreKeyword: toArr(a.ignore_keywords),
    conceptUri: toArr(a.concept_uris),
    conceptOper: a.concept_operator,
    categoryUri: toArr(a.category_uris),
    sourceUri: toArr(a.source_uris),
    sourceGroupUri: toArr(a.source_group_uris),
    sourceLocationUri: toArr(a.source_location_uris),
    locationUri: toArr(a.location_uris),
    ignoreSourceUri: toArr(a.ignore_source_uris),
    lang: toArr(a.lang),
    dateStart,
    dateEnd: a.date_end,
    minSentiment: a.min_sentiment,
    maxSentiment: a.max_sentiment,
    forceMaxDataTimeWindow: a.force_max_data_time_window,
  });
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof NewsApiError || err instanceof Error ? err.message : String(err) }],
});

function wrap<A>(fn: (a: A) => Promise<unknown>) {
  return async (a: A) => {
    try {
      return ok(await fn(a));
    } catch (err) {
      return fail(err);
    }
  };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

export function registerTools(server: McpServer, getClient: () => NewsApiClient) {
  // ---------------------------------------------------------------- articles
  server.registerTool(
    "newsapi_search_articles",
    {
      title: "Search news articles",
      description:
        "Search ~150k news/blog/press-release sources worldwide (newsapi.ai / Event Registry). " +
        "Filter by keywords, concepts, categories, sources, locations, language and date. " +
        "For entities (companies, people, places) prefer concept_uris over keywords – resolve them first with newsapi_suggest. " +
        "Each call consumes API tokens; queries older than 31 days cost more. Returns compact results unless response_format=raw.",
      inputSchema: {
        ...commonFilters,
        data_type: z.array(z.enum(["news", "blog", "pr"])).optional().describe("Content types. Default: news only."),
        duplicate_filter: z
          .enum(["keepAll", "skipDuplicates", "keepOnlyDuplicates"])
          .default("skipDuplicates")
          .describe("Syndicated copies of the same article. Default skipDuplicates."),
        event_filter: z
          .enum(["keepAll", "skipArticlesWithoutEvent", "keepOnlyArticlesWithoutEvent"])
          .optional()
          .describe("Filter by whether articles were clustered into an event."),
        start_source_rank_percentile: z.number().int().min(0).max(90).multipleOf(10).optional().describe("0..90 step 10; 0 = most important sources."),
        end_source_rank_percentile: z.number().int().min(10).max(100).multipleOf(10).optional().describe("10..100 step 10; e.g. 30 = only the top 30% most important sources."),
        advanced_query: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            'Advanced Query Language object, e.g. {"$query":{"$and":[{"keyword":"AI"},{"$or":[{"sourceUri":"heise.de"},{"sourceUri":"golem.de"}]}]},"$filter":{"isDuplicate":"skipDuplicates"}}. ' +
              "If given, it REPLACES all simple filters above (except sort/paging/output options).",
          ),
        sort_by: z
          .enum(["date", "rel", "sourceImportance", "sourceAlexaGlobalRank", "sourceAlexaCountryRank"])
          .default("date")
          .describe("date (newest first), rel (relevance), sourceImportance, …"),
        sort_asc: z.boolean().default(false),
        count: z.number().int().min(1).max(100).default(20).describe("Results per page, max 100."),
        page: z.number().int().min(1).default(1),
        body_chars: z
          .number()
          .int()
          .min(-1)
          .default(300)
          .describe("Characters of article body to return: 0 = none, -1 = full text. Default 300."),
        include_concepts: z.boolean().default(false).describe("Include extracted concepts (entities) per article."),
        include_categories: z.boolean().default(false),
        result_lang: z.string().optional().describe("Preferred language for concept labels (eng, deu, …)."),
        response_format: responseFormat,
      },
      annotations: READ_ONLY,
    },
    wrap(async (a: any) => {
      const params: Record<string, unknown> = a.advanced_query
        ? { query: a.advanced_query }
        : {
            ...commonParams(a),
            dataType: a.data_type,
            isDuplicateFilter: a.duplicate_filter,
            eventFilter: a.event_filter,
            startSourceRankPercentile: a.start_source_rank_percentile,
            endSourceRankPercentile: a.end_source_rank_percentile,
          };
      Object.assign(params, {
        resultType: "articles",
        articlesSortBy: a.sort_by,
        articlesSortByAsc: a.sort_asc,
        articlesCount: a.count,
        articlesPage: a.page,
        articleBodyLen: a.body_chars === 0 ? 0 : -1,
        includeArticleBody: a.body_chars !== 0,
        includeArticleConcepts: a.include_concepts || undefined,
        includeArticleCategories: a.include_categories || undefined,
        includeConceptLabel: a.include_concepts || undefined,
        conceptLang: a.include_concepts && a.result_lang ? a.result_lang : undefined,
        forceMaxDataTimeWindow: a.force_max_data_time_window,
      });
      const res = await getClient().request("/api/v1/article/getArticles", params);
      if (a.response_format === "raw") return res;
      const arts = res?.articles ?? {};
      return {
        totalResults: arts.totalResults ?? 0,
        page: arts.page,
        pages: arts.pages,
        articles: (arts.results ?? []).map((x: any) => compactArticle(x, { bodyChars: a.body_chars, lang: a.result_lang })),
      };
    }),
  );

  server.registerTool(
    "newsapi_get_articles",
    {
      title: "Get full articles",
      description:
        "Fetch full details (complete body text, authors, concepts, categories) for articles by their newsapi.ai URI (from search results) or by original article URL.",
      inputSchema: {
        uris: z.array(z.string()).max(100).optional().describe("Article URIs as returned by newsapi_search_articles."),
        urls: z.array(z.string().url()).max(20).optional().describe("Original article URLs – mapped to URIs first (only works for articles in the index)."),
        body_chars: z.number().int().min(-1).default(-1).describe("-1 = full body (default), 0 = none."),
        include_concepts: z.boolean().default(true),
        result_lang: z.string().optional(),
        response_format: responseFormat,
      },
      annotations: READ_ONLY,
    },
    wrap(async (a: any) => {
      const client = getClient();
      const uris: string[] = [...(a.uris ?? [])];
      const unmapped: string[] = [];
      for (const url of a.urls ?? []) {
        const m = await client.request("/api/v1/articleMapper", { articleUrl: url, includeAllVersions: false });
        const uri = m && typeof m === "object" ? (Object.values(m)[0] as string | null) : null;
        if (uri) uris.push(uri);
        else unmapped.push(url);
      }
      if (!uris.length) throw new NewsApiError(unmapped.length ? `None of the URLs are in the newsapi.ai index: ${unmapped.join(", ")}` : "Provide uris or urls.");
      const res = await client.request("/api/v1/article/getArticle", {
        articleUri: uris,
        resultType: "info",
        articleBodyLen: -1,
        includeArticleConcepts: a.include_concepts,
        includeArticleCategories: true,
        includeArticleLinks: true,
        includeConceptLabel: true,
        conceptLang: a.result_lang,
      });
      if (a.response_format === "raw") return res;
      const articles = Object.entries(res ?? {}).map(([uri, v]: [string, any]) =>
        v?.info ? compactArticle(v.info, { bodyChars: a.body_chars, lang: a.result_lang }) : { uri, error: v?.error ?? "not found" },
      );
      return unmapped.length ? { articles, unmappedUrls: unmapped } : { articles };
    }),
  );

  // ---------------------------------------------------------------- events
  server.registerTool(
    "newsapi_search_events",
    {
      title: "Search news events",
      description:
        "Search events: clusters of articles (often across languages) reporting on the same real-world happening. " +
        "Good for 'what happened around X' and for spotting stories with broad coverage. Same filters as article search.",
      inputSchema: {
        ...commonFilters,
        min_articles: z.number().int().min(1).optional().describe("Only events with at least N articles."),
        sort_by: z.enum(["date", "rel", "size", "socialScore"]).default("date").describe("size = number of articles."),
        sort_asc: z.boolean().default(false),
        count: z.number().int().min(1).max(50).default(20).describe("Max 50."),
        page: z.number().int().min(1).default(1),
        summary_chars: z.number().int().min(-1).default(400),
        result_lang: z.string().optional().describe("Preferred language for titles/summaries (eng, deu, …)."),
        advanced_query: z.record(z.string(), z.any()).optional().describe("Advanced Query Language object; replaces simple filters."),
        response_format: responseFormat,
      },
      annotations: READ_ONLY,
    },
    wrap(async (a: any) => {
      const params: Record<string, unknown> = a.advanced_query
        ? { query: a.advanced_query }
        : { ...commonParams(a), minArticlesInEvent: a.min_articles };
      Object.assign(params, {
        resultType: "events",
        eventsSortBy: a.sort_by,
        eventsSortByAsc: a.sort_asc,
        eventsCount: a.count,
        eventsPage: a.page,
        includeEventSummary: a.summary_chars !== 0,
        includeEventConcepts: true,
        includeEventCategories: true,
        includeEventLocation: true,
        includeConceptLabel: true,
        eventLang: a.result_lang,
        conceptLang: a.result_lang,
        forceMaxDataTimeWindow: a.force_max_data_time_window,
      });
      const res = await getClient().request("/api/v1/event/getEvents", params);
      if (a.response_format === "raw") return res;
      const ev = res?.events ?? {};
      return {
        totalResults: ev.totalResults ?? 0,
        page: ev.page,
        pages: ev.pages,
        events: (ev.results ?? []).map((x: any) => compactEvent(x, { summaryChars: a.summary_chars, lang: a.result_lang })),
      };
    }),
  );

  server.registerTool(
    "newsapi_get_event",
    {
      title: "Get event details",
      description: "Details for one event (summary, concepts, location) plus optionally its top articles.",
      inputSchema: {
        event_uri: z.string().describe("Event URI, e.g. eng-1234567"),
        articles_count: z.number().int().min(0).max(100).default(10).describe("Number of articles to include (0 = none)."),
        articles_lang: strOrArr.optional().describe(`Only articles in these languages (${LANG_HINT}).`),
        articles_sort_by: z.enum(["date", "cosSim", "sourceImportance"]).default("cosSim").describe("cosSim = most central to the event."),
        body_chars: z.number().int().min(-1).default(300),
        result_lang: z.string().optional(),
        response_format: responseFormat,
      },
      annotations: READ_ONLY,
    },
    wrap(async (a: any) => {
      const client = getClient();
      const info = await client.request("/api/v1/event/getEvent", {
        eventUri: a.event_uri,
        resultType: "info",
        includeEventSummary: true,
        includeEventConcepts: true,
        includeEventCategories: true,
        includeEventLocation: true,
        includeConceptLabel: true,
        eventLang: a.result_lang,
        conceptLang: a.result_lang,
      });
      let arts: any;
      if (a.articles_count > 0) {
        arts = await client.request("/api/v1/event/getEvent", {
          eventUri: a.event_uri,
          resultType: "articles",
          articlesCount: a.articles_count,
          articlesSortBy: a.articles_sort_by,
          articlesLang: toArr(a.articles_lang),
          articleBodyLen: -1,
          includeArticleBody: a.body_chars !== 0,
        });
      }
      if (a.response_format === "raw") return { info, articles: arts };
      const ev = info?.[a.event_uri];
      if (!ev?.info) throw new NewsApiError(`Event ${a.event_uri} not found${ev?.error ? `: ${ev.error}` : ""}`);
      const out: any = { event: compactEvent(ev.info, { summaryChars: -1, lang: a.result_lang }) };
      if (arts) {
        const list = arts?.[a.event_uri]?.articles ?? {};
        out.totalArticles = list.totalResults;
        out.articles = (list.results ?? []).map((x: any) => compactArticle(x, { bodyChars: a.body_chars, lang: a.result_lang }));
      }
      return out;
    }),
  );

  // ---------------------------------------------------------------- lookups
  server.registerTool(
    "newsapi_suggest",
    {
      title: "Resolve names to URIs",
      description:
        "Autocomplete names to the URIs that the search tools need: concepts (people, organisations, places, topics → Wikipedia URI), " +
        "sources (news outlets → domain URI), source_groups, categories, locations, authors. Call this BEFORE filtering by entity, source or category.",
      inputSchema: {
        kind: z.enum(["concepts", "sources", "source_groups", "categories", "locations", "authors"]),
        prefix: z.string().min(1).describe("Name or beginning of the name, e.g. 'Siemens', 'heise', 'Artificial Int'"),
        lang: z.string().default("eng").describe(`Language of the prefix/labels (${LANG_HINT}). For concepts/locations.`),
        count: z.number().int().min(1).max(50).default(10),
      },
      annotations: READ_ONLY,
    },
    wrap(async (a: any) => {
      const client = getClient();
      const p = { prefix: a.prefix, count: a.count, page: 1 };
      let res: any;
      switch (a.kind) {
        case "concepts":
          res = await client.request("/api/v1/suggestConceptsFast", { ...p, lang: a.lang, conceptLang: a.lang });
          break;
        case "sources":
          res = await client.request("/api/v1/suggestSourcesFast", { ...p, dataType: ["news", "pr", "blog"] });
          break;
        case "source_groups":
          res = await client.request("/api/v1/suggestSourceGroups", p);
          break;
        case "categories":
          res = await client.request("/api/v1/suggestCategoriesFast", p);
          break;
        case "locations":
          res = await client.request("/api/v1/suggestLocationsFast", { prefix: a.prefix, count: a.count, lang: a.lang, source: ["place", "country"] });
          break;
        case "authors":
          res = await client.request("/api/v1/suggestAuthorsFast", p);
          break;
      }
      const list = Array.isArray(res) ? res : Array.isArray(res?.results) ? res.results : [];
      return { kind: a.kind, results: list.map((s: any) => compactSuggestion(a.kind, s, a.lang)) };
    }),
  );

  server.registerTool(
    "newsapi_usage",
    {
      title: "API token usage",
      description: "Show how many newsapi.ai API tokens are available and used on the current plan.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    wrap(async () => getClient().request("/api/v1/usage", {})),
  );

  server.registerTool(
    "newsapi_raw_request",
    {
      title: "Raw newsapi.ai request",
      description:
        "Escape hatch: POST arbitrary parameters to any newsapi.ai endpoint under /api/v1/ (e.g. /api/v1/article/getArticles with resultType=conceptTrends, " +
        "/api/v1/minuteStreamArticles, /api/v1/trends). The API key is added automatically. Prefer the dedicated tools when they fit.",
      inputSchema: {
        path: z.string().regex(/^\/api\/v1\/[A-Za-z0-9/_-]+$/).describe("Endpoint path, e.g. /api/v1/article/getArticles"),
        params: z.record(z.string(), z.any()).default({}).describe("JSON body parameters (without apiKey)."),
      },
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    wrap(async (a: any) => {
      const { apiKey: _ignored, ...params } = a.params ?? {};
      return getClient().request(a.path, params);
    }),
  );

  return server;
}

