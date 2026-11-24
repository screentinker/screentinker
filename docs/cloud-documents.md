# Google & Microsoft documents

ScreenTinker can show documents straight from Google Workspace and Microsoft 365, in two ways.

| You want to show | Use | Needs |
|---|---|---|
| A Google Slides, Docs or Sheets file | **Cloud document** widget | The file published, or shared with "anyone with the link" |
| A PowerPoint, Word or Excel file from OneDrive or SharePoint | **Cloud document** widget | The file's **Embed** link |
| A SharePoint or OneDrive **folder** of images and videos, kept up to date | **SharePoint & OneDrive folder sync** | Your organization's own Microsoft Entra app |
| A Google Drive **folder** of images and videos, kept up to date | **Google Drive folder sync** | Your organization's own Google Cloud service account |

---

## Cloud document widget

**Content → Google & Microsoft documents**: paste the link and press **Add document**. You can also
add it under **Widgets → Cloud document**, where you can set the seconds per slide, how often the
screen reloads it, zoom and background.

The screen shows the provider's own viewer, so the document looks exactly as it does in Google or
Office, and your edits appear on screens without re-uploading anything.

### Google Slides, Docs and Sheets

1. In the file, choose **File → Share → Publish to web** and **Publish**. Or share it with
   **Anyone with the link → Viewer**.
2. Copy the link from the address bar, or the published link, or the whole embed code. Any of
   them works.

The link is rebuilt as Google's embed address, so a deck starts on its own and loops:

- **Slides** advance every *Seconds per slide* (10 by default) and keep themselves up to date.
- **Docs and Sheets** are reloaded every 5 minutes by default. Set *Reload every* to change that,
  or 0 for never. A sheet keeps the tab it was shared on.

Only `docs.google.com` links are accepted.

### PowerPoint, Word and Excel (OneDrive / SharePoint)

1. Open the file in Office for the web, then choose **File → Share → Embed**.
2. Paste the embed code, or the link inside it.

Accepted links:

- `onedrive.live.com/embed?...` (OneDrive personal)
- `<tenant>.sharepoint.com/.../_layouts/15/Doc.aspx?...`, which is shown as `embedview`, and
  `.../embed.aspx`
- `view.officeapps.live.com/op/embed.aspx?src=...` (the Office viewer for a file at a public
  address)

A SharePoint embed only shows on screens if the file can be viewed without signing in (an
"anyone" link). If your tenant does not allow those, use a folder sync instead and export the
slides as images or a video.

### Which screens can show it

All players show a cloud document:

- Android, Fire TV, Raspberry Pi, Windows and Samsung Tizen load the provider's page directly.
- The web player, also used by BrightSign and LG webOS, frames it with the provider's own origin.
  Google's viewer needs that.

The screen needs to reach `docs.google.com` (or Microsoft's hosts) on the internet. A cloud
document does not play offline.

The dashboard's **Preview** can't show these documents: it is isolated from the dashboard for
your security. Use **open in a new tab** next to the link in the editor to check the document.

---

## SharePoint & OneDrive folder sync

Point ScreenTinker at a folder and it keeps the folder's images, videos and audio in your content
library:

| In the folder | In ScreenTinker |
|---|---|
| A new file | Added to the library, like an upload |
| A changed file | Replaced in place. Playlists keep it, and screens fetch the new version. |
| A removed file | Taken out of the folder's playlist. Deleted from the library, unless something else uses it (another playlist, a schedule, a video wall, a screen's default content or a direct assignment), in which case it stays. |
| PowerPoint, Word, Excel, PDF | Not synced, and counted as skipped. Use a Cloud document widget. |

Each folder can keep a **playlist** of its files in file-name order (path order, with subfolders). The playlist is published
after each sync that changes it, unless your workspace requires approval: then it waits for
review like any other change. Items you add to that playlist yourself are kept, after the
folder's files.

Syncs run every 15 minutes by default (5 to 1440). Press **Sync now** at any time. Files count
against your plan's storage, and a file larger than the server's upload limit is skipped.

Up to 500 media files per folder are synced (Office files do not count towards that). While a
folder holds more than that, or is too large to list in full, the sync adds and updates the files
it saw but removes nothing, and its summary says so. Split a larger folder into several.

**Subfolders.** A folder added since 3.2.6 also syncs its subfolders, up to 5 levels deep and 200
subfolders (turn off **Include subfolders** when adding it to sync only the folder itself). The
playlist then plays in path order (`2026-08-28/…` before `2026-08-29/…`), and the 500-file limit
counts the whole tree. If any subfolder cannot be listed in full, the rest still syncs but nothing
is removed that time. A folder added before 3.2.6 syncs only its own files until you press **Include
subfolders** on it; its summary says how many subfolders it is skipping. The same applies to Google
Drive folders.

