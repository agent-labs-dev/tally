# Security

tally handles the names, locations and dates of other people's credentials, and promises never to read, store or print
a value. A bug that breaks that promise is a security issue. Relevant reports include:

- A secret value reaching the tally file, an issue, a log line, JSON output or the terminal view.
- A store reader running anything other than its listed metadata commands, or a provider reader calling anything other
  than its documented key listing, including an argument that turns a listing into a write.
- The `pass` reader opening, decrypting or following a symlink out of the password store.
- The credential-shaped text guard letting a real key format through `validate`.
- The action writing to a repository other than its `issueRepo`, or needing a wider token than `issues: write`.

Report a vulnerability through
[GitHub private vulnerability reporting](https://github.com/agent-labs-dev/tally/security/advisories/new), not a
public issue. Include the version, the command or workflow you ran, the steps to reproduce it and what was exposed. You
will get a reply within a week.

The latest release is the only supported version.
