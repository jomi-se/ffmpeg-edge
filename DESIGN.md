# Design System

## Theme
Light Mode. A bright, airy, clean desk in a well-lit office. The interface should feel open, uncrowded, and immediately legible.

## Color Strategy
Restrained. Tinted neutrals with one primary accent carrying ≤10% of the surface. 
- Use OKLCH for colors.
- Never use pure `#000` or `#fff`. Tint neutrals slightly toward the brand hue (chroma 0.005–0.01).
- The accent color should be used sparingly to guide the user's eye to the primary action (e.g., the "Plan command" or "Run FFmpeg" buttons).

## Typography
System / Sans (e.g., Inter, system-ui). 
- Safe, clean, and highly legible. 
- Cap body line length at 65–75ch for readability.
- Create hierarchy through scale and weight contrast (≥1.25 ratio between steps), avoiding flat scales.
- FFmpeg commands and code snippets should use a distinct monospace font for contrast.

## Motion Energy
Medium / Deliberate. Smooth, deliberate easing that helps guide the eye.
- Do not animate CSS layout properties.
- Use exponential ease-out curves (e.g., ease-out-quart or ease-out-quint). No bouncing or elastic effects.

## Layout & Space
- Vary spacing for rhythm. Avoid monotonous, uniform padding everywhere.
- Use cards sparingly; only when they are the best affordance. Never nest cards.
- Do not wrap everything in a container unless necessary for grouping.

## Components
(To be defined during implementation, but must adhere to the "simple, elegant, powerful" mandate. Avoid bloat, and hide advanced/debug options behind progressive disclosure).

## Anti-Patterns (Banned)
- Side-stripe borders (e.g., `border-left` as an accent on cards).
- Gradient text combined with a gradient background.
- Glassmorphism as a default.
- Identical card grids repeated endlessly.
- Defaulting to modals instead of inline/progressive alternatives.
