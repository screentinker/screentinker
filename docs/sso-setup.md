# Single sign-on — setup guide

How to turn on SSO, for the two people who need it: the **operator** running the server, and an
**organization admin** bringing their company's own identity provider.

Everything below is OpenID Connect. One flow — Authorization Code with PKCE, completed server-side —
so the browser never talks to the provider directly and there is no SDK to load.

---

## Contents

- [Which kind of SSO do you want?](#which-kind-of-sso-do-you-want)
- [Operator: Google](#operator-google)
- [Operator: Microsoft / Entra ID](#operator-microsoft--entra-id)
- [Operator: any other provider](#operator-any-other-provider)
- [Organization admin: bring your own provider](#organization-admin-bring-your-own-provider)
- [Organization admin: SAML 2.0](#organization-admin-saml-20)
- [Requiring SSO for your organization](#requiring-sso-for-your-organization)
- [Linking an existing account](#linking-an-existing-account)
- [What users see at sign-in](#what-users-see-at-sign-in)
- [Troubleshooting](#troubleshooting)

---

## Which kind of SSO do you want?

There are two, and they are configured in completely different places.

| | Instance-wide | Per-organization |
|---|---|---|
| Configured by | the **operator**, in environment variables | an **org owner/admin**, in Settings → Single sign-on |
| Restart needed | yes | no |
| Who sees the button | everyone, on the login page | only people at that organization's **verified** domains |
| Typical use | "Sign in with Google" for anyone | a customer wiring up their own Entra/Okta tenant |

An organization's provider **overrides** the instance's for its own verified domains, and never
appears publicly — the login page reveals it only after someone enters an address at one of those
domains, so a guessed domain cannot confirm who your customers are.

---

## Operator: Google

Google is the simplest: one fixed issuer, and it reports whether an address is verified.

1. **console.cloud.google.com** → create a project (a dedicated one — if you reuse an auto-created
   AI Studio project and later tidy those up, you take sign-in down with it).
2. **Google Auth Platform** (formerly "OAuth consent screen"):
   - **App name** — users see this on the consent screen
   - **Audience**: External
   - Support and contact email
   - Scopes: nothing to add. `openid`, `email` and `profile` are implicit and non-sensitive, so
     **no Google verification review is required**.
3. **Clients → Create client → Web application**
   - **Authorized redirect URI**, exactly:
     ```
     https://your-domain.example/api/auth/oidc/google/callback
     ```
   - Leave *Authorized JavaScript origins* empty — the exchange is server-side.
4. **Audience → Test users**: while publishing status is *Testing*, only listed accounts can sign
   in. Add yourself, or **Publish app** (safe here, given the scopes).
5. Set the environment:
   ```bash
   GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…      # a Web application client needs one
   ```

> Google matches redirect URIs byte for byte. No trailing slash, `https` not `http`.

---

## Operator: Microsoft / Entra ID

Microsoft needs one decision up front: **whose accounts are signing in?** That decides both the app
registration and, crucially, the tenant ID you configure.

### The rule that catches everyone

`MICROSOFT_TENANT_ID` is **not** "where the app is registered". It is the directory that
**authenticates the user**, because it is what the ID token's `iss` will say. Those are different
things whenever the two differ — most obviously for personal accounts.

| Who signs in | Supported account types | `MICROSOFT_TENANT_ID` |
|---|---|---|
| Personal Microsoft accounts (outlook.com, hotmail, …) | **Personal Microsoft account users** | `9188040d-6c67-4c5b-b112-36a304b66dad` (Microsoft's consumer directory) |
| Your own staff | **Single tenant** | your **Directory (tenant) ID** |

⚠️ **`common`, `organizations` and `consumers` are refused, deliberately.** Two reasons that point
the same way. They cannot work: Microsoft's multi-tenant metadata advertises the issuer as the
literal template `https://login.microsoftonline.com/{tenantid}/v2.0`, so `iss` can never match. And
the obvious workaround is dangerous — accepting that template means accepting tokens from *every*
Azure tenant, which is [nOAuth](https://www.descope.com/blog/post/noauth): any tenant admin can set
an arbitrary, unverified `email` on one of their own users and be issued a session as that address.
Safe multi-tenant support needs per-tenant pinning (allowlist `tid`, key accounts on `oid`+`tid`
rather than email) and is not implemented. Setting one of these disables Microsoft sign-in with a
warning at boot rather than failing quietly.

### Steps

1. **portal.azure.com** → Entra ID → App registrations → **New registration**
   - **Name** — users see this on the consent screen
   - **Supported account types** — per the table above
   - **Redirect URI**: platform **Web**, value
     ```
     https://your-domain.example/api/auth/oidc/microsoft/callback
     ```
     ⚠️ **Web, not SPA.** A SPA registration is rejected at the token endpoint, because this exchange
     runs server-side and sends no browser `Origin`.
2. **Certificates & secrets → New client secret** → copy the **Value** (shown once, not the ID).
   A Web registration is a confidential client; the exchange fails without it.
3. **Token configuration → Add optional claim → ID → `email`.** Without it the token can arrive with
   no address at all, which fails as `no_email`.
4. Set the environment:
   ```bash
   MICROSOFT_CLIENT_ID=…
   MICROSOFT_TENANT_ID=…        # see the table — NOT necessarily the directory the app lives in
   MICROSOFT_CLIENT_SECRET=…
   ```

> **Entra never sends `email_verified`.** ScreenTinker treats a tenant-pinned Microsoft provider as
> vouching for the address rather than demanding a claim Microsoft does not emit — safe because the
> operator chose that provider and it is pinned to one directory. An explicit `email_verified: false`
> is still refused.

---

## Operator: any other provider

Okta, Auth0, Keycloak, Authentik, Zitadel — anything with a discovery document:

```bash
OIDC_PROVIDERS=okta,authentik              # comma-separated slugs
OIDC_OKTA_ISSUER=https://example.okta.com  # the base URL whose /.well-known/openid-configuration describes it
OIDC_OKTA_CLIENT_ID=…
OIDC_OKTA_CLIENT_SECRET=…                  # optional — PKCE means a public client works
OIDC_OKTA_NAME=Okta                        # optional button label
OIDC_OKTA_SCOPES=openid email profile      # optional
OIDC_OKTA_ASSUME_EMAIL_VERIFIED=true       # only if it verifies addresses but omits the claim
```

Redirect URI is `https://your-domain.example/api/auth/oidc/<slug>/callback`.

Set **`APP_URL`** so the redirect URI is pinned to one origin. It must match your provider's
registration exactly, and deriving it from the request `Host` would both break behind a second
hostname and take its value from the caller.

---

## Organization admin: bring your own provider

No environment variables, no restart, no operator involvement.

1. **Settings → Single sign-on → Add provider**
   - **Issuer** — for Entra, `https://login.microsoftonline.com/<your-tenant-guid>/v2.0`
   - **Client ID** and **Client secret** from your own app registration
   - **Email domains** you intend to claim
2. Copy the **redirect URI** shown in Settings and register it with your provider. It carries a
   generated slug, so two customers can neither collide on nor guess each other's.
3. **Verify each domain.** Publish the TXT record shown:
   ```
   _screentinker-verify.<your-domain>   TXT   st-verify=<token>
   ```
   Then press Verify. An unverified claim lapses after 8 hours and releases the domain.

Your provider may only assert addresses at domains you have **proved** you control. A domain can be
claimed by one organization only; a second claim is refused.

> Proof by CNAME is not accepted — it would need a wildcard zone we do not operate, and would turn a
> subdomain takeover into an apex takeover.

Once a domain is verified, your provider is trusted to assert addresses in it even if it omits
`email_verified` (as Entra does) — the DNS proof stands in for the claim. A provider that has
verified nothing assumes nothing.

---

## Organization admin: SAML 2.0

For identity providers you'd rather connect over SAML: Okta, Entra ID (Enterprise applications),
ADFS, Google Workspace, OneLogin, PingFederate, JumpCloud and so on.

1. **Settings → Single sign-on → Add provider**, and choose **SAML 2.0**.
2. Paste your IdP's **metadata XML**. It fills in the IdP entity ID, the sign-in URL and the
   signing certificate. You can also enter those three by hand.
3. Enter the **email domains** you intend to claim, and save.
4. Settings now shows three values. Give them to your IdP:
   - **SP entity ID (audience)**, `https://<server>/api/auth/saml/<slug>/metadata`
   - **ACS URL** (HTTP-POST), `https://<server>/api/auth/saml/<slug>/acs`
   - **SP metadata URL**: the same address as the entity ID. Some IdPs can import from it.
5. In the IdP, send the user's email address as an attribute named `email` (`mail` and the usual
   Microsoft claim URIs work too), or use an email-format NameID. The NameID must stay the same
   for each person: it is what we match an account on. Use a **persistent**, email-address or
   unspecified-but-stable NameID format. A **transient** NameID (a new random value at every
   sign-in) is refused with an error that says so, because it would sign someone in once and lock
   them out the next time.
6. **Verify each domain** with a DNS TXT record, exactly as for OIDC above.

What we require of every sign-in:

- **The assertion itself is signed** with the certificate you gave us. A signed response that
  wraps an unsigned assertion is refused.
- **It answers a sign-in we started, in the same browser.** IdP-initiated sign-in (clicking the
  tile in an IdP's app portal) is refused. Start from the ScreenTinker sign-in page instead: type
  your email and choose **Continue with single sign-on**. Starting a sign-in sets a short-lived
  cookie (`st_saml_tx`, 10 minutes) that ties it to the browser, so a response can't be posted
  from someone else's browser to sign them into a different account. That cookie has to survive
  the IdP's cross-site POST back to us, which browsers allow only over **HTTPS**, so SAML sign-in
  needs the server on HTTPS. Starting a second sign-in in another tab replaces the first one.
- **It comes from your IdP.** The assertion's Issuer must be the IdP entity ID you configured
  (a trailing `/` is ignored on both sides).
- **It's addressed to us and still current.** The audience must match, and there are 3 minutes of
  clock skew allowed.
- **It hasn't been used before.** Replaying a captured response fails.
- **The email is in one of your verified domains.**

Only the HTTP-Redirect binding is supported for the sign-in request. Every common IdP offers it.

To **rotate a certificate**, paste the old and the new certificate into the certificate field, one
after the other (up to four), and save. Remove the old one once the IdP has switched. **Test** on
the provider shows the certificate's expiry date.

Everything after the assertion is checked follows the same rules as OIDC: domain confinement,
**Require SSO**, account adoption, and joining your organization on first sign-in.

---

## Requiring SSO for your organization

**Settings → Single sign-on → Require single sign-on.** Then, for anyone at your verified domains:

- passwords are refused
- other providers are refused, **including the instance's own Google/Microsoft** — otherwise
  "requires SSO" would just be renaming the bypass

⚠️ **Enabling this clears the passwords** of members at your verified domains. That is not reversible
without a reset.

Turning it **off** requires a platform administrator to approve the request, so one compromised org
admin cannot quietly reopen password login. Plan for that turnaround before you enable it.

---

## Linking an existing account

Signing in with a provider never takes over an account that already has a password — otherwise
anyone who could get a provider to assert your address would inherit your account. Link it
deliberately instead:

**Settings → Sign-in method → Link `<provider>`**

- An account has **one** credential. Linking **deletes** the password; afterwards you sign in with
  the provider only.
- **Unlink** asks for a new password and applies both changes together, so the account is never left
  without a way in.
- The provider account must use the **same email address** as the ScreenTinker account.
- Only the providers this server offers can be linked — an organization's own provider cannot attach
  itself to an account.

> ⚠️ If you link the **platform administrator** account, that provider becomes the only way in.
> Should it break, recovery is `scripts/reset-admin.js` on the server, not the login page.

---

## What users see at sign-in

The login page asks for an email address first and shows the password box only after you continue.
That is what lets it check whether the address belongs to an organization with its own provider
*before* offering a credential — so someone whose company requires SSO is shown that, rather than a
password box that was going to be refused. Correcting the address takes you back a step.

The instance's own providers are shown throughout.

---

## Troubleshooting

Errors appear as a message on the login page (or Settings, when linking). The exact code is in the
URL as `sso_error=…`, and the server logs a matching `[oidc]` line with the underlying reason.

| Code | What it means | Usual cause |
|---|---|---|
| `unknown_provider` | No such provider on this server | Slug typo; or `MICROSOFT_TENANT_ID` is multi-tenant, so Microsoft was disabled at boot — check the `[sso]` warning |
| `provider_unavailable` | Discovery or the token exchange failed | Wrong issuer URL; no outbound network; **missing client secret** on a confidential client |
| `provider_refused` | The provider itself said no | Consent declined; conditional-access policy; account not on the Google test-user list |
| `expired` | The round trip took too long | Left the tab open; started over in another tab |
| `bad_state` / `no_code` | The response did not match the request | Started in one browser and returned in another; a redirect URI that does not match the registration |
| `verification_failed` | The ID token did not verify | **Wrong tenant** — the log prints the `iss` actually seen; clock skew; wrong client ID |
| `no_email` | The token carried no address | Entra: add the **`email`** optional claim under Token configuration |
| `email_unverified` | The provider would not vouch for the address | The provider sent `email_verified: false`; or it omits the claim and is not eligible to assume (an org provider with no verified domain) |
| `account_exists_local` | That address already has a password | Sign in with the password, then **Settings → Sign-in method → Link** |
| `account_exists_other_provider` | The account belongs to a different provider | Unlink first, or sign in with the provider that owns it |
| `subject_mismatch` | Same address, different provider subject | The address was reassigned. Deliberate: it stops a recycled mailbox inheriting an account |
| `domain_not_allowed` | The provider asserted a domain it has not verified | Verify the domain, or check which address the provider is actually sending |
| `sso_required` | The organization requires its own provider | Use the organization's button, not the password box or an instance provider |
| `registration_disabled` | New accounts are turned off | The address has no account and self-registration is disabled |
| `link_email_mismatch` | The provider account has a different address | Sign in to the provider with the same address as the account |
| `link_already_used` | That provider identity is linked elsewhere | Unlink it from the other account first |

### Checks worth doing first

```bash
# What the server thinks is configured (public endpoint)
curl -s https://your-domain.example/api/auth/config

# Does the start URL carry the right issuer and redirect?
curl -s -o /dev/null -D - https://your-domain.example/api/auth/oidc/google/start | grep -i location

# Boot warnings, and every login outcome
docker logs <container> 2>&1 | grep -E '\[sso\]|\[oidc\]'
```

`/api/auth/config` reporting `microsoftEnabled: false` while `MICROSOFT_CLIENT_ID` is set almost
always means the tenant ID was rejected — look for the `[sso]` line at boot.
