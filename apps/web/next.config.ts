import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages ship raw TypeScript; Next has to compile them itself.
  transpilePackages: ['@fishnu/shared'],
  reactStrictMode: true,
};

export default config;
