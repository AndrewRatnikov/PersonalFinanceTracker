---
paths:
  - "package.json"
  - "package-lock.json"
---

# Dependency and lockfile changes

- Regenerate the lockfile with `npx -y npm@11 ... --package-lock-only`, run from inside a throwaway copy of the repo (not `--prefix`; on macOS `/tmp` -> `/private/tmp` writes `../../private/tmp/...` keys). npm 10.9 crashes with `Cannot read properties of null (reading 'edgesOut')`.
- Symptom: `npm install --package-lock-only @vitejs/plugin-react@6.x ...` fails with ERESOLVE. Cause: plugin-react's optional peer `@rolldown/plugin-babel` has an optional peer `@babel/plugin-transform-runtime@8`, which wants `@babel/core ^8`, while the tree has 7. Nothing in that chain gets installed. What to do: install the other packages normally, then `--force` only the plugin-react bump, and diff the lockfile to confirm it changed just plugin-react. Don't use `--legacy-peer-deps`: it prunes peer-installed eslint packages and the next install re-resolves them to newer versions.
- `.npmrc` sets `min-release-age=7`; pick versions at least 7 days old.
- After a lockfile change, check no key contains `private/tmp` or `../`, and that `scripts/criticalAdvisories.test.ts` and `scripts/dependencyHygiene.test.ts` pass.
