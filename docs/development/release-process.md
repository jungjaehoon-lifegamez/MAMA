# Release Process

**Status:** Document in progress

This document will describe the release process for MAMA plugin, including versioning, changelogs, and deployment procedures.

---

## Planned Contents

- Semantic versioning strategy
- Release checklist
- Changelog generation
- npm publishing process
- GitHub release creation
- Version tagging conventions

---

## Temporary Reference

For now, releases follow standard npm publishing workflow:

```bash
# 1. Update version
npm version [major|minor|patch]

# 2. Run tests
npm test

# 3. Build
npm run build

# 4. Publish
npm publish
```

**See also:**
- [Contributing Guide](contributing.md)
- [Testing Guide](testing.md)

---

**Last Updated:** 2025-11-21
