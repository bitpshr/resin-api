import {
  filterExistingItems,
  insertArticles,
  parseFeeds,
  processFeeds,
} from "../common";

export async function GET(): Promise<Response> {
  if (process.env.ENABLE_ARTICLE_UPDATE !== "true") {
    return new Response(
      JSON.stringify({ message: "Update endpoint is disabled" }),
      { status: 400 },
    );
  }

  const parsedFeeds = await parseFeeds();
  const newFeeds = await filterExistingItems(parsedFeeds);
  const articles = await processFeeds(newFeeds);

  await insertArticles(articles);

  return new Response(
    JSON.stringify({ message: "Articles fetched successfully" }),
    { status: 200 },
  );
}
