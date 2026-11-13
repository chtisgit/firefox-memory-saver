* Commit messages should seldom be one-liners (only if the changes are also minimal).
  Explain the changes in the commit message, so the reader understands what the commit contains without reading the corresponding code.
  For substantive changes, include a detailed bulleted list of what changed and, when available, the reasoning behind the changes. Use asterisks (`*`) for bullet points, not dashes.

* Write changelog entries for regular users, focusing on noticeable features,
  fixes, and behavior changes. Use plain language and concise asterisk (`*`)
  bullet points. Omit documentation, tests, internal tooling, and other changes
  users would not notice or need to care about. Avoid implementation details;
  keep those in commit messages instead.
* When preparing a release entry, review all commits since the last tagged
  version and summarize the final user-visible behavior, omitting intermediate
  changes that were later removed. Changelog entries must always belong to a
  specific version; never add an Unreleased section or unversioned release notes.

## Release process

1. Review the working tree and identify the latest release tag. Keep unrelated
   changes and untracked files out of release commits.
2. Review all commits since that tag and prepare a new `vX.Y.Z` entry in
   `CHANGELOG.txt`, following the changelog guidance above. Use versioned entries
   only; never create an Unreleased section. Emphasize changes to existing
   behavior that users may need to account for.
3. Update `manifest.json` to version `X.Y.Z`. Commit the manifest version bump
   and changelog together in the same release commit; never tag a release whose
   manifest still declares the previous version. Commit changes to `AGENTS.md`
   separately from the release commit.
4. Run `node tests/run.mjs` and `git diff --check` before committing the release.
   Complete a Firefox smoke test when possible and report any validation that
   could not be completed.
5. Create an annotated tag named `vX.Y.Z` on the release commit. Verify that the
   tag points to the commit containing both the manifest bump and release notes.
6. Run `./build.sh` to rebuild `memory-saver.zip`. Verify archive integrity and
   that the packaged manifest and changelog match the release commit, including
   the new version number. Do not commit the generated ZIP.
7. Report the release commit, tag, build result, and any remaining changes.
   Push commits/tags or publish the release only when requested.
