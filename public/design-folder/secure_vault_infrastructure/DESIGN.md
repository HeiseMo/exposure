---
name: Secure Vault Infrastructure
colors:
  surface: '#121416'
  surface-dim: '#121416'
  surface-bright: '#38393c'
  surface-container-lowest: '#0c0e10'
  surface-container-low: '#1a1c1e'
  surface-container: '#1e2022'
  surface-container-high: '#282a2c'
  surface-container-highest: '#333537'
  on-surface: '#e2e2e5'
  on-surface-variant: '#b9cbbd'
  inverse-surface: '#e2e2e5'
  inverse-on-surface: '#2f3133'
  outline: '#849588'
  outline-variant: '#3a4a3f'
  surface-tint: '#00e290'
  primary: '#f5fff5'
  on-primary: '#003920'
  primary-container: '#00ffa3'
  on-primary-container: '#007146'
  inverse-primary: '#006d43'
  secondary: '#c6c6c9'
  on-secondary: '#2f3133'
  secondary-container: '#454749'
  on-secondary-container: '#b4b5b7'
  tertiary: '#fdfcff'
  on-tertiary: '#213145'
  tertiary-container: '#d0e1fb'
  on-tertiary-container: '#54647a'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#52ffac'
  primary-fixed-dim: '#00e290'
  on-primary-fixed: '#002111'
  on-primary-fixed-variant: '#005231'
  secondary-fixed: '#e2e2e5'
  secondary-fixed-dim: '#c6c6c9'
  on-secondary-fixed: '#1a1c1e'
  on-secondary-fixed-variant: '#454749'
  tertiary-fixed: '#d3e4fe'
  tertiary-fixed-dim: '#b7c8e1'
  on-tertiary-fixed: '#0b1c30'
  on-tertiary-fixed-variant: '#38485d'
  background: '#121416'
  on-background: '#e2e2e5'
  surface-variant: '#333537'
typography:
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.5'
  label-caps:
    fontFamily: Space Grotesk
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1.0'
    letterSpacing: 0.1em
  data-mono:
    fontFamily: Space Grotesk
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.0'
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 16px
  margin-mobile: 20px
  margin-desktop: 40px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 32px
---

## Brand & Style

This design system is engineered to evoke an atmosphere of absolute privacy and high-fidelity technical precision. The brand personality is "The Silent Guardian"—sophisticated, impenetrable, and utilitarian. It targets high-net-worth individuals and privacy-conscious investors who demand clarity without the noise of traditional retail finance.

The visual style follows a **Modern-Minimalist** approach with **Technical** accents. It prioritizes the "data as hero" philosophy, using ample negative space to frame financial activity. Visual metaphors for encryption and security are woven into the interface through subtle monospaced elements and rigorous grid alignment, ensuring the user feels in total control of their sensitive information.

## Colors

The palette is anchored in a deep, "obsidian" dark mode to minimize eye strain and maximize the impact of data visualizations. 

- **Primary:** A high-visibility "Terminal Green" (#00FFA3) used exclusively for success states, growth indicators, and primary calls to action.
- **Surface:** A tiered system of neutrals starting from a true-black base (#0F1113) up to refined charcoals (#1A1C1E) for card backgrounds.
- **Accents:** A muted slate (#64748B) is utilized for secondary information and metadata to maintain a clear visual hierarchy.
- **Security States:** Encrypted data should be represented with a low-opacity "Frost" effect or a specialized "Locked" grey to signify background protection.

## Typography

Typography in this design system is split between two functional roles: **Inter** handles high-readability body text and long-form activity logs, while **Space Grotesk** provides a technical, geometric edge for headlines, tickers, and financial values.

- **Financial Data:** All percentages and currency tickers use Space Grotesk to lean into the "scientific" aesthetic.
- **Encrypted States:** Use a specialized letter-spacing or character-masked style for data that is currently hidden behind biometric or password locks.
- **Contrast:** Maintain a high contrast ratio between the obsidian background and "Paper White" (#F8FAFC) text for critical values.

## Layout & Spacing

This design system utilizes a **Fluid Grid** model optimized for the PWA experience. It adheres to a strict 4px baseline grid to ensure vertical rhythm in dense data tables.

- **Mobile-First:** A single-column stack is the primary layout, with margins of 20px to prevent thumb-overlap.
- **Safe Areas:** Generous padding is applied at the bottom of the viewport to accommodate PWA navigation bars and OS-level gesture indicators.
- **Rhythm:** Use "Stack" variables for vertical spacing between data points. Sm (8px) for related metadata, Md (16px) for distinct list items, and Lg (32px) for major section breaks.

## Elevation & Depth

To maintain a "technical vault" feel, the design system avoids heavy shadows in favor of **Tonal Layers** and **Low-Contrast Outlines**.

- **Surface Levels:** The background is the lowest level (Level 0). Cards and containers exist on Level 1, using a slightly lighter hex code (#1A1C1E) and a 1px solid border (#2D3135).
- **Active States:** Instead of elevation through shadows, active or pressed states are indicated by a change in border color to the Primary Green or an increase in border weight.
- **Glassmorphism:** Use a subtle backdrop blur (12px) for top navigation bars and bottom sheets to give a sense of depth without compromising the clean, professional aesthetic.

## Shapes

The shape language is "Soft-Technical." By using a **Soft (0.25rem)** base roundedness, the system avoids the harshness of sharp corners while remaining far more professional than pill-shaped consumer apps.

- **Buttons:** 4px radius for a rugged, tool-like feel.
- **Cards:** 8px (rounded-lg) to provide enough distinction from the screen edge.
- **Inputs:** 4px radius to match buttons, creating a cohesive form-factor for security inputs.

## Components

### Buttons
Primary buttons use the Primary Green background with black text for maximum contrast. Secondary buttons are outlined in slate. All buttons feature a subtle monospaced label (Space Grotesk) to emphasize the technical nature of the activity.

### Chips & Tags
Used for asset types (e.g., "Equity", "Crypto"). These are small, low-profile elements with a 1px border and no background fill, keeping the interface clean.

### Financial Activity Lists
List items feature a three-column layout:
1. **Icon/Ticker:** Monospaced ticker name.
2. **Activity Graph:** A simplified sparkline in Primary Green (positive) or a neutral grey (stale).
3. **Value:** High-contrast price and percentage.

### Encrypted Input Fields
Inputs for sensitive keys or passwords should include a "Mask Toggle" icon. The field itself uses a monospaced font for character clarity.

### Security Status Bar
A persistent, slim bar at the top of the viewport indicating the current encryption status (e.g., "AES-256 Active") in a tiny, capitalized label-caps style.

### Empty & Locked States
When data is hidden, use a geometric pattern overlay (subtle dots or diagonal lines) within the card to signal that the data is encrypted, not missing.