A sync runs as the person who added the folder. If they leave the workspace (or can only view
it), or the workspace is deleted, the folder is paused and shows the reason. Remove it and have an
organization admin add it again.

### 1. Register an app in your tenant (once per organization)

You need a Microsoft Entra admin.

1. **Entra admin center → App registrations → New registration.** Name it "ScreenTinker" and
   choose **Single tenant**. No redirect URI is needed.
2. **API permissions → Add → Microsoft Graph → Application permissions**, then one of:
   - **Sites.Selected** (recommended). The app can read only the sites you grant it. Grant each
     site with Graph:

     ```
     POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
     {"roles":["read"],"grantedToIdentities":[{"application":{"id":"<client id>","displayName":"ScreenTinker"}}]}
     ```

   - **Files.Read.All**. The app can read every file in the tenant. This is simpler, but much
     broader.

   Then **Grant admin consent**.
3. **Certificates & secrets → New client secret.** Copy the secret's **Value**, not its ID.
4. In ScreenTinker, an organization owner or admin opens **Settings → Microsoft 365** and enters:
   - the **Directory (tenant) ID**
   - the **Application (client) ID**
   - the **secret**

   Then press **Save**. The connection is tested straight away.

The secret is encrypted on the server, and no screen or API ever shows it again. Leave the field
empty on a later save to keep it. Secrets expire, so set a reminder for the date Entra shows.

### 2. Add a folder (an organization owner or admin)

**Content → SharePoint & OneDrive folders… → Add a folder.** In SharePoint or OneDrive, select
the folder, choose **Share → Copy link**, and paste the link.

Only an organization owner or admin can add a folder, because the app can read more than one
workspace should see (with Files.Read.All, anyone's OneDrive). Once a folder is added, any
workspace editor can press **Sync now**, change how often it syncs, pause it, or stop syncing it.

**Head office's media is safe.** A synced file that a corporate playlist plays is only updated if
the folder's creator may change corporate media (an organization owner or admin). Otherwise that file
is listed as an error in the sync summary and left as it is; the rest of the folder still syncs.

**Stop syncing** keeps everything already in the library and the playlist. It only stops future
syncs.

### Troubleshooting

| Message | What to do |
|---|---|
| *Microsoft refused the app credentials: AADSTS7000215* | The secret is wrong or has expired. Create a new one. |
| *AADSTS700016* | The client ID is not in that tenant. |
| *The app is not allowed to read this* | Grant the app the site (Sites.Selected) or Files.Read.All, and give admin consent. |
| *Microsoft could not find that item* | The link is wrong, or the app cannot see that site. |
| *not enough storage left on the plan* | The plan's storage is full. Those files are skipped until there is room. |

---

## Google Drive folder sync

Works exactly like the SharePoint & OneDrive sync above (new, changed and removed files, the
folder's playlist, the 500-file limit, storage, who may add a folder), for a Google Drive folder.
Google Docs, Sheets and Slides, PDFs and other files are not synced and are counted as skipped:
show a Google file with a Cloud document widget.

ScreenTinker reads Drive as your organization's **own service account**, and sees only the folders
you share with it. No Google sign-in, no domain-wide delegation, and nothing that needs Google's app
review.

### 1. Create a service account (once per organization)

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project.
2. **APIs & Services → Library**: enable the **Google Drive API**.
3. **IAM & Admin → Service accounts → Create service account.** It needs no roles in the project.
4. Open the account, **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
5. In ScreenTinker, **Settings → Google Drive**: paste the whole file's contents and **Save**. The
   key is stored encrypted and is never shown again. **Test connection** checks that Google accepts it.

The card then shows the account's address, like `screens@your-project.iam.gserviceaccount.com`.

### 2. Share a folder and add it (an organization owner or admin)

1. In Google Drive, share the folder with the service account's address as a **Viewer**. For a
   shared drive, add the address as a member of the drive instead.
2. **Content → SharePoint, OneDrive & Google Drive folders… → Add a folder**, choose **Google
   Drive**, and paste the folder's link (`https://drive.google.com/drive/folders/…`).

### Troubleshooting

| Message | What to do |
|---|---|
| *Google refused the service account: Invalid JWT Signature* | The key was deleted or replaced in Google Cloud. Create a new JSON key and paste it. |
| *Google could not find that folder* | Share the folder with the service account's address, or check the link. |
| *The service account is not allowed to read this* | Share the folder with it, and enable the Google Drive API in its project. |
| *That link is to a file, not a folder* | Copy the folder's link, not a file's. |
