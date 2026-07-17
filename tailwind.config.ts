import type { Config } from 'tailwindcss';
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { colors: { canvas: 'var(--color-bg-base)', surface: 'var(--color-surface-card)', lime: 'var(--color-accent-lime)', muted: 'var(--color-text-muted)', danger: 'var(--color-danger)' }, borderRadius: { card: 'var(--radius-card)', pill: 'var(--radius-pill)' }, backgroundImage: { 'lime-soft': 'var(--gradient-accent-lime-soft)' } } },
  plugins: [],
} satisfies Config;
