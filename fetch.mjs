// =========================================================
// 記事の収集スクリプト（GitHub Actions が30分ごとに実行）
// sources.json の設定に従って RSS を集め、articles.json を作ります。
// 外部ライブラリは使っていません（Node.js 20以上で動作）。
// =========================================================
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const UA = 'Mozilla/5.0 (compatible; my-discover-feed/1.0; +https://github.com/mkdr45/my-discover)';

// ---------- 文字列の処理 ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .trim();
}
const stripTags = (s = '') => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}
function tagAttr(block, name, attr) {
  const m = block.match(new RegExp(`<${name}\\s[^>]*?${attr}\\s*=\\s*["']([^"']+)["'][^>]*>`, 'i'));
  return m ? decode(m[1]) : '';
}

// ---------- RSS / RDF / Atom を読む ----------
export function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const title = stripTags(tagText(b, 'title'));
    let link = tagText(b, 'link');
    if (!link || link.startsWith('<')) {
      link = tagAttr(b, 'link[^>]*rel=["\']alternate["\']', 'href') || tagAttr(b, 'link', 'href');
    }
    const date = tagText(b, 'pubDate') || tagText(b, 'dc:date') || tagText(b, 'published') || tagText(b, 'updated');
    const content = tagText(b, 'content:encoded') + ' ' + tagText(b, 'description') + ' ' + tagText(b, 'content');
    let image = tagText(b, 'hatena:imageurl')
      || tagAttr(b, 'media:thumbnail', 'url')
      || tagAttr(b, 'media:content', 'url')
      || tagAttr(b, 'enclosure[^>]*type=["\']image', 'url');
    if (!image) {
      const img = content.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (img && !/favicon|append\.gif|entry\/image/.test(img[1])) image = img[1];
    }
    const source = tagText(b, 'source') || tagText(b, 'News:Source');
    // Bingニュースの転送リンクから、元の記事URLを取り出す
    if (/bing\.com\/news\/apiclick/i.test(link)) {
      try { link = new URL(link.replace(/&amp;/g, '&')).searchParams.get('url') || link; } catch { /* そのまま使う */ }
    }
    const bookmarks = Number(tagText(b, 'hatena:bookmarkcount')) || 0;
    return { title, link: link.trim(), date, image, source, bookmarks };
  }).filter((i) => i.title && /^https?:\/\//.test(i.link));
}

// ---------- 通信 ----------
async function get(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getFeed(url, label) {
  try {
    let xml;
    try { xml = await get(url); } catch (e) { await new Promise((r) => setTimeout(r, 2000)); xml = await get(url); } // 失敗したら1回だけやり直す
    const items = parseFeed(xml);
    console.log(`  ✓ ${label}: ${items.length}件`);
    return items;
  } catch (e) {
    console.log(`  ✗ ${label}: 取得失敗 (${e.message})`);
    return [];
  }
}

// 画像がない記事は、記事ページの og:image を探す
async function findOgImage(url) {
  try {
    const html = (await get(url, 8000)).slice(0, 200000);
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return m ? decode(m[1]) : '';
  } catch { return ''; }
}

async function mapLimit(list, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < list.length) { const k = i++; await fn(list[k]); }
  });
  await Promise.all(workers);
}

// ---------- 整形 ----------
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const normTitle = (t) => t.normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/[-|｜–—:：].{0,30}$/, '');
const idOf = (u) => crypto.createHash('sha1').update(u).digest('hex').slice(0, 12);

