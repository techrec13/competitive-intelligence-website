function parseRSS(xml, sourceName) {
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const b = m[1];

    const get = (tag) => {
      const cd = b.match(new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
      if (cd) return cd[1].trim();
      const pt = b.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return pt ? pt[1].trim() : '';
    };

    const decodeEntities = (s) =>
      s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

    const title = decodeEntities(get('title'));

    // <link> in RSS 2.0 is a plain text node; also handle Atom href attribute
    let link = get('link');
    if (!link) {
      const href = b.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (href) link = href[1];
    }

    const rawDesc = get('description');
    const description = decodeEntities(
      rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    ).substring(0, 400);

    const pubDate = get('pubDate') || get('dc:date') || get('published') || '';

    if (title && link) {
      let publishedAt = new Date().toISOString();
      try { if (pubDate) publishedAt = new Date(pubDate).toISOString(); } catch (_) {}
      items.push({ title, url: link, description, source: { name: sourceName }, publishedAt });
    }
  }
  return items;
}

async function fetchNewsAPI() {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return [];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const from = yesterday.toISOString().split('T')[0];
  const query = 'pharmaceutical OR biotech OR "drug approval" OR "clinical trial" OR "pharma layoffs" OR "pharma merger" OR "FDA approval" OR "life sciences"';
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=100&from=${from}&apiKey=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.articles) return [];
  return data.articles.filter(a => a.title && a.url && a.title !== '[Removed]');
}

async function fetchRSS(feedUrl, sourceName) {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TakedaPharmaIntel/1.0)' },
  });
  if (!res.ok) throw new Error(`RSS feed responded ${res.status}`);
  const xml = await res.text();
  return parseRSS(xml, sourceName);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800');

  const [newsApiResult, rssResult] = await Promise.allSettled([
    fetchNewsAPI(),
    fetchRSS('https://www.biopharmadive.com/feeds/news/', 'BioPharma Dive'),
  ]);

  const articles = [
    ...(newsApiResult.status === 'fulfilled' ? newsApiResult.value : []),
    ...(rssResult.status === 'fulfilled' ? rssResult.value : []),
  ];

  if (!articles.length) {
    const errors = [newsApiResult, rssResult]
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message)
      .join('; ');
    return res.status(500).json({ error: errors || 'All feed sources failed' });
  }

  // Deduplicate by URL, sort newest first
  const seen = new Set();
  const deduped = articles
    .filter(a => { if (!a.url || seen.has(a.url)) return false; seen.add(a.url); return true; })
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  res.status(200).json({ articles: deduped, totalResults: deduped.length, status: 'ok' });
}
