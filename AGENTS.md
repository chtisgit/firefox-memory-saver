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
  changes that were later removed. Carry forward existing Unreleased notes,
  simplifying or consolidating them to follow the user-facing guidance above.