export function toArticle(item, extra) {
  let title = item.title;
  let source = item.source;
  // Googleニュースは「タイトル - 媒体名」の形なので分ける
  if (extra.via === 'google' && source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
  if (extra.source) source = extra.source;
  if (!source) source = hostOf(item.link);
  const time = Date.parse(item.date);
  return {
    id: idOf(item.link),
    title,
    url: item.link,
    source,
    published: Number.isFinite(time) ? new Date(time).toISOString() : null,
    image: item.image || '',
    bookmarks: item.bookmarks || 0,
    topics: extra.topics || [],
    via: extra.via,
    feed: extra.feed
  };
}

// ---------- メイン ----------
export async function main() {
  const cfg = JSON.parse(await fs.readFile(new URL('./sources.json', import.meta.url), 'utf8'));
  const exclude = (cfg.exclude || []).map((w) => w.toLowerCase());
  const minTime = Date.now() - (cfg.maxAgeDays || 3) * 86400000;
  const all = [];

  // アプリでフォローした話題（topics.json）を、収集する話題に加える
  let userTopics = [];
  try { userTopics = JSON.parse(await fs.readFile(new URL('./topics.json', import.meta.url), 'utf8')).topics || []; } catch { /* まだ無い */ }
  for (const raw of userTopics.slice(0, 40)) {
    const name = String(raw).trim().slice(0, 40);
    if (name && !cfg.topics.some((t) => t.name === name)) cfg.topics.push({ name, keywords: [name] });
  }
  // フォローした話題そのものが除外キーワードに当たる場合は、その除外を外す
  const followedWords = cfg.topics.flatMap((t) => [t.name, ...(t.keywords || [])]).map((w) => w.toLowerCase());
  for (let i = exclude.length - 1; i >= 0; i--) if (followedWords.includes(exclude[i])) exclude.splice(i, 1);

  const topicDays = cfg.topicMaxAgeDays || 7;
  const topicMinTime = Date.now() - topicDays * 86400000;
  const dateBegin = new Date(topicMinTime).toISOString().slice(0, 10);
  const enc = encodeURIComponent;

  console.log(`■ 話題ごとの収集（${cfg.topics.length}件）`);
  await mapLimit(cfg.topics, 4, async (t) => {
    const kw = t.keywords?.length ? t.keywords : [t.name];
    const add = (items, via, feed) => all.push(...items.map((i) => toArticle(i, { topics: [t.name], via, feed })));
    // はてなブックマーク：キーワードごとの新着（最大3語）＋ 期間内の人気
    for (const k of kw.slice(0, 3)) {
      add(await getFeed(`https://b.hatena.ne.jp/q/${enc(k)}?mode=rss&sort=recent&users=1`, `はてブ新着「${k}」`), 'hatena', 'はてブ検索');
    }
    add(await getFeed(`https://b.hatena.ne.jp/q/${enc(kw[0])}?mode=rss&sort=popular&date_begin=${dateBegin}`, `はてブ人気「${kw[0]}」`), 'hatena', 'はてブ検索');
    // Googleニュース：全キーワードをまとめて検索
    const q = kw.map((k) => (k.includes(' ') ? `"${k}"` : k)).join(' OR ') + ` when:${topicDays}d`;
    add(await getFeed(`https://news.google.com/rss/search?q=${enc(q)}&hl=ja&gl=JP&ceid=JP:ja`, `Googleニュース「${t.name}」`), 'google', 'Googleニュース');
    // Bingニュース：元記事のURLが分かるのでサムネイルも探せる
    add(await getFeed(`https://www.bing.com/news/search?q=${enc(kw[0])}&format=rss&mkt=ja-JP&setlang=ja`, `Bingニュース「${kw[0]}」`), 'bing', 'Bingニュース');
  });

  console.log('■ YouTubeチャンネルの収集');
  for (const ch of cfg.youtube || []) {
    const items = await getFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ch.channelId)}`, `YouTube「${ch.name}」`);
    all.push(...items.slice(0, ch.max || 6).map((i) => toArticle(i, { topics: ch.topic ? [ch.topic] : [], via: 'youtube', feed: 'YouTube', source: ch.name })));
  }

  console.log('■ 発見用フィードの収集');
  for (const f of cfg.discover) {
    const items = await getFeed(f.url, f.name);
    all.push(...items.map((i) => toArticle(i, { topics: [], via: 'rss', feed: f.name })));
  }

  // 話題のキーワードを含む記事には、その話題を付ける
  for (const a of all) {
    const text = a.title.toLowerCase();
    for (const t of cfg.topics) {
      if (!a.topics.includes(t.name) && [t.name, ...(t.keywords || [])].some((k) => text.includes(k.toLowerCase()))) a.topics.push(t.name);
    }
  }

  // 除外キーワード・古い記事・重複を取り除く
  const seenUrl = new Set(), seenTitle = new Set();
  let list = all.filter((a) => {
    const text = (a.title + ' ' + a.source).toLowerCase();
    if (exclude.some((w) => text.includes(w))) return false;
    const limit = a.via === 'youtube' ? Date.now() - (cfg.youtubeMaxAgeDays || 7) * 86400000 // 動画は7日分
      : a.topics.length ? topicMinTime : minTime;                                           // 話題の記事は7日分、発見用は3日分
    if (a.published && Date.parse(a.published) < limit) return false;
    const nt = normTitle(a.title);
    if (seenUrl.has(a.url) || seenTitle.has(nt)) return false;
    seenUrl.add(a.url); seenTitle.add(nt);
    return true;
  });

  // 話題ごと・発見用の件数を制限（新しい順）
  const byDate = (a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0);
  list.sort(byDate);
  const count = {};
  let discoverCount = 0;
  list = list.filter((a) => {
    if (a.via === 'youtube') return true; // YouTubeはチャンネルごとの件数で別に制限済み
    if (a.topics.length) {
      const key = a.topics[0];
      count[key] = (count[key] || 0) + 1;
      return count[key] <= (cfg.perTopicMax || 40);
    }
    return ++discoverCount <= (cfg.discoverMax || 80);
  });

  // 画像がない記事の og:image を探す（Googleニュースの転送リンクは除く）
  const noImage = list.filter((a) => !a.image && a.via !== 'google').slice(0, 120);
  console.log(`■ サムネイル探索: ${noImage.length}件`);
  await mapLimit(noImage, 8, async (a) => { a.image = await findOgImage(a.url); });

  const out = {
    updatedAt: new Date().toISOString(),
    topics: cfg.topics.map((t) => ({ name: t.name, keywords: t.keywords || [] })),
    articles: list
  };
  await fs.writeFile(new URL('./articles.json', import.meta.url), JSON.stringify(out));
  console.log(`■ 完了: ${list.length}件を articles.json に保存`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
