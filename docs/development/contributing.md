# Contributing to MAMA

Thank you for your interest in contributing to MAMA (Memory-Augmented MCP Assistant)!

---

## Quick Links

- **Developer Setup:** [Developer Playbook](developer-playbook.md)
- **Code Standards:** [Code Standards](code-standards.md)
- **Testing Guide:** [Testing Guide](testing.md)
- **Architecture:** [Architecture Document](../explanation/architecture.md)

---

## Getting Started

### 1. Set Up Development Environment

```bash
# Clone repository
git clone https://github.com/jungjaehoon-ui/MAMA.git
cd MAMA

# Install dependencies
npm install

# Run tests
npm test
```

### 2. Read Documentation

- [Developer Playbook](developer-playbook.md) - Architecture and development setup
- [Code Standards](code-standards.md) - Coding conventions
- [Testing Guide](testing.md) - Test suite overview

---

## How to Contribute

### 1. Report Issues

- **Bug reports:** Use issue template, include reproduction steps
- **Feature requests:** Describe use case and expected behavior
- **Documentation:** Flag unclear or outdated docs

### 2. Submit Pull Requests

**Before submitting:**

- Read [Code Standards](code-standards.md)
- Write tests for new features
- Update documentation
- Run `npm test` (all tests must pass)

**PR checklist:**

- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] All tests pass
- [ ] Code follows standards
- [ ] No `console.log` (use DebugLogger)

---

## Code Review Process

1. **Automated checks:** Tests, linting, coverage
2. **Maintainer review:** Architecture, code quality
3. **Feedback:** Address review comments
4. **Merge:** After approval

**Average review time:** 2-3 business days

---

## Development Workflow

### Create Feature Branch

```bash
git checkout -b feature/your-feature-name
```

### Make Changes

```bash
# Edit files
vim src/core/new-feature.js

# Run tests frequently
npm test

# Check lint
npm run lint
```

### Commit Changes

```bash
git add .
git commit -m "feat: Add new feature description"
```

**Commit message format:**

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `test:` Tests
- `refactor:` Code refactoring

### Submit PR

```bash
git push origin feature/your-feature-name
# Open PR on GitHub
```

---

## Testing Requirements

- **Unit tests:** Required for all new functions
- **Integration tests:** Required for commands/hooks
- **Regression tests:** Required for bug fixes
- **Coverage:** Maintain >80% coverage

**See:** [Testing Guide](testing.md)

---

## Documentation Requirements

**Update documentation when:**

- Adding new commands
- Changing configuration options
- Modifying architecture
- Adding FR (Functional Requirements)

**Files to update:**

- User-facing docs (tutorials/, guides/)
- Reference docs (reference/)
- FR mapping (reference/fr-mapping.md)

---

## Code Standards

- **No `any` type:** All TypeScript must be properly typed
- **No `console.log`:** Use DebugLogger
- **File length:** <1000 lines
- **Function length:** <40 lines
- **Test coverage:** >80%

**See:** [Code Standards](code-standards.md)

---

## Communication

- **Issues:** For bug reports and feature requests
- **Discussions:** For questions and ideas
- **Pull Requests:** For code contributions

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

## Recognition

Contributors are recognized in:

- README.md (Contributors section)
- Release notes
- GitHub contributor graph

---

## Questions?

- **Technical questions:** Open a discussion
- **Security issues:** Email security@jungjaehoon-ui.com (private)
- **Other:** Open an issue

---

## See Also

- [Developer Playbook](developer-playbook.md) - Development setup
- [Code Standards](code-standards.md) - Coding conventions
- [Testing Guide](testing.md) - Test suite
- [Architecture](../explanation/architecture.md) - System design
