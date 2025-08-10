// PostCSS plugin to add a configurable prefix to custom properties (CSS variables)
// Usage:
//   prefixCssVars({ prefix: 'app-', allowlist: ['--font-geist-sans'], excludePrefixes: ['tw-'] })
// Behavior:
//   - Only prefixes variables that do NOT already start with the prefix
//   - Skips variables that start with any of excludePrefixes
//   - Respects allowlist: if provided, only listed variables are prefixed

import postcss from 'postcss';

/**
 * @param {{ prefix: string; allowlist?: string[]; excludePrefixes?: string[] }} options
 */
export default function prefixCssVars(options = { prefix: 'app-' }) {
  const prefix = typeof options.prefix === 'string' ? options.prefix : 'app-';
  const allowlist = Array.isArray(options.allowlist) ? options.allowlist : null;
  const excludePrefixes = Array.isArray(options.excludePrefixes) ? options.excludePrefixes : [];

  /**
   * Decide whether a var name should be prefixed
   * @param {string} name like --color or --tw-ring-color
   */
  function shouldPrefix(name) {
    if (!name.startsWith('--')) return false;
    if (name.startsWith(`--${prefix}`)) return false;
    if (excludePrefixes.some(p => name.startsWith(`--${p}`))) return false;
    if (allowlist && !allowlist.includes(name)) return false;
    return true;
  }

  return {
    postcssPlugin: 'prefix-css-vars',
    Declaration(decl) {
      // Rewrite definitions: --foo: value
      if (decl.variable && shouldPrefix(decl.prop)) {
        decl.prop = `--${prefix}${decl.prop.replace(/^--/, '')}`;
      }

      // Rewrite var() usages within values: var(--foo) => var(--app-foo)
      if (decl.value && decl.value.includes('var(')) {
        decl.value = decl.value.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g, (m, varname) => {
          return shouldPrefix(varname) ? `var(--${prefix}${varname.replace(/^--/, '')})` : `var(${varname})`;
        });
      }
    },
  };
}

prefixCssVars.postcss = true;


