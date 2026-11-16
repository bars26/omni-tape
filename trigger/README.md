# omni-tape-trigger

A Cloudflare Worker whose only job is a cron: every 15 minutes it asks GitHub to run the
`collect` workflow (`workflow_dispatch`). GitHub's built-in schedule for this repo fires
only every few hours.

```bash
cd trigger
npx wrangler@4 login
npx wrangler@4 deploy
npx wrangler@4 secret put GH_TOKEN   # paste the fine-grained token when asked
```

The token: GitHub → Settings → Developer settings → Fine-grained tokens, repository
access *Only select repositories → bars26/omni-tape*, permission *Actions: Read and write*.
