import { sql } from "./common";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limit = url.searchParams.get("limit") ?? 20;
  const offset = url.searchParams.get("offset") ?? 0;

  const articles =
    await sql`SELECT * FROM articles ORDER BY date_published DESC LIMIT ${limit} OFFSET ${offset}`;

  return new Response(JSON.stringify(articles), { status: 200 });
}
