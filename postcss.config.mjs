import cssVarPrefixer from './postcss/plugins/prefix-css-vars.mjs';

const CSS_VAR_PREFIX = process.env.CSS_VAR_PREFIX || 'app-';
const CSS_VAR_ALLOWLIST = (process.env.CSS_VAR_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);

export default {
  plugins: {
    // Prefix project-owned CSS variables to avoid clashes with Tailwind internal vars across versions
    [cssVarPrefixer({
      prefix: CSS_VAR_PREFIX,
      allowlist: CSS_VAR_ALLOWLIST,
      excludePrefixes: ['tw-'],
    })]: {},
    "@tailwindcss/postcss": {},
  },
};