# Releases

This directory holds the minimal release metadata required to close the L0 release bar.

## Files

- `compatibility-matrix.md`: release-to-image compatibility table
- `release-notes-template.md`: template for each tagged release note
- `vX.Y.Z.md`: one release note file per tagged repository version

## Policy

- every release tag must have a matching release note file in this directory
- every release tag must appear in `compatibility-matrix.md`
- for L0, compatibility is tracked at the repository release level rather than mixed-version matrices
