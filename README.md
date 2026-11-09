# Support relay

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) that turns the problem
reports Giode apps send with [`giode/support`](../../docs/support.md) into GitHub issues.
Users need no GitHub account, and the GitHub token stays in the Worker instead of
shipping in every copy of the app. One relay serves all your apps. Cloudflare's free plan
covers it: 100,000 requests a day.

## What it does

- `POST /report`: checks the report, rate-limits each network (5 an hour and 20 a day by
  default), and opens an issue in the app's repository, labelled `user report`, plus
  `crash` when a crash is attached. Mentions (`@name`) and issue links (`#12`) in the
  user's text are neutralised, so a report can't ping anyone.
- The reporter's email, if they left one, is **not** put in the public issue. It's kept in
  the Worker's KV store for a year, and you read it with
  `GET /contact?repo=owner/repo&issue=12` and `Authorization: Bearer <ADMIN_TOKEN>`.

## Deploy

You need Node.js and a free Cloudflare account.

1. Create a GitHub token at <https://github.com/settings/personal-access-tokens/new>:
   fine-grained, with access to the apps' repositories only, and the **Issues: Read and
   write** permission.
2. In this folder:

   ```sh
   npx wrangler login
   npx wrangler kv namespace create SUPPORT   # put the id it prints in wrangler.toml
   npx wrangler secret put GITHUB_TOKEN       # the token from step 1
   npx wrangler secret put ADMIN_TOKEN        # any long random string, for /contact
   npx wrangler secret put KEY                # optional: the key your apps send
   ```

3. In `wrangler.toml`, list each app in `APPS` under the name it passes as
   `support.Options.App`, with its repository.
4. `npx wrangler deploy`. It prints the address, such as
   `https://giode-support.<you>.workers.dev`. The apps' `ReportURL` is that address plus
   `/report`.

Check it with:

```sh
curl -X POST https://giode-support.<you>.workers.dev/report \
  -H 'Content-Type: application/json' \
  -d '{"app":"sonora","title":"Test report","description":"Sent with curl."}'
```

`npm test` runs its tests (Node 20 or later, nothing to install).

## Settings

| Name | Kind | Meaning |
| --- | --- | --- |
| `APPS` | var | JSON object: app name to `owner/repo`. Reports from other apps are refused. |
| `GITHUB_TOKEN` | secret | Opens the issues. |
| `ADMIN_TOKEN` | secret | Reads reporters' emails at `/contact`. |
| `KEY` | secret, optional | When set, reports must carry it (`support.Options.Key`). It ships inside the apps, so it stops casual spam, not someone who takes an app apart. |
| `LABELS` | var | Comma-separated labels for every report. Default `user report`. |
| `PER_HOUR`, `PER_DAY` | var | Reports one network may send. Default 5 and 20. |
| `SUPPORT` | KV binding | Rate-limit counters and emails. |
