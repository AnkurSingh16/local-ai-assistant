'use strict';

const path = require('node:path');

const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// The shared packages live in the npm workspace and are read as TypeScript
// source through the @local-ai/source export condition, so nothing is built
// first, as in the web app and the tests.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ['@local-ai/source', 'react-native', 'import', 'require'];

// Workspace sources import siblings as './x.js' (Node ESM style) while the
// file on disk is x.ts; try the TypeScript file first for those imports.
const resolveDefault = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = resolveDefault ?? context.resolveRequest;
  const fromWorkspace = context.originModulePath.startsWith(path.join(workspaceRoot, 'packages'));
  if (fromWorkspace && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, moduleName.replace(/\.js$/, '.ts'), platform);
    } catch {
      // Not a TypeScript file; resolve the request as written.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
