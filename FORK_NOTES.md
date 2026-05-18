# tpc-org/Prebid.js — fork notes

This file documents fork-specific conventions and is intentionally not in
upstream prebid/Prebid.js. **Do not include this file in any upstream PR.**

## What this fork contains beyond upstream

Two categories of fork-only content:

1. **The TPC bid adapter** (`modules/tpcBidAdapter.js` + spec + `.md`) — a
   custom Prebid bid adapter for routing demand through TPC's own server-side
   inventory. Not intended for upstream contribution; lives only in this fork.

2. **CI dispatch workflow** (`.github/workflows/dispatch-deployment.yml`) —
   triggers per-client bundle rebuilds in `tpc-org/prebid-deployments` on
   push to master. TPC-specific infrastructure; not for upstream.

`FORK_NOTES.md`, `.gitattributes`, and `scripts/check-upstream-pr-scope.sh`
are also fork-only — they exist to enforce the rules below.

## Custom adapters

TPC-specific adapters live alongside upstream adapters in `modules/`, but
follow a strict naming convention to mark them as fork-only.

**Naming:** TPC-only adapters are prefixed with `tpc` —
`modules/tpcBidAdapter.js`. The prefix makes divergence from upstream
visually obvious in directory listings and greppable in scripts.

**Do not include `modules/tpc*` in any upstream PR.**

If a fix to an upstream adapter (e.g. `modules/adformBidAdapter.js`) is
suitable for upstream contribution, follow the "Upstream PR workflow"
below.

## Upstream PR workflow

When contributing a fix or improvement to prebid/Prebid.js upstream:

```bash
# 1. Branch from upstream/master, NOT from fork master
git fetch upstream
git checkout -b upstream-pr/<short-description> upstream/master

# 2. Cherry-pick or hand-apply ONLY the file(s) you want to contribute
git checkout master -- <path/to/file>
git add <path/to/file>
git commit -m "Adapter: clear description per upstream conventions"

# 3. Verify the branch contains nothing fork-only
./scripts/check-upstream-pr-scope.sh

# 4. Push and open PR from tpc-org/Prebid.js@<branch> to prebid/Prebid.js@master
git push origin upstream-pr/<short-description>
```

**Never PR from fork master directly to upstream master.** That's how
fork-only files leak into upstream PRs (which the script in step 3
will catch).

## How this fork relates to the rest of the TPC stack

The Prebid.js fork is one of four repos that make up the TPC ad serving
platform. Push to this fork triggers a chain that rebuilds publisher
bundles automatically:
tpc-org/Prebid.js (this fork)
│ push to master
▼
.github/workflows/dispatch-deployment.yml
│ repository_dispatch ('deploy-base')
▼
tpc-org/prebid-deployments
│ deploy-base.yml rebuilds the base bundle on S3
│ repository_dispatch ('base-bundle-updated')
▼
deploy-clients.yml rebuilds each per-client bundle
│
▼
s3://static-s3-tpcsrv-com/clients/<client>/prebid.js
Companion repos:
- **tpc-org/prebid-server** — fork of `prebid/prebid-server` (PBS), source for
  the Go binary
- **tpc-org/pbs-settings** — PBS runtime config (pbs.yaml, Stored Imps,
  Stored Requests, deploy.sh)
- **tpc-org/prebid-deployments** — per-client bundle pipeline (CI/CD,
  client configs, modules.json)
- **tpc-org/docs** — architecture overview and publisher integration docs

The cross-repo dispatch from this fork uses a fine-grained PAT
(`DEPLOYMENTS_DISPATCH_TOKEN`) scoped to `tpc-org/prebid-deployments` with
Contents:Read+Write. Read-only does NOT work — repository_dispatch
requires write. PAT rotation is required every 90 days; calendar reminder
recommended.

## Module conventions

When adding a new TPC-specific Prebid module:

1. Filename: `modules/tpc<Name>BidAdapter.js` (or other module type)
2. Test file: `test/spec/modules/tpc<Name>BidAdapter_spec.js`
3. Documentation: `modules/tpc<Name>BidAdapter.md`
4. Register in `modules.json` of `tpc-org/prebid-deployments/config/`
   (otherwise the module isn't included in the bundle)
5. Update the relevant client config in `tpc-org/prebid-deployments/clients/`
   if the module needs configuration

The build system uses Prebid's `gulp build --modules=<json>` mechanism, so
the module file just needs to exist at the right path with the right
filename — no further registration in this repo.

## Build and test

Standard Prebid.js commands work as upstream:

```bash
npm install
npm test                            # full test suite
gulp test --browsers=chrome         # browser-based
gulp build --modules=path/to.json   # build with specific module set
```

For TPC-specific module dev:
- The TPC adapter spec lives at `test/spec/modules/tpcBidAdapter_spec.js`.
  Run a single spec with:
    gulp test --file "test/spec/modules/tpcBidAdapter_spec.js" --nolint
  Run the full suite with:
    gulp test
