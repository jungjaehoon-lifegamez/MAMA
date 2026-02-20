# MAMA Landing Page Assets

Visual assets for the MAMA landing page and documentation.

## Screenshots

| File                             | Description                  | Size  | Source                                                      |
| -------------------------------- | ---------------------------- | ----- | ----------------------------------------------------------- |
| `mobile-chat.png`                | Mobile chat interface demo   | 165KB | docs/images/1.5-chat.png                                    |
| `graph-viewer.png`               | Decision graph visualization | 216KB | docs/images/reasoning-graph1.4.5.png                        |
| `screenshot-skill-lab.png`       | Skill Lab Playground UI      | 141KB | ~/.mama/workspace/media/outbound/mama_skill_lab.png         |
| `screenshot-cron-workflow.png`   | Cron Workflow Lab DAG editor | 137KB | ~/.mama/workspace/media/outbound/mama_cron_workflow_lab.png |
| `screenshot-wave-visualizer.png` | Wave Visualizer Live mode    | 133KB | ~/.mama/workspace/media/outbound/mama_wave_visualizer.png   |

## Usage

```html
<img src="assets/mobile-chat.png" alt="MAMA Mobile Chat" />
<img src="assets/graph-viewer.png" alt="Decision Graph Viewer" />
```

## Guidelines

- **Max file size**: 500KB per image
- **Format**: PNG for screenshots, GIF for animations
- **Naming**: lowercase with hyphens (e.g., `feature-demo.png`)
- **No personal data**: Remove any personal decision content before adding

## Adding New Assets

1. Optimize images before adding (target < 500KB)
2. Use descriptive filenames
3. Update this README with new entries
4. Verify with: `ls -lh docs/website/assets/`
