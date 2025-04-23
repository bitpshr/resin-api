import { sql } from "../common";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const article =
    await sql`SELECT * FROM articles WHERE id = ${id} ORDER BY date_published DESC`;

  if (article.length === 0) {
    return new Response("Article not found", { status: 400 });
  }

  return new Response(JSON.stringify(article[0]), { status: 200 });
}
