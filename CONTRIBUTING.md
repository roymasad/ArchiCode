# Contributing to ArchiCode

Thank you for considering a contribution. ArchiCode welcomes focused bug fixes,
tests, documentation improvements, and features that fit its local-first,
visual-first direction.

## Contributor License Agreement

A Contributor License Agreement (CLA) is required before an external
Contribution can be merged.

- If you own the Contribution personally, accept
  [CLA-INDIVIDUAL.md](CLA-INDIVIDUAL.md) through the project's designated CLA
  signing service.
- If an employer or another organization owns or controls the Contribution, an
  authorized representative must also execute
  [CLA-CORPORATE.md](CLA-CORPORATE.md), and you must still accept the individual
  CLA.
- If you are unsure who owns work produced during your employment, check your
  employment agreement and ask your employer before submitting it.

The automated CLA status check, once enabled, will provide signing instructions
on pull requests and must pass before merge. If the check is unavailable, do
not treat a pull-request checkbox or a Git commit as CLA acceptance; contact the
maintainer for the designated signing process.

Contributors retain ownership of their Contributions. The CLA grants Roy
Massaad, as Project Steward, the rights needed to distribute accepted
Contributions in both the public AGPL edition and separately licensed
commercial editions. See [LICENSING.md](LICENSING.md) for the dual-licensing
model.

## Before opening a pull request

1. Discuss substantial features or architectural changes in an issue before
   investing in implementation.
2. Keep the change focused and readable.
3. Add or update tests for changed behavior.
4. Run the relevant verification commands:

   ```bash
   npm run typecheck
   npm test
   npm run build
   ```

5. Update `README.md` and `TECHSPEC.md` when public behavior, storage contracts,
   architecture, or runtime behavior changes.

## Contribution requirements

- Do not commit credentials, provider keys, personal data, or local
  `.archicode` runtime output.
- Do not commit build output, generated release artifacts, or downloaded models
  unless the change explicitly requires and documents them.
- Keep provider-specific behavior behind adapters.
- Keep authoritative filesystem, shell, network, and permission checks in the
  main process; renderer input is untrusted.
- Identify all third-party code, assets, generated material, and applicable
  licenses in the pull request. Do not submit material you do not have the
  right to contribute.
- Disclose material use of code-generation tools and confirm that you reviewed
  the resulting Contribution for correctness, provenance, and licensing.

## Pull-request review

Pull requests are reviewed for product fit, correctness, security, tests,
documentation, provenance, and CLA status. Acceptance is at the Project
Steward's discretion. A signed CLA does not guarantee that a Contribution will
be accepted.

