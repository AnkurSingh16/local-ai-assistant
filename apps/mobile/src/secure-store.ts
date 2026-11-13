import * as SecureStore from 'expo-secure-store';

import type { TokenStore } from './session';

const key = 'lai_session';

/** The session token in the device's secure storage, never in plain AsyncStorage. */
export const secureTokenStore: TokenStore = {
  async get() {
    return (await SecureStore.getItemAsync(key)) ?? undefined;
  },
  set: (token) => SecureStore.setItemAsync(key, token),
  clear: () => SecureStore.deleteItemAsync(key),
};
