'use strict';

// What React Native Testing Library itself requires from react-native: only
// StyleSheet.flatten. The components under test get src/test/react-native.tsx.
function flatten(style) {
  if (style === false || style === null || style === undefined) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return { ...style };
}

module.exports = { StyleSheet: { flatten, create: (styles) => styles } };
