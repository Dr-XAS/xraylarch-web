# Dr.XAS logos

Original PNG exports copied from `Dr_XAS/00_project_materials/UI_design_docs` on 2026-09-19. The artwork, transparency, and resolution are unchanged.

| Asset | Source within UI_design_docs | Dimensions |
| --- | --- | --- |
| `drxas-mark-light.png` | `Graphics/600ppi/drxas_logo.png` | 1623 × 1491 |
| `drxas-mark-dark.png` | `dark_mode_logo/600ppi/DrXAS_logo_small_darkbare.png` | 1623 × 1491 |
| `drxas-wordmark-light.png` | `1000ppi/Asset 10bare.png` | 4260 × 1404 |
| `drxas-wordmark-dark.png` | `dark_mode_logo/600ppi/DrXAS_logo_darkbare.png` | 2547 × 843 |

The workbench header uses the compact marks through `DrXasLogo`, which follows the app's `data-theme` setting. The full wordmarks are available for reuse. Public asset URLs go through `appUrl` so the logos also load when the app is mounted under `/advanced-xas/app`; Next.js serves optimized sizes for the header.
