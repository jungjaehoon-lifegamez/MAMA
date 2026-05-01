# MAMA Landing Page Assets

Visual assets for the MAMA landing page and documentation.

## Product Visuals

| File                              | Description                                     | Source                         |
| --------------------------------- | ----------------------------------------------- | ------------------------------ |
| `mama-icon.svg`                   | MAMA logo used by the site nav, favicon, footer | Project brand asset            |
| `mama-os-hero-evidence-board.png` | Generated demo product screen with fake data    | AI-generated from MAMA UI goal |

## Usage

```html
<img src="assets/mama-os-hero-evidence-board.png" alt="Generated MAMA OS evidence board" />
```

## Guidelines

- **No production screenshots**: GitHub Pages assets must not include live server captures or personal data
- **Demo data only**: Product visuals should use generated or manually sanitized fake records
- **Format**: SVG for brand marks, PNG or WebP for generated product visuals
- **Naming**: lowercase with hyphens (e.g., `feature-demo.png`)
- **No personal data**: Remove any personal decision content before adding

## Adding New Assets

1. Generate or sanitize the visual before adding it to this folder
2. Use descriptive filenames
3. Update this README with new entries
4. Verify with: `ls -lh docs/website/assets/`
