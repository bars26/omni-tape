// Cloudflare Worker: starts the omni-tape `collect` workflow every 15 minutes.
// GitHub's own cron for this repo fires only every few hours, so this is the clock.
//
// Secret: GH_TOKEN — fine-grained token, repository bars26/omni-tape only,
// permission "Actions: Read and write". Nothing else.

const REPO = "bars26/omni-tape";
const WORKFLOW = "collect.yml";

async function dispatch(env) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "omni-tape-trigger",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "master" }),
  });
  // 204 = queued. Anything else shows up in the Worker's logs.
  if (res.status !== 204) throw new Error(`dispatch failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  // No public HTTP surface: nobody can trigger runs from a URL.
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};
