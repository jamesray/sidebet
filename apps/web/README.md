# Sidebet marketing site

The public site for Sidebet: what it is, how to use it, and the roadmap. Plain HTML, CSS and
JavaScript with no build step and no dependencies, so it can be served from anywhere that hosts
static files.

```
index.html           the page
assets/site.css      styles (tokens mirror apps/cli/src/style/palette.ts)
assets/site.js       hero animation, tabs, copy buttons, reveal, interest form
assets/favicon.svg   the chip
assets/og.png        social preview (1200x630), generated from assets/og.svg
_headers             Cloudflare Pages headers (ignored elsewhere)
```

## Preview locally

Any static server works. From the repository root:

```bash
npx serve apps/web
```

or `python3 -m http.server --directory apps/web 8080`. Open the printed URL.

## Deploy

`.github/workflows/deploy-web.yml` deploys this directory to Cloudflare Pages with Wrangler:
pushes to `main` that touch `apps/web/**` go to production, pull requests get a preview URL
posted as a comment. It needs two repository secrets and, optionally, two variables:

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | secret | Cloudflare dashboard → Workers & Pages → Overview, right-hand column |
| `CLOUDFLARE_API_TOKEN` | secret | A token with **Account → Cloudflare Pages → Edit** (the "Edit Cloudflare Workers" template also works) |
| `CF_PAGES_PROJECT` | variable | Pages project name; default `sidebet` (the project is created on first deploy if missing) |
| `SITE_URL` | variable | Public origin, e.g. `https://sidebet.dev`; used to rewrite canonical and Open Graph URLs at deploy time |

Set them with the GitHub CLI (`gh secret set CLOUDFLARE_API_TOKEN`, `gh variable set SITE_URL`)
or under Settings → Secrets and variables → Actions.

To use a custom domain: Cloudflare dashboard → Workers & Pages → the project → Custom domains.
If the domain's DNS is already on Cloudflare the record is added for you.

GitHub Pages works too (Settings → Pages → Source: GitHub Actions, then a workflow that uploads
`apps/web` with `actions/upload-pages-artifact`); all asset paths are relative, so the site
runs from a sub-path.

## Interest form

The "Keep me posted" form posts an `email` field to the URL in `data-endpoint` on
`#interest-form` in `index.html`. Point it at Buttondown, Formspree, a Cloudflare Worker, or
anything that accepts a form POST. With the attribute empty, the form is hidden and GitHub
"watch releases" links are shown instead, so the page never pretends to collect something it
cannot.

## Editing

Copy follows the product truth in the docs: if a claim is not true in the repository, it does
not go on the site. Terminal output on the page is illustrative and labelled as such. The hero
and the tabs under "How it works" mirror the real CLI output formats in `apps/cli/src`.

This directory is excluded from the repository's Biome config (`biome.json`); keep the JavaScript and CSS
in the same style anyway (two-space indent, single quotes, no semicolons, 100-column lines).
