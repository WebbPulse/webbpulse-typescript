# Changesets

Versioning for this repository. Every change that alters a published package
needs a changeset, which is a small markdown file recording which packages moved
and by how much.

```bash
npm run changeset          # describe the change, pick the bump for each package
npm run version-packages   # apply the pending changesets and refresh the lockfile
```

`version-packages` rewrites the affected `package.json` versions, folds the
pending changeset files into each package's `CHANGELOG.md`, and deletes them.
The publish workflow reads the resulting versions.

## Why changesets rather than one tag for the whole repository

The platform migration design proposes a single semver tag covering every
package, so a release bumps all of them together whether or not they changed.
That is the simpler policy and the design doc is explicit that independent
versioning through changesets is the alternative once the package count grows
past a handful.

Six packages is past that threshold, and the asymmetry is what decides it.
`@webbpulse/tsconfig` and `@webbpulse/eslint-config` are adopted first and then
change rarely; `@webbpulse/api-client` and `@webbpulse/auth` change through the
whole migration. Under one tag, every api-client patch also republishes
tsconfig, so an application pinning tsconfig sees a stream of versions with
identical contents and no way to tell a real change from a bystander bump.

The cost is that a contributor has to remember the changeset. CI enforces it
rather than relying on memory.
