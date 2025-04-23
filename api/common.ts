import { z } from "zod";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import Parser from "rss-parser";
import { neon } from "@neondatabase/serverless";

// Extend the Parser.Item type to include "content:encoded"
declare module "rss-parser" {
  export interface Item {
    "content:encoded"?: string;
  }
}

const rssParser = new Parser();
const openai = new OpenAI({ apiKey: process.env.LLM_API_KEY });
export const sql = neon(process.env.STORAGE_DATABASE_URL ?? "");

interface RSSSource {
  feedUrl: string;
  name: string;
  id: string;
  isDisabled?: boolean;
}

interface RSSResult {
  source: RSSSource;
  item: Parser.Item;
}

export interface Article {
  id: string;
  url: string;
  title: string;
  publication: string;
  authors?: string[];
  date_published?: string;
  content: string;
  headline: string;
  source: string;
  created_at: string;
  updated_at: string;
  summary: string;
}

export const CONFIG = {
  // LLM model to use for article analysis
  llmModel: "o3-mini",
  // Number of recent articles to fetch from each source
  rssItemLimit: 50,
  // RSS feed sources
  sources: [
    {
      feedUrl: "https://moxie.foxnews.com/google-publisher/politics.xml",
      name: "Fox News",
      id: "fox",
    },
    {
      feedUrl: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
      name: "New York Times",
      id: "nyt",
      isDisabled: true,
    },
  ],
};

export const ArticleAnalysis = z.object({
  headline: z.string(),
  source: z.string(),
  summary: z.string(),
});

/**
 * Log a message with an app-specific format
 *
 * @param messages - Messages to log
 */
export function log(...messages: any[]) {
  return console.log(`🌴 `, ...messages);
}

/**
 * Parse all RSS feeds from the configuration
 *
 * @returns - Recent items from the feed
 */
export async function parseFeeds() {
  log("Parsing RSS feeds");

  const feedRequests = CONFIG.sources.map(async (source) => {
    if (source.isDisabled) return [];

    const feed = await rssParser.parseURL(source.feedUrl);

    return feed.items
      .slice(0, CONFIG.rssItemLimit)
      .map((item) => ({ source, item })) as RSSResult[];
  });

  return (await Promise.all(feedRequests)).flat();
}

/**
 * Filter RSS results to exclude existing items
 *
 * @param flattenedItems
 * @returns
 */
export async function filterExistingItems(items: RSSResult[]) {
  log("Filtering existing articles");

  const urls = items.map(({ item }) => item.link);
  const articles = await sql`SELECT * FROM articles WHERE url = ANY(${urls})`;
  const existingUrls = articles.map((row) => row.url);

  return items.filter(({ item }) => !existingUrls.includes(item.link));
}

/**
 * Scrape text content from a given URL
 *
 * @param url - URL to scrape content from
 * @returns The scraped content
 */
export async function scrapeContent(url: string) {
  const response = await fetch(url);
  const html = await response.text();
  const doc = new JSDOM(html).window.document;
  const fetchedContent = new Readability(doc).parse()?.textContent;
  return fetchedContent ?? "";
}

/**
 * Analyze a news article with an LLM
 *
 * @param title - The title of the article
 * @param content - The content of the article
 * @returns Article analysis with headline, summary, and source
 */
export async function analyzeContent(title = "", content = "") {
  const completion = await openai.beta.chat.completions.parse({
    model: "gpt-4o-mini",
    response_format: zodResponseFormat(ArticleAnalysis, "analysis"),
    messages: [{ role: "user", content: createPrompt(title, content) }],
  });

  return completion.choices[0].message.parsed;
}

/**
 * Process a list of RSS feeds. Conditionally scrape text content,
 * and process factual and primary source information with an LLM.
 *
 * @param feeds - List of parsed RSS feeds
 * @returns Articles ready for DB insertion
 */
export async function processFeeds(feeds: RSSResult[]) {
  const total = feeds.length;

  log("Scraping and analyzing articles: ", total);

  const articles = await Promise.all(
    feeds.map(async ({ source, item }, i) => {
      item.content = item["content:encoded"];

      if (item.link && !item.content) {
        const scrapedContent = await scrapeContent(item.link);
        item.content = scrapedContent;
      }

      const analysis = await analyzeContent(item.title, item.content);

      log("\t✅", `Article ${i + 1} analyzed`, item);

      return {
        url: item.link,
        title: item.title,
        publication: source.name,
        authors: item.creator,
        content: item.content || item.summary || item.contentSnippet,
        source: analysis?.source,
        headline: analysis?.headline,
        summary: analysis?.summary,
      };
    }),
  );

  return articles.filter(
    (article) =>
      article.content && article.headline && article.summary && article.source,
  );
}

/**
 * Insert rows into the articles table
 *
 * @param rows - Rows to insert
 * @returns Promise that resolves when the insert is complete
 */
export async function insertArticles(rows: Record<string, any>[]) {
  log("Saving articles in db", rows);

  if (rows.length === 0) return;

  const columns = [
    "url",
    "title",
    "publication",
    "authors",
    "date_published",
    "content",
    "source",
    "headline",
    "summary",
  ];

  const values = rows.flatMap((row) => columns.map((col) => row[col]));
  const placeholders = rows
    .map((_, rowIndex) => {
      const start = rowIndex * columns.length + 1;
      return `(${Array.from({ length: columns.length }, (_, i) => `$${start + i}`).join(", ")})`;
    })
    .join(", ");

  const query = `INSERT INTO articles (${columns.join(", ")}) VALUES ${placeholders}`;
  await sql(query, values);
}

/**
 * Generate an OpenAI prompt for analyzing a news article
 *
 * @param title - The title of the article
 * @param content - The content of the article
 * @returns AI prompt for analyzing the article
 */
export function createPrompt(title: string, content: string) {
  return `
    Analyze the following news article. First, decide if the article presents
    a factual event update...or theory, opinion, or speculation that an event may happen.
    If the article presents a factual event update that occurred, create a summary of the fact in
    100 characters or less, and a slightly longer summary of the fact in 300 characters or less.
    Use neutral and objective tone. Remove any expressive, emotive, or sensational language
    (such as hyperbolic adjectives or dramatic verbs) while preserving the core factual meaning
    and key details.

    Also, identify the best source to attribute for the factual information.
    The source should ideally be a primary source, but it should be bibliographically-correct.
    You can also attribute the information to a secondary source or inferred source if it is the most accurate.
    For example, if an article reports a new executive order, you can attribute the White House or donald trump. If
    an article reports a hurricane, you can infer the source of the National Weather Service. The
    main point is to identify the bibliographically-correct source of the factual information in human-readable form.
    This source will be searchable, so focus on normalized, uniform source that avoid slight differences.

    # Output Format

    The output should be a JSON object with the following fields:

    - headline: A string of 100 characters or less summarizing the factual update.
    - summary: A string of 500 characters or less summarizing the factual update.
    - source: A string indicating the source of the factual information.

    # Notes

    - Do not consider reporting on events that may happen in the future.
    - Do not use any subjective or expressive language in summaries; just objective language like a robot would use.
    - Commentary, opinions, speculative statements or events should not be considered factual updates.
    - The source will be searched; focus on normalization
    - If the article lacks factual updates, return empty strings for both summary and source fields.
    \n
    \n
    Article: ${title}\n${content}
  `;
}
