# News feeds

Show headlines from a news site, a blog or a status page on your screens.

- Paste a **feed address** (RSS 2.0, RSS 1.0, Atom or JSON Feed) or just the **site**
  (`www.example.com`). ScreenTinker finds the site's feeds and lists them by title.
- A site with **no feed** can still be used: ScreenTinker builds headlines from the page itself.
- Two looks: a **scrolling ticker** (made for a strip zone) or **headlines with pictures** (one story at
  a time, for a whole screen or a large zone).
- **Screens never talk to the news site.** Your ScreenTinker server reads the feed, and a screen
  loads the headlines and pictures from your server. One read serves every screen and every workspace
  that shows the same feed.

## Contents

- [Setting it up](#setting-it-up)
- [How "Find feeds" works](#how-find-feeds-works)
- [Sites without a feed](#sites-without-a-feed)
- [How often headlines update](#how-often-headlines-update)
- [Privacy and what the server sends](#privacy-and-what-the-server-sends)
- [For administrators](#for-administrators)
- [Troubleshooting](#troubleshooting)

## Setting it up

**Simple view:** on the home page, choose **Show news headlines**.

1. Paste the site or feed address and press **Find feeds**. Pick one of the feeds found. If the site
   has none, choose **Build headlines from this page**; you see the headlines it found first.
2. Choose how it looks: **Headlines with pictures** or **Scrolling ticker**.
3. Choose the screens, and whether the headlines take a turn with what each screen shows or replace it.

**Advanced view:** **Widgets → New widget → News Ticker**. The same **Find feeds** box is at the top of
the form. Other settings:

| Setting | What it does |
|---|---|
| Look | Scrolling ticker, or headlines with pictures |
| Scroll speed (seconds) | Ticker only. Seconds for the text to travel one screen width |
| Seconds per headline | Headlines look only. How long each story stays on screen |
| Show pictures | Headlines look only |
| Max items | How many of the newest items to show (up to 50) |
| Font size, colour, background | As on other widgets |

You can still type a feed address and save without pressing Find feeds.

The **Content Designer**'s ticker element reads its feed the same way. Designer pages saved before 3.0
used a third-party converter (`api.rss2json.com`); they now read through your server without being
edited.

## How "Find feeds" works

The server reads the address once:

1. If the address is a feed, that feed is the answer.
2. If it is a web page, the server lists the feeds the page advertises
   (`<link rel="alternate" type="application/rss+xml">`, Atom and JSON Feed too).
3. If the page advertises none, the server tries the usual places: `/feed`, `/rss`, `/rss.xml`,
   `/feed.xml`, `/atom.xml`, `/index.xml`, `/feed.json`. It stops at the first feed it finds.
4. If there is still no feed, it offers to build one from the page (below).

## Sites without a feed

The server builds headlines from the page in this order, using the first that finds at least three
stories:

1. **schema.org data** the site publishes for search engines (`NewsArticle`, `Article`,
   `BlogPosting`, `ItemList`).
2. A **Google News sitemap** (`<news:news>` entries), from the `Sitemap:` lines in `robots.txt` or
   `/sitemap.xml`.
3. **Headline links** on the page: `<article>` blocks, and links in headings that point to the same
   site.

For the first three stories without a picture, the server reads the story's page only for its
`og:image` preview picture.

Built headlines are **headlines, links and pictures only**. The server never copies an article's
text. The only summary shown is the short description a site writes for search results.

This mode honours **`robots.txt`**. If the site asks automated readers not to read the page, no
headlines are built and the editor says why. The server identifies itself as
`ScreenTinker-FeedReader/1.0 (ScreenTinker feed reader; +https://screentinker.com)`; a site can
address it in `robots.txt` as `User-agent: ScreenTinker-FeedReader`.

## How often headlines update

- The server keeps each feed for **5 minutes**. Screens ask every 5 minutes; however many screens
  show a feed, the source is read at most once per 5 minutes.
- If the source is down or answers with an error, screens keep the **last good headlines for up to
  a day**. After a failed read the server waits a minute before trying again.
- A screen that restarts while offline shows the headlines its page was saved with, when the server
  had them at the time.
- The server reads any one site at most **30 times a minute**, whatever the number of feeds, screens
  and editors.

## Privacy and what the server sends

- A screen contacts only your ScreenTinker server. The widget page's Content-Security-Policy allows
  data and pictures from your server only.
- The server sends the news site an ordinary request for the feed or page, with the user agent above.
  It sends nothing about your organization, screens or viewers.
- **Data & privacy → Outbound connections** lists these reads under **News feeds**, with each host.
  The data handling page lists **News feeds** as an integration that is on while any news widget names
  a feed.

## For administrators

- **Private addresses.** On a hosted instance, feeds on private networks (`10.x`, `192.168.x`,
  `localhost` …) are refused. A self-hosted instance can allow them with `OUTBOUND_ALLOW_HOSTS` or
  `OUTBOUND_ALLOW_PRIVATE` ([outbound-requests.md](outbound-requests.md)). Cloud metadata addresses
  are always refused. Every redirect is checked again.
- **Limits.** A feed may be up to 5 MB, a page up to 4 MB, a picture up to 3 MB. A read times out
  after 12 seconds and follows up to 5 redirects. Pictures are kept in memory (48 MB in total, 6 hours
  each) and only if the bytes are an image (JPEG, PNG, GIF, WebP or AVIF).
- **Endpoints.**

| Endpoint | Who | What |
|---|---|---|
| `POST /api/news-feeds/discover` `{ url }` | Workspace editors (not view-only) | What an address offers. 20 a minute per address |
| `POST /api/news-feeds/preview` `{ url, mode }` | Workspace editors | A feed's items. 60 a minute per address |
| `GET /api/news-feeds/items?w=&s=` | Public | A saved news widget's items, by widget id. The server reads the feed address from the widget, so the page never contains it |
| `GET /api/news-feeds/items?m=&u=&s=` | Public | A feed's items, by address (the editor's preview, offline bundles, designer HTML) |
| `GET /api/news-feeds/image?u=&s=` | Public | An item's picture |

The two public endpoints need the server's signature (`s`), which the server adds when it renders a
widget. They serve only feeds and pictures that some widget was rendered with, so a leaked address
cannot make the server read anything else. They are limited per caller address (600 and 3000 a
minute).

A feed address may not carry a user name or password (`https://user:pass@...`): saving such a news
widget is refused. A key in the query string is allowed, and stays on the server: a saved widget's
public page reads its items by widget id.

- **Data sources.** The **RSS / Atom feed** data source (for slide variables) is separate and
  unchanged. It already read feeds on the server.

## Troubleshooting

| Message | Meaning |
|---|---|
| That address is a web page, not a feed | Press **Find feeds** instead of saving the address as a feed |
| This site asks automated readers not to read that page | The site's `robots.txt` disallows it. Use one of its feeds if it has any |
| No headlines could be found on that page | The page has no article list the server can recognise. Try the site's news or blog section page |
| That address is on a private network | See **Private addresses** above |
| Too many reads from that site just now | The 30-a-minute limit for one site. Wait a minute |
| "Feed unavailable" on a screen | The server has never read this feed successfully. Open the widget and press **Find feeds** to see the error |
