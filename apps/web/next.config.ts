import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages ship raw TypeScript; Next has to compile them itself.
  transpilePackages: ['@fishnu/shared', '@fishnu/persona'],
  reactStrictMode: true,

  webpack: (cfg) => {
    // Those packages are ESM and import each other with explicit `.js` specifiers, which
    // is correct for Node but resolves to nothing here because the files on disk are
    // `.ts`. Type-only imports hid this until the first value import (the commandments).
    cfg.resolve.extensionAlias = {
      ...cfg.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return cfg;
  },
};

export default config;
