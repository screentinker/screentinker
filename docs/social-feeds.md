# Social walls

Show posts from **Instagram, Facebook, YouTube, X, Bluesky and Mastodon** on your screens, with
moderation in front of them.

- A **social feed** (menu → **Social feeds**) collects posts from up to 10 sources: an account, a
  hashtag, a Facebook Page, a YouTube channel or playlist, or a search.
- A **Social wall** widget shows one feed on a screen, in one of three layouts:
  - **one post at a time**: large, a good fit for a portrait lobby screen
  - **grid**: a page of cards, rotating
  - **ticker**: one scrolling line, made for a strip zone
- **Screens never talk to a social network.** This server fetches the posts and keeps its own
  copies of the images. A screen only ever loads the wall, its posts and those images from your
  ScreenTinker server, which is also why a wall keeps showing its last posts when the network is down
  (see [How often posts update](#how-often-posts-update) for what a screen shows after a restart
  offline).

## Contents

- [Setting up a wall](#setting-up-a-wall)
- [Moderation](#moderation)
- [Connections: which networks need what](#connections-which-networks-need-what)
  - [Instagram](#instagram)
  - [Facebook Page](#facebook-page)
  - [YouTube](#youtube)
  - [X (Twitter)](#x-twitter)
  - [Bluesky](#bluesky)
  - [Mastodon](#mastodon)
- [Not supported, and why](#not-supported-and-why)
- [How often posts update](#how-often-posts-update)
- [Privacy and the networks' terms](#privacy-and-the-networks-terms)
- [Troubleshooting](#troubleshooting)

## Setting up a wall

1. **Bluesky and Mastodon need no setup.** For Instagram, Facebook, YouTube or X, an organization
   owner or admin first adds a connection in **Settings → Social connections**; see below.
2. **Social feeds → New feed.** Name it and add sources. Choose whether new posts appear
   automatically or wait for approval.
3. **Widgets → New widget → Social wall.** Choose the feed and a layout, then put the widget in a
   playlist or a layout zone like any other widget.

## Moderation

Each feed has its own settings.

| Setting | What it does |
|---|---|
| **New posts: show automatically** | A fetched post appears on the wall straight away. |
| **New posts: approve each post first** | New posts wait under **Social feeds → Posts → Waiting** until someone approves them. An approved post whose text or pictures are later edited by its author goes back to **Waiting**. |
| **Hide posts containing these words** | A post whose text, author name or handle matches one of these words is hidden as soon as it arrives, or as soon as it is edited to match. Saving the list checks every stored post of the feed again. Matching is whole-word and ignores case, so `roast` also matches `#roast` and `@roast` but not `roasted`. It also ignores accents, invisible characters (zero-width spaces, soft hyphens) and look-alike letters (fullwidth `ｒｏａｓｔ`, math bold `𝐫𝐨𝐚𝐬𝐭`). A matched post's text and images are not kept. |
| **Only show posts with a picture** | Hides text-only posts. |
| **Hide posts older than** | In days. 0 shows posts of any age. |
| **Posts to show** | The wall shows at most this many of the newest posts, up to 50. |

- **A hidden post stays hidden.** Fetching again never brings it back; only **Show again** does.
- **Hiding is a review step, not deletion.** A hidden post's text is kept for 30 days so you can
  see what you hid and undo it. After that only a marker remains, so it is still recognised if
  fetched again.
- **Deleted posts are removed.** When the author deletes a post (or makes it private), it
  disappears from the wall on the next fetch. A hidden post that is deleted keeps only its marker,
  so it stays hidden if it ever comes back.
- **A source that suddenly answers with no posts at all** is only believed after three fetches in a
  row, so a network's brief glitch does not empty the wall.
- **Searches that only look back a while** (an Instagram hashtag: 24 hours; an X search: 7 days)
  keep showing older posts after the search stops returning them; only a post inside that window
  that disappears counts as deleted.

Mastodon posts with a content warning or marked sensitive are never shown, and nor are non-public
ones. Reposts, retweets and replies are left out everywhere.

## Connections: which networks need what

Connections belong to the **organization** and only its workspaces can use them. Tokens are stored
encrypted, are never shown again after saving, and never reach a screen. Leave the field empty when
editing to keep the stored token.

**Test** reads one post through the connection, which proves the token works.

### Instagram

Instagram only lets you read **professional accounts** (business or creator), through **your own
Meta app**. Meta offers two APIs; choose the one that matches how you created the token.

**Instagram Login** reads your account's own posts.
1. Create an app at developers.facebook.com and add the **Instagram** product, choosing "API setup
   with Instagram login".
2. Add your Instagram account and generate a token with the `instagram_business_basic` permission.
3. Exchange it for a **long-lived token** (60 days) and paste that into the connection.

ScreenTinker refreshes Instagram Login tokens automatically once they are a day old. Settings shows
when the current one expires. A token left unused for more than 60 days can no longer be refreshed;
paste a new one.

**Facebook Login** reads your account's own posts **and hashtags**.
1. Connect the Instagram account to a Facebook Page.
2. Use a token with `instagram_basic` and `pages_show_list`. Hashtags also need
   `instagram_manage_insights` and Meta's **Instagram Public Content Access** feature, which needs
   App Review.
3. Enter the **Instagram account id**: a number, found in the Graph API Explorer as
   `/me/accounts?fields=instagram_business_account`.

Use a **system user** token from Business Settings so it does not expire.

Instagram's own limit: an account can search at most **30 different hashtags in 7 days**.

### Facebook Page

Reads a Page's own posts.

1. In your Meta app, get a **Page access token** for the Page with `pages_read_engagement` and
   `pages_show_list`. A system user token does not expire.
2. Enter the **Page id**, a number shown in the Page's About section, plus the token.

A source can name another Page id that the same token can read. Leave it empty to read the
connection's own Page.

### YouTube

Shows the latest videos of a channel or playlist as thumbnails with their titles. A wall never plays
a YouTube video, because that needs YouTube's own player. To play one, add it as a playlist item.

1. In Google Cloud, enable **YouTube Data API v3** and create an **API key**. Restrict the key to
   that API.
2. Sources use either a **channel**, by its `@handle` or its `UC…` id, or a **playlist** id
   (`PL…`).

The default quota is 10,000 units a day, and each fetch of a source costs 2. A feed checking every
10 minutes uses under 300 a day per source.

### X (Twitter)

- **X charges for API access.** At the time of writing, reading timelines and searching needs a
  paid plan (Basic or above); check X's current plans and their monthly read caps.
- Paste your own app's **bearer token**. Sources are an **account** (`@name`) or a **search**
  (`#yourevent`). Search covers the last 7 days.
- **Each fetch uses your plan's reads.** A feed reading 20 posts every 10 minutes reads up to about
  86,000 posts a month per source, so lower the posts per source or check less often if your plan
  is small.

### Bluesky

No key needed. Sources are an **account** (`name.bsky.social`, or a custom domain handle) or a
**search** (`#yourevent`), read through Bluesky's public AppView.

⚠️ Bluesky has at times required sign-in for search on its public service. If a search source shows
an error, use account sources instead.

### Mastodon

No key needed. Enter the **server** (for example `mastodon.social`) and an **account** or a
**hashtag**.

⚠️ Some servers turn off public hashtag timelines for visitors. The source then shows an error;
follow the account on a server that allows it instead.

## Not supported, and why

These are deliberately left out rather than built half-way.

| Network | Why |
|---|---|
| **LinkedIn** | Reading a company Page's posts needs LinkedIn's Community Management API, which is only granted to approved partners after a vetting process, and its terms restrict displaying content outside LinkedIn. |
| **TikTok** | The Display API needs app review per use case and only covers the authorised user's own videos. A wall would show thumbnails it cannot play. |
| **Threads** | Not built yet. Meta's Threads API is new and its access rules are still changing. |
| **Facebook groups and personal profiles** | Meta's API does not offer them. |

## How often posts update

- **Fetching:** the server fetches each feed every **10 minutes** by default; set it per feed,
  from 5 minutes to 24 hours. **Fetch now** on the feed card fetches straight away.
- **Errors:** a failing source shows its error on the feed card. If every source fails, the feed
  backs off (up to 2 hours between tries) and keeps showing what it had.
- **On screens:** a wall asks for its posts as soon as it loads, then every **2 minutes**, and only
  changes what it shows when the server answers. A hidden post leaves screens on their next check.
- **Offline:** a wall that is already showing keeps its posts while the network is down. A screen
  that restarts the wall while offline shows its title and no posts until the server answers: the
  wall page screens keep for offline use deliberately carries no posts, because a post hidden since
  would otherwise come back from that copy.
- **Large fleets:** every screen showing a wall gets the same answer, built at most every few
  seconds, so hundreds of screens on one wall are fine.
- **Multiple servers:** each feed is fetched by one node at a time.

## Privacy and the networks' terms

- **What is stored:** a post's text, the author's display name, handle and avatar, a link to the
  post, its time, and copies of its images. Nothing else.
- **Images:** they're only kept if the bytes really are an image (JPEG, PNG, GIF, WebP or AVIF),
  and only from public internet addresses. Images no post uses any more are deleted.
- **Attribution:** every post is shown with its author and its network.
- **Deletions:** deleted posts are removed (see [Moderation](#moderation)). Each network's
  developer terms apply to how you display its content; showing your own account's posts is the
  common case and the simplest.

## Troubleshooting

| What you see | Why |
|---|---|
| A connection's Test says `190` or `Invalid OAuth access token` (Instagram, Facebook) | The token expired or was revoked. Paste a new long-lived one. |
| "Hashtags need an Instagram connection that uses Facebook Login" | Instagram Login tokens cannot search hashtags. Add a Facebook Login connection. |
| YouTube `API key not valid` / `quotaExceeded` | Check the key's API restriction, or the project's daily quota. |
| X `429` or `403` | The plan's limit is reached, or the plan does not include that endpoint. |
| The wall says "No posts to show yet" | Nothing approved yet (check **Posts → Waiting**), or the filters (pictures only, max age) hide everything. |
| The wall says "Choose a social feed" | The widget has no feed, or it was made before social walls existed. Edit it and choose one. |
