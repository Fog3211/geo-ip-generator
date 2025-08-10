import cssVarPrefixer from './postcss/plugins/prefix-css-vars.mjs';
import tailwindcss from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';

const CSS_VAR_PREFIX = process.env.CSS_VAR_PREFIX || 'app-';
const CSS_VAR_ALLOWLIST = (process.env.CSS_VAR_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export default {
  // Use array/tuple form: [pluginFn, options]
  plugins: [
    [
      cssVarPrefixer,
      {
        prefix: CSS_VAR_PREFIX,
        allowlist: CSS_VAR_ALLOWLIST,
        excludePrefixes: ['tw-'],
      },
    ],
    tailwindcss(),
    autoprefixer(),
  ],
};